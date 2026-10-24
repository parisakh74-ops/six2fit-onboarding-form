import { sha256Hex } from "../canonical";
import { NotionHttpError, type NotionApi, type NotionPage } from "./api";
import { NotionSyncLedger, type SyncEntry } from "./ledger";
import { NP, SYNC_STATUS, buildNotionPayload, type NotionSubmission } from "./mapping";

type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

/** Where the bytes of a submission's files come from: the request memory (first attempt) or WorkDrive (reconciliation). */
export interface FileSource {
  fileBytes(key: string): Promise<Uint8Array>;
}

export type SyncOptions = {
  databaseId: string;
  /** Reads Product.Fitness for a Deal (read-only). Absent = never resolved (the form type stays empty). Throwing = try again later. */
  resolveFitness?: (dealId: string) => Promise<string | null>;
  uploadMaxAgeMs: number;
  /** After a lost answer to `createPage`, no second page is created before this time has passed (the page may still become visible). */
  createUnconfirmedHoldMs?: number;
  now?: () => number;
  log?: Log;
};

export type SyncOutcome = { status: "complete" | "partial" | "pending" | "blocked" | "busy"; code?: string };

class Defer extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
class Block extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const backoffMs = (attempts: number, retryAfterMs?: number): number => Math.max(retryAfterMs ?? 0, Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000));
const errCode = (e: unknown): string => (e instanceof NotionHttpError ? `http_${e.status}_${e.code}`.slice(0, 80) : e instanceof Defer || e instanceof Block ? e.code : "unexpected");

/**
 * Post-persistence Notion sync of ONE submission, idempotent and resumable.
 *
 * Order (each step is recorded in the ledger before the next one starts):
 *   1. find the page by `S2F Key`; create it only when none exists (>1 page = integrity state `blocked`, never guessed);
 *   2. write the full property set (idempotent replace);
 *   3. per file: create a native Notion file upload, send the bytes, attach it to ITS property, record it as attached;
 *   4. set `S2F Sync Status` = Complete.
 * A crash or failure anywhere leaves a `partial`/`pending` ledger entry; the next run continues from what is recorded and from
 * what Notion shows (a file already attached under its deterministic name is never uploaded again). Uploads older than the
 * configured age (Notion expires unattached uploads after one hour) are replaced.
 * It never touches the CRM or WorkDrive, never logs answers, names or file names.
 */
export class NotionSync {
  private readonly now: () => number;
  private readonly log: Log;

  constructor(
    private readonly api: NotionApi,
    private readonly ledger: NotionSyncLedger,
    private readonly o: SyncOptions,
  ) {
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? (() => undefined);
  }

  async sync(sub: NotionSubmission, fingerprint: string, source: FileSource): Promise<SyncOutcome> {
    const key = sub.uniqueFormKey;
    const locked = await this.ledger.withLock(key, () => this.run(sub, fingerprint, source));
    if (!locked.ran) {
      this.log("notion.sync.busy");
      return { status: "busy" };
    }
    return locked.value;
  }

  private async run(sub: NotionSubmission, fingerprint: string, source: FileSource): Promise<SyncOutcome> {
    const key = sub.uniqueFormKey;
    let e = await this.ledger.read(key);
    if (e && e.fingerprint !== fingerprint) {
      this.log("notion.sync.fingerprint_mismatch");
      return { status: "blocked", code: "fingerprint_mismatch" };
    }
    if (e?.state === "complete") return { status: "complete" };
    if (e?.state === "blocked") return { status: "blocked", ...(e.lastErrorCode ? { code: e.lastErrorCode } : {}) };
    e ??= { v: 1, key, state: "pending", fingerprint, propertiesWritten: false, files: {}, attempts: 0, createdAt: this.now(), updatedAt: this.now() };
    e.attempts += 1;
    const save = async () => this.ledger.write(e as SyncEntry);
    await save();

    try {
      // D1: Product.Fitness is read once, BEFORE the page exists (the form type is part of the first property write).
      if (!e.propertiesWritten && !e.fitnessResolved) {
        e.fitness = sub.productFitness ?? (sub.dealId && this.o.resolveFitness ? await this.o.resolveFitness(sub.dealId).catch((err: unknown) => { throw new Defer((err as { code?: unknown } | null)?.code === "FORBIDDEN" ? "fitness_forbidden" : "fitness_unavailable"); }) : null);
        e.fitnessResolved = true;
        await save();
      }
      const payload = buildNotionPayload({ ...sub, productFitness: e.fitness ?? null });
      const adopted = await this.ensurePage(e, payload.properties, save);
      if (!e.propertiesWritten) {
        await this.api.updatePage(e.pageId as string, payload.properties);
        e.propertiesWritten = true;
        await save();
      }
      if (sub.workdriveLink && !e.linkWritten) {
        await this.api.updatePage(e.pageId as string, { [NP.link]: { url: sub.workdriveLink } });
        e.linkWritten = true;
        await save();
      }
      let snapshot: NotionPage | undefined;
      for (const f of payload.files) {
        let fs = e.files[f.key];
        if (fs && fs.sha256 !== f.sha256) fs = undefined;
        fs ??= (e.files[f.key] = { sha256: f.sha256, attached: false });
        if (fs.attached) continue;
        if (fs.uploadId || adopted) {
          // A previous attempt (or one whose ledger was lost) may have attached the file and died before recording it: Notion is the witness.
          snapshot ??= await this.api.getPage(e.pageId as string);
          if (this.attachedAs(snapshot, f.property, f.filename)) {
            fs.attached = true;
            await save();
            continue;
          }
        }
        let bytes: Uint8Array | undefined;
        const load = async (): Promise<Uint8Array> => {
          bytes ??= await source.fileBytes(f.key);
          if (bytes.length !== f.size || sha256Hex(bytes) !== f.sha256) throw new Block("file_integrity");
          return bytes;
        };
        if (!fs.uploadId || this.now() - (fs.uploadedAt ?? 0) > this.o.uploadMaxAgeMs) {
          const up = await this.api.createFileUpload(f.filename, f.type);
          fs.uploadId = up.id;
          fs.uploadedAt = this.now();
          fs.sent = false;
          await save();
        }
        if (!fs.sent) {
          try {
            await this.api.sendFileUpload(fs.uploadId, f.filename, f.type, await load());
          } catch (err) {
            // A lost answer to `send` may have been applied; a repeated send of an uploaded object is refused (400). Start over
            // with a fresh upload object rather than guessing (the old one simply expires unattached).
            if (err instanceof NotionHttpError && err.status === 400) {
              delete fs.uploadId;
              await save();
              throw new Defer("upload_restart");
            }
            throw err;
          }
          fs.sent = true;
          await save();
        }
        await this.api.updatePage(e.pageId as string, { [f.property]: { files: [{ name: f.filename, type: "file_upload", file_upload: { id: fs.uploadId } }] } });
        fs.attached = true;
        snapshot = undefined;
        await save();
      }
      await this.api.updatePage(e.pageId as string, { [NP.status]: { select: { name: SYNC_STATUS.complete } } });
      e.state = "complete";
      delete e.lastErrorCode;
      delete e.nextAttemptAt;
      await save();
      this.log("notion.sync.complete", { files: payload.files.length, attempts: e.attempts });
      return { status: "complete" };
    } catch (err) {
      const code = errCode(err);
      e.lastErrorCode = code;
      if (err instanceof Block) {
        e.state = "blocked";
        delete e.nextAttemptAt;
      } else {
        e.state = e.pageId ? "partial" : "pending";
        e.nextAttemptAt = this.now() + backoffMs(e.attempts, err instanceof NotionHttpError ? err.retryAfterMs : undefined);
      }
      await save().catch(() => undefined);
      if (e.pageId && e.state !== "blocked") {
        // Best effort: show the partial state in Notion for staff (never throws; the ledger is the source of truth).
        await this.api.updatePage(e.pageId, { [NP.status]: { select: { name: SYNC_STATUS.partial } } }).catch(() => undefined);
      }
      this.log(e.state === "blocked" ? "notion.sync.blocked" : "notion.sync.failed", { code, attempts: e.attempts });
      return { status: e.state as "partial" | "pending" | "blocked", code };
    }
  }

  private async ensurePage(e: SyncEntry,properties: Record<string, unknown>, save: () => Promise<void>): Promise<boolean> {
    if (e.pageId) return false;
    const hold = this.o.createUnconfirmedHoldMs ?? 5 * 60_000;
    const found = async (): Promise<boolean> => {
      const pages = await this.api.queryByKey(this.o.databaseId, e.key);
      if (pages.length > 1) throw new Block("duplicate_pages");
      if (pages.length === 1) {
        e.pageId = (pages[0] as NotionPage).id;
        e.propertiesWritten = false; // the page may come from an interrupted attempt: write every property again
        await save();
        return true;
      }
      return false;
    };
    if (await found()) return true;
    if (e.createAmbiguousAt !== undefined && this.now() - e.createAmbiguousAt < hold) throw new Defer("create_unconfirmed");
    try {
      const page = await this.api.createPage(this.o.databaseId, properties);
      e.pageId = page.id;
      e.propertiesWritten = true;
      delete e.createAmbiguousAt;
      await save();
      return false;
    } catch (err) {
      if (err instanceof NotionHttpError && err.ambiguous) {
        e.createAmbiguousAt = this.now();
        await save();
        if (await found().catch(() => false)) return true;
        throw new Defer("create_unconfirmed");
      }
      throw err;
    }
  }

  private attachedAs(page: NotionPage, property: string, filename: string): boolean {
    const p = page.properties[property] as { files?: Array<{ name?: string }> } | undefined;
    return !!p?.files?.some((f) => f.name === filename);
  }
}
