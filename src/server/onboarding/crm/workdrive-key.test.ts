// @vitest-environment node
// WorkDrive-key persistence (Architecture B): the CRM Request and the canonical WorkDrive submission are linked ONLY by
// `uniqueformkey`. MOCKS ONLY: no network, no CRM, no WorkDrive.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreError } from "../errors";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import type { SubjectDirectory, SubmissionRecord } from "../ports";
import { createOnboardingService, type SubmitInput } from "../service";
import { MockWorkDrive } from "../workdrive/mock";
import { reconcileSubmissions } from "../workdrive/reconcile";
import { DOCUMENT_NAME, DeferredFileSink, WorkDriveStagingWriter, WorkDriveSubmissionStorage } from "../workdrive/storage";
import { loadCrmConfig } from "./config";
import { createRequestsWriter } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";
import { buildRequestsRecord } from "./requests-mapping";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const UKEY = `onb2_${DEAL_ID}_link_0123456789abcdef0123`;

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
  SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "1000000000",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID,
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-wdkey-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

class Directory implements SubjectDirectory {
  async resolve() {
    return { prefill: { "ON-01": "Ali Rezaei" } };
  }
}

const ANSWERS = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
const front = () => jpegFile("front.jpg", 4096);

function world(opts: { zoho?: MockZoho; wd?: MockWorkDrive } = {}) {
  const wd = opts.wd ?? new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const zoho = opts.zoho ?? new MockZoho();
  const clock = { t: NOW_MS };
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  const config = loadCrmConfig(ENV);
  const storage = () => new WorkDriveSubmissionStorage(wd, { rootFolderId: config.workdriveRootFolderId as string, rootFolderName: config.workdriveRootFolderName as string });
  const crmWriter = () => createRequestsWriter(ENV, { fetch: zoho.fetch, now: () => clock.t, sleep, documentIdentityByKey: (k) => storage().readDocumentIdentityByKey(k) });
  const worker = () => {
    const store = new LedgerOnboardingStore(new WorkDriveStagingWriter(crmWriter(), storage()), new IdempotencyLedger(join(dir, "ledger")), { now: () => clock.t, sleep, waitMs: 1_000_000_000 });
    return createOnboardingService({ store, directory: new Directory(), sink: new DeferredFileSink(), secret: SECRET, now: () => clock.t });
  };
  return { wd, zoho, clock, worker, storage, crmWriter, advance: (ms: number) => (clock.t += ms), loseLedger: () => rm(join(dir, "ledger"), { recursive: true, force: true }) };
}
const input = (over: Partial<SubmitInput> = {}): SubmitInput => {
  const id = over.submissionId ?? "11111111-2222-4333-8444-555555555555";
  return { token: dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }), submissionId: id, idempotencyKey: id, answers: ANSWERS, verificationState: "{}", files: { "MS-05.front": front() }, ...over };
};
const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const folderOf = (wd: MockWorkDrive, key = UKEY) => wd.all(wd.rootId).find((i) => i.kind === "folder" && i.name === key);
const docOf = (wd: MockWorkDrive, key = UKEY) => {
  const f = folderOf(wd, key);
  return f ? wd.all(f.id).find((i) => i.name === DOCUMENT_NAME) : undefined;
};
const other = () => input({ submissionId: sid(9), answers: { ...ANSWERS, "ON-01": "Someone Else" } });

function record(over: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    subject_key: `onb_${"a".repeat(40)}`,
    unique_form_key: UKEY,
    fingerprint: "a".repeat(64),
    scope: "Combo",
    subject: { kind: "deal", dealId: DEAL_ID } as SubmissionRecord["subject"],
    link_id: "link_0123456789abcdef0123",
    entitlements: [],
    answers: ANSWERS as unknown as SubmissionRecord["answers"],
    verification_state: {},
    files: [],
    submitted_at: new Date(NOW_MS).toISOString(),
    is_first_request: true,
    product_related_to: "Fitness and Nutrition",
    ...over,
  };
}

describe("workdrive-key: configuration (17)", () => {
  it("needs neither a document reference field nor a raw field; it needs the approved WorkDrive root", () => {
    const cfg = loadCrmConfig(ENV);
    expect(cfg.persistence).toBe("workdrive-key");
    expect(cfg.docRefField).toBeUndefined();
    expect(cfg.rawField).toBeUndefined();
    expect(cfg.workdriveRootFolderId).toBe(ROOT_ID);
    expect(cfg.workdriveRootFolderName).toBe(ROOT_NAME);
  });

  it("fails clearly when the WorkDrive root is missing or malformed, or when a CRM-side document field is configured", () => {
    const bad = (env: Record<string, string>) => expect(() => loadCrmConfig(env)).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED", code: "CRM_NOT_CONFIGURED" }));
    const without = (k: string) => Object.fromEntries(Object.entries(ENV).filter(([key]) => key !== k));
    bad(without("SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID"));
    bad(without("SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME"));
    bad({ ...ENV, SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: "short" });
    bad({ ...ENV, SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON" }); // raw JSON must never reach the CRM
    bad({ ...ENV, SIX2FIT_ONBOARDING_DOC_REF_FIELD: "Verified_From" }); // no reference field in this mode
    bad({ ...ENV, SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-keyy" });
    // existing modes keep working unchanged
    expect(loadCrmConfig({ ...ENV, SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "raw-field", SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON" }).persistence).toBe("raw-field");
    expect(loadCrmConfig({ ...ENV, SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-ref", SIX2FIT_ONBOARDING_DOC_REF_FIELD: "Onboarding_Document_Ref" }).persistence).toBe("workdrive-ref");
  });

  it("a CRM writer in this mode cannot be built without the by-key document resolver", () => {
    expect(() => createRequestsWriter(ENV, { fetch: new MockZoho().fetch })).toThrowError(expect.objectContaining({ code: "CRM_NOT_CONFIGURED" }));
  });
});

describe("workdrive-key: submission flow (mocks)", () => {
  it("1) first submission: folder named by the key with files and the canonical document; the CRM Request carries the key and the structured fields only", async () => {
    const w = world();
    const r = await w.worker().submit(input());
    expect(r.status).toBe(200);
    expect(r.body["deduplicated"]).toBe(false);
    expect(folderOf(w.wd)).toBeDefined();
    expect(w.wd.all((folderOf(w.wd) as { id: string }).id).map((i) => i.name).sort()).toHaveLength(2);
    expect(docOf(w.wd)).toBeDefined();
    expect(w.zoho.records).toHaveLength(1);
    expect((w.zoho.records[0] as Record<string, unknown>)["uniqueformkey"]).toBe(UKEY);
    expect(w.zoho.triggerModes).toEqual(["suppressed"]);
  });

  it("16) no raw JSON, no document URL or reference, and no candidate field reaches the CRM payload", async () => {
    const w = world();
    await w.worker().submit(input());
    const rec = w.zoho.records[0] as Record<string, unknown>;
    const wire = JSON.stringify(rec);
    for (const marker of ['"answers"', '"fingerprint"', '"verification_state"', "workdrive", "wd:", "submission.v1.json", "front.jpg", "https://"]) expect(wire, marker).not.toContain(marker);
    for (const field of ["Onboarding_Raw_JSON", "Verified_From", "Document_Reference", "Onboarding_Document_Ref"]) expect(rec[field], field).toBeUndefined();
  });

  it("15) all existing structured fields are preserved: the payload equals the raw-field payload minus the raw field", () => {
    const base = { maxRawChars: 31_000, setNewRecordFlag: false };
    const raw = buildRequestsRecord(record(), { ...base, persistence: "raw-field", rawField: "Onboarding_Raw_JSON" }).record;
    const key = buildRequestsRecord(record({ document_ref: "wd:76a8029179d63afd94e27b40fd8a8f1e22ef7" }), { ...base, persistence: "workdrive-key" }).record;
    const { Onboarding_Raw_JSON: _raw, ...rawRest } = raw;
    expect(key).toEqual(rawRest);
    expect(Object.keys(key).length).toBeGreaterThan(40);
    expect(Object.values(key).some((v) => String(v).includes("wd:"))).toBe(false); // an internal document_ref is never transmitted
  });

  it("2) identical retry: deduplicated, no second Request, no new WorkDrive write", async () => {
    const w = world();
    await w.worker().submit(input());
    const uploads = w.wd.calls.upload;
    const r = await w.worker().submit(input({ submissionId: sid(2) }));
    expect(r.body["deduplicated"]).toBe(true);
    expect(w.zoho.records).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
    expect(w.wd.calls.upload).toBe(uploads);
  });

  it("3) concurrent identical attempts (two workers, one shared ledger): one stages, one creates", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.worker().submit(input()), w.worker().submit(input({ submissionId: sid(3) }))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body["deduplicated"], b.body["deduplicated"]].sort()).toEqual([false, true]);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
    expect(w.wd.calls.upload).toBe(2);
    expect(w.wd.all(w.wd.rootId).filter((i) => i.name === UKEY)).toHaveLength(1);
  });

  it("4) conflicting content under the same key is a 409; nothing in the CRM or WorkDrive changes", async () => {
    const w = world();
    await w.worker().submit(input());
    const before = JSON.stringify(w.zoho.records);
    expect((await w.worker().submit(other())).status).toBe(409);
    expect(JSON.stringify(w.zoho.records)).toBe(before);
    expect(w.wd.calls.upload).toBe(2);
  });

  it("11) WorkDrive success then an explicit CRM refusal stays recoverable: the retry reuses the staged items", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: "Email" }, status: "error" }] } }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(0);
    expect(w.wd.calls.upload).toBe(2);
    expect((await w.worker().submit(input({ submissionId: sid(11) }))).status).toBe(200);
    expect(w.wd.calls.upload).toBe(2);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("12) + 18) CRM success with a lost response: never a second POST while the outcome is unresolved; resolved by lookup and the verified WorkDrive document", async () => {
    const w = world();
    w.zoho.searchLag = true;
    w.zoho.failNext(/Requests$/, { kind: "persist-then-timeout" }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(1);
    for (const wait of [0, 30_000, 121_000]) {
      w.advance(wait);
      expect((await w.worker().submit(input({ submissionId: sid(12) }))).status).toBe(503); // lagging index: unresolved, NOT absent
      expect(posts(w.zoho)).toBe(1); // 18) no CRM POST after an unresolved ambiguous outcome
    }
    w.zoho.searchLag = false;
    w.advance(121_000);
    const ok = await w.worker().submit(input({ submissionId: sid(12) }));
    expect(ok.status).toBe(200);
    expect(ok.body["deduplicated"]).toBe(true);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("13) ledger recovery: after the ledger is lost an identical retry is deduplicated from verified CRM + WorkDrive evidence, a conflicting one is refused", async () => {
    const w = world();
    await w.worker().submit(input());
    await w.loseLedger();
    const uploads = w.wd.calls.upload;
    const again = await w.worker().submit(input({ submissionId: sid(13) }));
    expect(again.status).toBe(200);
    expect(again.body["deduplicated"]).toBe(true);
    expect(w.zoho.records).toHaveLength(1); // the CRM unique key refused the second insert; the record was read back and its document verified
    expect(w.wd.calls.upload).toBe(uploads); // the staged items were found and reused
    await w.loseLedger();
    const items = w.wd.all((folderOf(w.wd) as { id: string }).id).length;
    expect((await w.worker().submit(other())).status).toBe(409);
    // different answers AND a different photo: refused before any upload, so nothing is added to the existing submission
    const otherPhoto = jpegFile("front.jpg", 4096);
    otherPhoto.bytes[300] = 9;
    await w.loseLedger();
    expect((await w.worker().submit({ ...other(), submissionId: sid(10), idempotencyKey: sid(10), files: { "MS-05.front": otherPhoto } })).status).toBe(409);
    expect(w.zoho.records).toHaveLength(1);
    expect(w.wd.calls.upload).toBe(uploads);
    expect(w.wd.all((folderOf(w.wd) as { id: string }).id)).toHaveLength(items);
    // the legitimate original submission is still accepted afterwards (the conflicting attempts did not poison the ledger)
    await w.loseLedger();
    expect((await w.worker().submit(input({ submissionId: sid(15) }))).body["deduplicated"]).toBe(true);
  });

  it("ledger loss plus a damaged WorkDrive submission is never papered over: duplicate folders stop the retry", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.plant(w.wd.rootId, UKEY, "folder"); // a second folder with the same key
    await w.loseLedger();
    const uploads = w.wd.calls.upload;
    expect((await w.worker().submit(input({ submissionId: sid(14) }))).status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
    expect(w.wd.calls.upload).toBe(uploads);
  });
});

describe("workdrive-key: document resolution by key (read-only)", () => {
  const resolve = (w: ReturnType<typeof world>, key = UKEY) => w.storage().readDocumentIdentityByKey(key);

  it("a healthy submission resolves to its verified identity", async () => {
    const w = world();
    await w.worker().submit(input());
    const id = await resolve(w);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(id.documentId).toBe(docOf(w.wd)?.id);
    expect(id.folderId).toBe(folderOf(w.wd)?.id);
  });

  it("invalid keys are refused before WorkDrive is touched", async () => {
    const w = world();
    for (const bad of ["", "x", "onb2_short", "../../etc", "onb1_" + "a".repeat(20), "onb2_ spaced key here"]) {
      await expect(resolve(w, bad)).rejects.toMatchObject({ kind: "REJECTED", code: "WD_INVALID_KEY" });
    }
    expect(w.wd.calls.list).toBe(0);
  });

  it("5) missing folder: retryable, distinct code, never reported as a match", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.drop((folderOf(w.wd) as { id: string }).id);
    await expect(resolve(w)).rejects.toMatchObject({ kind: "UNAVAILABLE", code: "WD_FOLDER_NOT_FOUND" });
  });

  it("6) duplicate folders: integrity error, no folder is picked", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.plant(w.wd.rootId, UKEY, "folder");
    await expect(resolve(w)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_AMBIGUOUS_FOLDER" });
  });

  it("7) missing canonical document: retryable, distinct code", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.drop((docOf(w.wd) as { id: string }).id);
    await expect(resolve(w)).rejects.toMatchObject({ kind: "UNAVAILABLE", code: "WD_DOCUMENT_MISSING" });
  });

  it("8) duplicate canonical documents (exact twin or timestamp-renamed twin): integrity error", async () => {
    const w = world();
    await w.worker().submit(input());
    const folder = folderOf(w.wd) as { id: string };
    w.wd.plant(folder.id, DOCUMENT_NAME, "file", new TextEncoder().encode("{}"));
    await expect(resolve(w)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_AMBIGUOUS_FILES" });
    const twin = w.wd.all(folder.id).filter((i) => i.name === DOCUMENT_NAME).at(-1) as { id: string };
    w.wd.drop(twin.id);
    await expect(resolve(w)).resolves.toBeDefined(); // back to exactly one
    w.wd.plant(folder.id, "submission.v1 17-10-2026 00:54:47:912.json", "file", new TextEncoder().encode("{}"));
    await expect(resolve(w)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_AMBIGUOUS_FILES" });
  });

  it("9) tampered or unreadable document: integrity error", async () => {
    const w = world();
    await w.worker().submit(input());
    const doc = docOf(w.wd) as { id: string };
    const text = new TextDecoder().decode(await w.wd.download(doc.id)).replace(/"ON-01":"[^"]*"/, '"ON-01":"Edited"');
    w.wd.tamper(doc.id, new TextEncoder().encode(text));
    await expect(resolve(w)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_DOCUMENT_TAMPERED" });
    w.wd.tamper(doc.id, new TextEncoder().encode("not json at all"));
    await expect(resolve(w)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_DOCUMENT_UNREADABLE" });
  });

  it("10) temporary WorkDrive failures are retryable and never look like a missing or damaged submission", async () => {
    const w = world();
    await w.worker().submit(input());
    for (const [status, code] of [[503, "WD_UNAVAILABLE"], [429, "WD_RATE_LIMITED"], [0, "WD_UNAVAILABLE"]] as const) {
      const fresh = world({ wd: w.wd, zoho: w.zoho });
      w.wd.inject({ op: "list", nth: w.wd.calls.list + 1, status, applied: false });
      await expect(fresh.storage().readDocumentIdentityByKey(UKEY)).rejects.toMatchObject({ kind: "UNAVAILABLE", code });
    }
    w.wd.mode = "unauthenticated";
    await expect(world({ wd: w.wd }).storage().readDocumentIdentityByKey(UKEY)).rejects.toMatchObject({ kind: "UNAVAILABLE", code: "WD_UNAUTHENTICATED" });
  });

  it("a root folder that does not match the configuration is refused", async () => {
    const wd = new MockWorkDrive(ROOT_ID, "General");
    const storage = new WorkDriveSubmissionStorage(wd, { rootFolderId: ROOT_ID, rootFolderName: ROOT_NAME });
    await expect(storage.readDocumentIdentityByKey(UKEY)).rejects.toMatchObject({ code: "WD_INVALID_PARENT" });
  });
});

describe("workdrive-key: reconciliation (read-only)", () => {
  it("14) reports matched, orphan, missing and ambiguous submissions with counts, and changes nothing", async () => {
    const w = world();
    await w.worker().submit(input()); // healthy: CRM + WorkDrive
    const orphan = `onb2_${DEAL_ID}_link_orphan0000000000001`;
    const f = w.wd.plant(w.wd.rootId, orphan, "folder"); // WorkDrive without any CRM Request
    w.wd.plant(f.id, DOCUMENT_NAME, "file", new TextEncoder().encode("{}"));
    const dupKey = `onb2_${DEAL_ID}_link_dup00000000000000002`;
    w.wd.plant(w.wd.rootId, dupKey, "folder");
    w.wd.plant(w.wd.rootId, dupKey, "folder");
    const missing = `onb2_${DEAL_ID}_link_nofolder00000000003`;
    const noDoc = `onb2_${DEAL_ID}_link_nodoc00000000000004`;
    w.wd.plant(w.wd.rootId, noDoc, "folder");

    const writesBefore = { up: w.wd.calls.upload, mk: w.wd.calls.createFolder, posts: posts(w.zoho) };
    const empty = new MockZoho(); // a CRM that knows none of the WorkDrive-only keys
    const crm = createRequestsWriter(ENV, { fetch: empty.fetch, documentIdentityByKey: async () => ({ fingerprint: "x", submitted_at: "x" }) });
    const report = await reconcileSubmissions({ storage: w.storage(), crm, crmKeys: [UKEY, missing, noDoc] });

    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e.status]));
    expect(byKey[UKEY]).toBe("matched");
    expect(byKey[missing]).toBe("crm_without_folder");
    expect(byKey[noDoc]).toBe("crm_without_document");
    expect(byKey[orphan]).toBe("orphan_workdrive");
    expect(byKey[dupKey]).toBe("ambiguous_folder");
    expect(report.counts).toMatchObject({ matched: 1, crm_without_folder: 1, crm_without_document: 1, orphan_workdrive: 1, ambiguous_folder: 1, integrity_failure: 0 });
    expect(report.totals).toEqual({ crm_keys: 3, workdrive_folders: 5 });
    // strictly read-only
    expect({ up: w.wd.calls.upload, mk: w.wd.calls.createFolder, posts: posts(w.zoho) }).toEqual(writesBefore);
    expect(posts(empty)).toBe(0);
    // the report holds keys and statuses only
    const text = JSON.stringify(report);
    for (const marker of ["Ali", "Someone", "front.jpg", "answers", "fingerprint", "workdrive.zoho.com"]) expect(text).not.toContain(marker);
  });

  it("separates a WorkDrive folder whose Request exists but was not in the supplied list, and reports a failing CRM lookup", async () => {
    const w = world();
    await w.worker().submit(input());
    const unlisted = await reconcileSubmissions({ storage: w.storage(), crm: w.crmWriter(), crmKeys: [] });
    expect(unlisted.entries).toEqual([{ key: UKEY, status: "crm_found_unlisted" }]);
    const failing = new MockZoho();
    failing.failNext(/Requests\/search$/, { kind: "status", status: 500, body: {} }, 5);
    const crm = createRequestsWriter(ENV, { fetch: failing.fetch, documentIdentityByKey: async () => ({ fingerprint: "x", submitted_at: "x" }) });
    const lookupFail = await reconcileSubmissions({ storage: w.storage(), crm, crmKeys: [] });
    expect(lookupFail.counts.crm_lookup_failed).toBe(1);
  });

  it("a WorkDrive outage during reconciliation is a report line or a clear error, never a false match", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.mode = "unauthenticated";
    await expect(reconcileSubmissions({ storage: w.storage(), crm: w.crmWriter(), crmKeys: [UKEY] })).rejects.toBeInstanceOf(StoreError);
  });

  it("a tampered document is an integrity finding, not a match", async () => {
    const w = world();
    await w.worker().submit(input());
    w.wd.tamper((docOf(w.wd) as { id: string }).id, new TextEncoder().encode("{}"));
    const r = await reconcileSubmissions({ storage: w.storage(), crm: w.crmWriter(), crmKeys: [UKEY] });
    expect(r.entries).toEqual([{ key: UKEY, status: "integrity_failure", code: "WD_DOCUMENT_TAMPERED" }]);
  });
});
