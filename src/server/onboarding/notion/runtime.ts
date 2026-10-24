import { join } from "node:path";
import type { SubmissionExtras, SubmissionRecord } from "../ports";
import type { AnswerValue } from "../validate";
import type { WorkDriveSubmissionStorage } from "../workdrive/storage";
import type { NotionApi } from "./api";
import { loadNotionConfig, type NotionConfig } from "./config";
import { HttpNotionApi } from "./http-api";
import { NotionSyncLedger } from "./ledger";
import type { NotionSubmission } from "./mapping";
import { NotionSync, type FileSource, type SyncOutcome } from "./sync";

type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

export type NotionRuntime = {
  config: NotionConfig;
  ledger: NotionSyncLedger;
  /**
   * Called (and AWAITED) by the request after CRM + WorkDrive persistence and before the HTTP success is returned:
   *  1. durably records the pending sync in the ledger (throws if that fails, so no success is reported without it);
   *  2. makes ONE bounded inline attempt (`inlineBudgetMs`), never failing the request. Whatever is left is finished by `reconcile`.
   * Safe for replays: an existing entry is never touched and a complete one makes no Notion call.
   */
  registerAndSync(record: SubmissionRecord, extras: SubmissionExtras | undefined, persistedAt?: string): Promise<void>;
  /** Reconciliation: every due (pending/partial) ledger entry is rebuilt from WorkDrive and continued. */
  reconcile(limit?: number): Promise<Array<{ outcome: SyncOutcome }>>;
};

export type NotionOverrides = { api?: NotionApi; /** Read-only Product.Fitness lookup for a Deal. */ resolveFitness?: (dealId: string) => Promise<string | null>; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: Log };

const memorySource = (bytes: Record<string, Uint8Array>): FileSource => ({
  fileBytes: async (key) => {
    const b = bytes[key];
    if (!b) throw new Error("NOTION_FILE_BYTES_MISSING");
    return b;
  },
});

export function toNotionSubmission(record: SubmissionRecord, persistedAt?: string): NotionSubmission {
  return {
    uniqueFormKey: record.unique_form_key,
    scope: record.scope,
    entitlements: record.entitlements,
    answers: record.answers,
    submittedAt: persistedAt ?? record.submitted_at,
    ...(record.subject.kind === "deal" ? { dealId: record.subject.dealId } : {}),
    files: record.files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: f.sha256 })),
  };
}

/** Composition root of the Notion side: config -> HTTP client (or an injected one) -> ledger -> sync. Throws `NOT_CONFIGURED` early. */
export function createNotionRuntime(env: Record<string, string | undefined>, storageDir: string, workdrive: WorkDriveSubmissionStorage | undefined, o: NotionOverrides = {}): NotionRuntime {
  const config = loadNotionConfig(env);
  const now = o.now ?? (() => Date.now());
  const api =
    o.api ??
    new HttpNotionApi({
      fetch: o.fetch ?? (globalThis.fetch as typeof fetch),
      token: config.token,
      baseUrl: config.baseUrl,
      version: config.version,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      minIntervalMs: config.minIntervalMs,
      now,
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  const ledger = new NotionSyncLedger(join(storageDir, "notion-ledger"), config.leaseMs, now);
  const sync = new NotionSync(api, ledger, {
    databaseId: config.databaseId,
    ...(o.resolveFitness ? { resolveFitness: o.resolveFitness } : {}),
    uploadMaxAgeMs: config.uploadMaxAgeMs,
    now,
    ...(o.log ? { log: o.log } : {}),
  });
  return {
    config,
    ledger,
    async registerAndSync(record, extras, persistedAt) {
      await ledger.register(record.unique_form_key, record.fingerprint); // durable BEFORE the success response; a failure propagates
      if (config.inlineBudgetMs <= 0) return;
      const sub = toNotionSubmission(record, persistedAt);
      const attempt = (async () => {
        // Private staff link to the submission folder (best effort: a WorkDrive read failure never blocks the Notion sync).
        const folder = workdrive ? await workdrive.readDocumentIdentityByKey(record.unique_form_key).catch(() => null) : null;
        await sync.sync(folder ? { ...sub, workdriveLink: `https://workdrive.zoho.com/folder/${folder.folderId}` } : sub, record.fingerprint, memorySource(extras?.fileBytes ?? {}));
      })().catch(() => o.log?.("notion.inline_attempt_failed"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([attempt, new Promise<void>((r) => { timer = setTimeout(r, config.inlineBudgetMs); })]);
      if (timer) clearTimeout(timer);
    },
    async reconcile(limit = 20) {
      if (!workdrive) return [];
      const out: Array<{ outcome: SyncOutcome }> = [];
      for (const key of await ledger.due(limit)) {
        try {
          const staged = await workdrive.readStagedSubmission(key);
          const s = staged.submission;
          const files = s.files.map((f) => ({ ...f }));
          const sub: NotionSubmission = {
            uniqueFormKey: key,
            scope: s.scope,
            entitlements: s.entitlements,
            answers: s.answers as unknown as Record<string, AnswerValue>,
            submittedAt: s.submitted_at,
            files: files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: f.sha256 })),
            workdriveLink: `https://workdrive.zoho.com/folder/${staged.folderId}`,
            ...(s.subject.kind === "deal" ? { dealId: s.subject.dealId } : {}),
          };
          const refs = new Map(files.map((f) => [f.key, f.ref ?? ""]));
          out.push({ outcome: await sync.sync(sub, s.fingerprint, { fileBytes: (k) => staged.download(refs.get(k) ?? "") }) });
        } catch {
          o.log?.("notion.reconcile.read_failed");
          out.push({ outcome: { status: "partial", code: "workdrive_unreadable" } });
        }
      }
      return out;
    },
  };
}
