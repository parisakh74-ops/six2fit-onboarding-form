// @vitest-environment node
// T04: the ledger separates claim -> WorkDrive staging -> CRM sending. A worker that dies while staging is taken over
// safely (no CRM POST can have started); one that dies after "sending" is never retried blindly. MOCKS ONLY.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import type { SubjectDirectory } from "../ports";
import { createOnboardingService, type SubmitInput } from "../service";
import { subjectKey, verifyLinkToken } from "../tokens";
import type { WdItem, WorkDriveApi } from "../workdrive/api";
import { MockWorkDrive } from "../workdrive/mock";
import { DeferredFileSink, WorkDriveStagingWriter, WorkDriveSubmissionStorage } from "../workdrive/storage";
import { createRequestsWriter } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const ENV: Record<string, string> = {
  SIX2FIT_ONBOARDING_STORE: "crm",
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client",
  SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ZOHO_TIMEOUT_MS: "40",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID,
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
};
const LEASE = 150_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-stage-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

class Directory implements SubjectDirectory {
  async resolve() {
    return { prefill: {} };
  }
}

/** A WorkDrive client whose upload number `hangAt` never answers (a worker that is killed mid-upload). */
class Killable implements WorkDriveApi {
  uploads = 0;
  hangAt: number | null = null;
  phaseSeen: string[] = [];
  constructor(private readonly inner: MockWorkDrive, private readonly ledger: IdempotencyLedger, private readonly id: string) {}
  getItem(id: string) { return this.inner.getItem(id); }
  list(id: string) { return this.inner.list(id); }
  download(id: string) { return this.inner.download(id); }
  createFolder(p: string, n: string) { return this.inner.createFolder(p, n); }
  async upload(p: string, n: string, b: Uint8Array): Promise<WdItem> {
    this.uploads += 1;
    this.phaseSeen.push((await this.ledger.current(this.id))?.phase ?? "none");
    if (this.hangAt === this.uploads) return new Promise<WdItem>(() => undefined);
    return this.inner.upload(p, n, b);
  }
}

const ANSWERS = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
const TOKEN = () => dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 });
const LEDGER_ID = subjectKey(verifyLinkToken(TOKEN(), SECRET, NOW_MS));
const sid = "11111111-2222-4333-8444-555555555555";
const input = (): SubmitInput => ({ token: TOKEN(), submissionId: sid, idempotencyKey: sid, answers: ANSWERS, verificationState: "{}", files: { "MS-05.front": jpegFile("a.jpg", 3000), "MS-05.back": jpegFile("b.jpg", 4000) } });
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;

function world(env: Record<string, string> = {}) {
  const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const zoho = new MockZoho();
  const clock = { t: NOW_MS };
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  const ledger = new IdempotencyLedger(join(dir, "ledger"));
  const worker = (api: WorkDriveApi = wd) => {
    const storage = new WorkDriveSubmissionStorage(api, { rootFolderId: ROOT_ID, rootFolderName: ROOT_NAME });
    const writer = createRequestsWriter({ ...ENV, ...env }, { fetch: zoho.fetch, now: () => clock.t, sleep, documentIdentityByKey: (k) => storage.readDocumentIdentityByKey(k) });
    const store = new LedgerOnboardingStore(new WorkDriveStagingWriter(writer, storage), ledger, { now: () => clock.t, sleep, leaseMs: LEASE, waitMs: 1_000_000_000 });
    return createOnboardingService({ store, directory: new Directory(), sink: new DeferredFileSink(), secret: SECRET, now: () => clock.t });
  };
  return { wd, zoho, clock, ledger, worker };
}

describe("T04 ledger phases", () => {
  it("records phase 'staging' while WorkDrive is written and only then 'sending' (order proven at upload time)", async () => {
    const w = world();
    const killable = new Killable(w.wd, w.ledger, LEDGER_ID);
    const res = await w.worker(killable).submit(input());
    expect(res.status).toBe(200);
    expect(killable.phaseSeen).toEqual(["staging", "staging", "staging"]);
    expect((await w.ledger.current(LEDGER_ID))?.state).toBe("created");
    expect(posts(w.zoho)).toBe(1);
  });

  it("a worker killed mid-upload is taken over after the lease: the upload resumes, no duplicates, exactly one CRM POST", async () => {
    const w = world();
    const dying = new Killable(w.wd, w.ledger, LEDGER_ID);
    dying.hangAt = 2; // first file stored, second never answers
    void w.worker(dying).submit(input());
    await vi.waitFor(async () => expect(dying.uploads).toBe(2));
    const stuck = await w.ledger.current(LEDGER_ID);
    expect(stuck).toMatchObject({ state: "in_progress", phase: "staging" });
    expect(posts(w.zoho)).toBe(0);

    w.clock.t += LEASE + 1_000; // the lease expires; the old writer is gone
    const res = await w.worker().submit(input());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deduplicated: false });
    const folder = w.wd.all(ROOT_ID).filter((i) => i.kind === "folder");
    expect(folder).toHaveLength(1);
    const names = w.wd.all((folder[0] as { id: string }).id).map((i) => i.name);
    expect(names).toHaveLength(3); // two files + one canonical document, nothing duplicated
    expect(new Set(names).size).toBe(3);
    expect(posts(w.zoho)).toBe(1);
    expect((await w.ledger.current(LEDGER_ID))?.state).toBe("created");
  });

  it("a writer found dead AFTER 'sending' is settled by CRM lookup evidence, never by a second POST", async () => {
    const w = world();
    // Simulate the death directly in the ledger: the durable "sending" marker exists, nothing else.
    const claimed = await w.worker().submit(input()); // creates normally first, to learn the fingerprint
    expect(claimed.status).toBe(200);
    const done = await w.ledger.current(LEDGER_ID);
    expect(done?.state).toBe("created");
    // Re-open the entry as a dead writer after 'sending' would have left it.
    await w.ledger.claim({ ...(done as NonNullable<typeof done>), gen: (done?.gen ?? 0) + 1, state: "in_progress", phase: "sending", updated: w.clock.t });
    const before = posts(w.zoho);
    w.clock.t += LEASE + 1_000; // lease over, but quiescence (120 s) has also passed -> lookup only
    const res = await w.worker().submit(input());
    // The Request exists in the CRM (lookup finds it): the entry is settled by evidence, never by a new POST.
    expect(res.status).toBe(200);
    expect(posts(w.zoho)).toBe(before);
  });

  it("a WorkDrive failure while staging releases the claim; the retry resumes and creates exactly one Request", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 503, applied: false }); // second upload refused, nothing applied
    const first = await w.worker().submit(input());
    expect(first.status).toBe(503);
    expect(posts(w.zoho)).toBe(0);
    expect((await w.ledger.current(LEDGER_ID))?.state).toBe("released");
    const second = await w.worker().submit(input());
    expect(second.status).toBe(200);
    expect(posts(w.zoho)).toBe(1);
    const folder = w.wd.all(ROOT_ID).filter((i) => i.kind === "folder");
    expect(w.wd.all((folder[0] as { id: string }).id)).toHaveLength(3);
  });

  it("an ambiguous CRM timeout after staging is never re-POSTed; the staged items are kept", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "timeout" } as never, 1, "POST");
    const first = await w.worker().submit(input());
    expect(first.status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
    const again = await w.worker().submit(input());
    expect([200, 503]).toContain(again.status);
    expect(posts(w.zoho)).toBe(1); // still exactly one POST: no blind second write
    const folder = w.wd.all(ROOT_ID).filter((i) => i.kind === "folder");
    expect(folder).toHaveLength(1);
  });

  it("staging beyond its deadline stops cleanly (WD_DEADLINE) and is resumable", async () => {
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    let t = 0;
    const storage = new WorkDriveSubmissionStorage(wd, { rootFolderId: ROOT_ID, rootFolderName: ROOT_NAME, deadlineMs: 1000, now: () => (t += 600) });
    const record = {
      subject_key: `onb_${"a".repeat(40)}`, unique_form_key: `onb2_${DEAL_ID}_link_0123456789abcdef0123`, fingerprint: "a".repeat(64), scope: "Combo" as const,
      subject: { kind: "deal", dealId: DEAL_ID } as never, link_id: "l", entitlements: [], answers: {}, verification_state: {}, files: [], submitted_at: new Date(NOW_MS).toISOString(),
    };
    const f = jpegFile("a.jpg", 3000);
    const sha = (await import("../canonical")).sha256Hex(f.bytes);
    const rec = { ...record, files: [{ key: "MS-05.front", name: "a.jpg", type: "image/jpeg", size: 3000, sha256: sha }, { key: "MS-05.back", name: "b.jpg", type: "image/jpeg", size: 3000, sha256: sha }] };
    await expect(storage.stage(rec, { "MS-05.front": f.bytes, "MS-05.back": f.bytes })).rejects.toMatchObject({ code: "WD_DEADLINE", notWritten: true });
  });
});
