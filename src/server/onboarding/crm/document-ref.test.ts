// @vitest-environment node
// WorkDrive-reference persistence in the CRM adapter. MOCKS ONLY: no network, no CRM, no WorkDrive.
// `Verified_From` appears below only as one of the configurable candidates exercised with mocks; the source never names it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../canonical";
import { StoreError } from "../errors";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import type { SubjectDirectory, SubmissionRecord } from "../ports";
import { createOnboardingService, type SubmitInput } from "../service";
import { MockWorkDrive } from "../workdrive/mock";
import { DOCUMENT_NAME, DeferredFileSink, WorkDriveStagingWriter, WorkDriveSubmissionStorage } from "../workdrive/storage";
import { loadCrmConfig } from "./config";
import { createRequestsWriter } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";
import { buildRequestsRecord, documentPermalink } from "./requests-mapping";

const ROOT_NAME = "S2F-ONBOARDING-TEST";
const UKEY = `onb2_${DEAL_ID}_link_0123456789abcdef0123`;
const FIELD = "Onboarding_Document_Ref";
const ID37 = "76a8029179d63afd94e27b40fd8a8f1e22ef7";

const ENV_COMMON: Record<string, string> = {
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
};
const envFor = (field: string | undefined): Record<string, string> => ({ ...ENV_COMMON, SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-ref", ...(field ? { SIX2FIT_ONBOARDING_DOC_REF_FIELD: field } : {}) });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-docref-"));
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

function world(field: string | undefined = FIELD, wd = new MockWorkDrive()) {
  const clock = { t: NOW_MS };
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  const zoho = new MockZoho();
  const storage = () => new WorkDriveSubmissionStorage(wd, { rootFolderId: wd.rootId, rootFolderName: ROOT_NAME });
  const worker = () => {
    const crm = createRequestsWriter(envFor(field), { fetch: zoho.fetch, now: () => clock.t, sleep, documentIdentity: (p, k) => storage().readDocumentIdentity(p, k) });
    const store = new LedgerOnboardingStore(new WorkDriveStagingWriter(crm, storage()), new IdempotencyLedger(join(dir, "ledger")), { now: () => clock.t, sleep, waitMs: 1_000_000_000 });
    return createOnboardingService({ store, directory: new Directory(), sink: new DeferredFileSink(), secret: SECRET, now: () => clock.t });
  };
  return { zoho, wd, clock, worker, storage, advance: (ms: number) => (clock.t += ms) };
}
const input = (over: Partial<SubmitInput> = {}): SubmitInput => {
  const id = over.submissionId ?? "11111111-2222-4333-8444-555555555555";
  return { token: dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }), submissionId: id, idempotencyKey: id, answers: ANSWERS, verificationState: "{}", files: { "MS-05.front": front() }, ...over };
};
const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const docItem = (wd: MockWorkDrive) => {
  const folder = wd.all(wd.rootId).find((i) => i.name === UKEY);
  return folder ? wd.all(folder.id).find((i) => i.name === DOCUMENT_NAME) : undefined;
};

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
    document_ref: `wd:${ID37}`,
    ...over,
  };
}
const OPTS = { persistence: "workdrive-ref" as const, docRefField: FIELD, maxRawChars: 31_000, setNewRecordFlag: false };

describe("document reference: successful path (mocks)", () => {
  it("1) a valid private WorkDrive permalink is stored in the configured field; nothing else about the document reaches the CRM", async () => {
    const w = world();
    const r = await w.worker().submit(input());
    expect(r.status).toBe(200);
    expect(w.zoho.records).toHaveLength(1);
    const rec = w.zoho.records[0] as Record<string, unknown>;
    const doc = docItem(w.wd) as { id: string };
    expect(rec[FIELD]).toBe(`https://workdrive.zoho.com/file/${doc.id}`);
    expect(rec[FIELD]).toMatch(/^https:\/\/workdrive\.zoho\.com\/file\/[A-Za-z0-9]{20,64}$/);
    expect(w.zoho.triggerModes).toEqual(["suppressed"]);
    // no raw JSON field, no fingerprint, no file names, no document markers anywhere in the CRM payload
    const wire = JSON.stringify(rec);
    expect(rec["Onboarding_Raw_JSON"]).toBeUndefined();
    for (const marker of ['"answers"', '"fingerprint"', '"verification_state"', "submission.v1.json", "front.jpg", "wd:"]) expect(wire).not.toContain(marker);
  });

  it("6) the future field Onboarding_Document_Ref and the candidate Verified_From are both just configuration (mock only)", async () => {
    for (const [i, field] of [FIELD, "Verified_From"].entries()) {
      const w = world(field);
      const link = dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600, jti: `link_${i}0123456789abcdef012` });
      expect((await w.worker().submit(input({ token: link }))).status).toBe(200);
      const rec = w.zoho.records[0] as Record<string, unknown>;
      expect(String(rec[field])).toMatch(/^https:\/\/workdrive\.zoho\.com\/file\//);
      expect(Object.keys(rec).filter((k) => String(rec[k]).includes("workdrive.zoho.com"))).toEqual([field]); // exactly one field carries it
    }
  });

  it("7) every structured field is preserved: the only difference to the raw-field mapping is the one reference field", () => {
    const base = { maxRawChars: 31_000, setNewRecordFlag: false };
    const raw = buildRequestsRecord(record(), { ...base, persistence: "raw-field", rawField: "Onboarding_Raw_JSON" }).record;
    const ref = buildRequestsRecord(record(), { ...base, ...OPTS }).record;
    const { Onboarding_Raw_JSON: _raw, ...rawRest } = raw;
    const { [FIELD]: link, ...refRest } = ref;
    expect(refRest).toEqual(rawRest);
    expect(link).toBe(`https://workdrive.zoho.com/file/${ID37}`);
    expect(Object.keys(rawRest).length).toBeGreaterThan(40); // the 63-key mapping is intact
  });
});

describe("document reference: validation before any CRM write", () => {
  it("2) a missing reference is refused deterministically before the payload exists (no POST)", async () => {
    expect(() => buildRequestsRecord(record({ document_ref: undefined }), OPTS)).toThrowError(expect.objectContaining({ code: "DOCUMENT_REF_MISSING", notWritten: true }));
    expect(() => buildRequestsRecord(record({ document_ref: "  " }), OPTS)).toThrowError(expect.objectContaining({ code: "DOCUMENT_REF_MISSING" }));
    const zoho = new MockZoho();
    const writer = createRequestsWriter(envFor(FIELD), { fetch: zoho.fetch, documentIdentity: async () => ({ fingerprint: "x", submitted_at: "x" }) });
    await expect(writer.create(record({ document_ref: undefined }))).rejects.toMatchObject({ code: "DOCUMENT_REF_MISSING", notWritten: true });
    expect(posts(zoho)).toBe(0);
  });

  it.each([
    ["not a url", "not a url"],
    ["plain http", `http://workdrive.zoho.com/file/${ID37}`],
    ["another host", `https://workdrive.example.com/file/${ID37}`],
    ["lookalike host", `https://workdrive.zoho.com.evil.test/file/${ID37}`],
    ["sharing key in the query", `https://workdrive.zoho.com/file/${ID37}?key=abc123`],
    ["fingerprint in the fragment", `https://workdrive.zoho.com/file/${ID37}#${"a".repeat(64)}`],
    ["credentials in the URL", `https://user:secret@workdrive.zoho.com/file/${ID37}`],
    ["explicit port", `https://workdrive.zoho.com:8443/file/${ID37}`],
    ["trailing path", `https://workdrive.zoho.com/file/${ID37}/`],
    ["public folder style path", `https://workdrive.zoho.com/folder/${ID37}`],
    ["id too short", "https://workdrive.zoho.com/file/abc"],
    ["internal ref with short id", "wd:abc"],
    ["fingerprint suffix on the internal ref", `wd:${ID37}#${"a".repeat(64)}`],
  ])("3) malformed or unsafe reference is rejected before any write: %s", async (_name, ref) => {
    expect(() => documentPermalink(ref)).toThrowError(expect.objectContaining({ code: "DOCUMENT_REF_INVALID", notWritten: true }));
    const zoho = new MockZoho();
    const writer = createRequestsWriter(envFor(FIELD), { fetch: zoho.fetch, documentIdentity: async () => ({ fingerprint: "x", submitted_at: "x" }) });
    await expect(writer.create(record({ document_ref: ref }))).rejects.toMatchObject({ code: "DOCUMENT_REF_INVALID" });
    expect(posts(zoho)).toBe(0);
  });

  it("accepts both accepted spellings and normalizes to the permalink", () => {
    expect(documentPermalink(`wd:${ID37}`)).toBe(`https://workdrive.zoho.com/file/${ID37}`);
    expect(documentPermalink(`https://workdrive.zoho.com/file/${ID37}`)).toBe(`https://workdrive.zoho.com/file/${ID37}`);
  });

  it("4) the field API name must be configured explicitly and validated; there is no default", async () => {
    const bad = (env: Record<string, string>) => expect(() => loadCrmConfig(env)).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
    bad(envFor(undefined)); // workdrive mode without a field
    bad(envFor("")); // empty
    bad(envFor("1bad name")); // not an API name
    bad(envFor("Document_Reference")); // owned by the Trello integration
    bad(envFor("Trello_Card_URL")); // Trello family
    bad(envFor("uniqueformkey")); // core key
    bad(envFor("Submission_Id")); // core key
    bad({ ...envFor(FIELD), SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON" }); // complete answers must never reach the CRM in this mode
    bad({ ...ENV_COMMON, SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON", SIX2FIT_ONBOARDING_DOC_REF_FIELD: FIELD }); // reference field in raw-field mode
    bad({ ...ENV_COMMON, SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "something-else" });
    expect(loadCrmConfig(envFor(FIELD)).docRefField).toBe(FIELD);
    expect(loadCrmConfig(envFor("Verified_From")).docRefField).toBe("Verified_From"); // allowed as plain configuration only
    // a mapped structured field is refused at payload time, before any request
    expect(() => buildRequestsRecord(record(), { ...OPTS, docRefField: "Date_of_Birth" })).toThrowError(expect.objectContaining({ code: "DOC_REF_FIELD_CONFLICT", notWritten: true }));
    expect(() => buildRequestsRecord(record(), { ...OPTS, docRefField: undefined })).toThrowError(expect.objectContaining({ code: "DOC_REF_FIELD_INVALID" }));
  });

  it("10) no source file hardcodes Verified_From or defaults the field name", async () => {
    for (const f of ["config.ts", "requests-mapping.ts", "requests-store.ts", "factory.ts"]) {
      const text = await readFile(join(__dirname, f), "utf8");
      expect(text, f).not.toMatch(/Verified_From/);
      expect(text, f).not.toMatch(/DOC_REF_FIELD["']\)\s*\|\|/);
    }
  });

  it("a store in workdrive mode cannot be built without a document identity resolver", () => {
    expect(() => createRequestsWriter(envFor(FIELD), { fetch: new MockZoho().fetch })).toThrowError(expect.objectContaining({ code: "CRM_NOT_CONFIGURED" }));
  });
});

describe("document reference: CRM outcomes, retries and conflicts (mocks)", () => {
  it("8) CRM explicit refusal: nothing in the CRM, the staged WorkDrive items stay and are reused by the retry (no second upload)", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: FIELD }, status: "error" }] } }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(0);
    const uploads = w.wd.calls.upload;
    expect(uploads).toBe(2); // front + document
    expect((await w.worker().submit(input({ submissionId: sid(2) }))).status).toBe(200);
    expect(w.wd.calls.upload).toBe(uploads);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("9) CRM success but the answer is lost: never a blind second POST; resolved later by lookup and verified against WorkDrive", async () => {
    const w = world();
    w.zoho.searchLag = true;
    w.zoho.failNext(/Requests$/, { kind: "persist-then-timeout" }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(1);
    w.advance(121_000);
    expect((await w.worker().submit(input({ submissionId: sid(3) }))).status).toBe(503); // index still lagging: unresolved
    w.zoho.searchLag = false;
    w.advance(121_000);
    const ok = await w.worker().submit(input({ submissionId: sid(3) }));
    expect(ok.status).toBe(200);
    expect(ok.body["deduplicated"]).toBe(true);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
    expect(w.wd.calls.upload).toBe(2);
  });

  it("an identical retry is deduplicated: one POST, no new WorkDrive upload", async () => {
    const w = world();
    await w.worker().submit(input());
    const r = await w.worker().submit(input({ submissionId: sid(4) }));
    expect(r.body["deduplicated"]).toBe(true);
    expect(posts(w.zoho)).toBe(1);
    expect(w.wd.calls.upload).toBe(2);
  });

  it("a conflicting submission for the same link is a 409; neither the CRM record nor the document changes", async () => {
    const w = world();
    await w.worker().submit(input());
    const before = JSON.stringify(w.zoho.records);
    const other = input({ submissionId: sid(5), answers: { ...ANSWERS, "ON-01": "Someone Else" } });
    expect((await w.worker().submit(other)).status).toBe(409);
    expect(JSON.stringify(w.zoho.records)).toBe(before);
    expect(posts(w.zoho)).toBe(1);
    expect(w.wd.calls.upload).toBe(2);
  });

  it("a duplicate answer from the CRM (non-atomic uniqueness) is verified against the document, not trusted blindly", async () => {
    const w = world();
    await w.worker().submit(input());
    const rec = w.zoho.records[0] as Record<string, unknown>;
    // The CRM-side reference now points at a different file: the next read must refuse it instead of reporting a match.
    const other = w.wd.plant(w.wd.rootId, "unrelated", "file", new TextEncoder().encode("{}"));
    rec[FIELD] = `https://workdrive.zoho.com/file/${other.id}`;
    await expect(w.storage().readDocumentIdentity(String(rec[FIELD]), UKEY)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_DOCUMENT_REF_INVALID" });
  });

  it("a document edited inside WorkDrive is detected (fingerprint no longer matches its own content)", async () => {
    const w = world();
    await w.worker().submit(input());
    const doc = docItem(w.wd) as { id: string };
    const items = (w.wd as unknown as { items: Map<string, { bytes: Uint8Array }> }).items;
    const text = new TextDecoder().decode(items.get(doc.id)?.bytes).replace("Weight Reduction", "Weight Reduction ").replace(/"ON-01":"[^"]*"/, '"ON-01":"Edited"');
    (items.get(doc.id) as { bytes: Uint8Array }).bytes = new TextEncoder().encode(text);
    await expect(w.storage().readDocumentIdentity(`https://workdrive.zoho.com/file/${doc.id}`, UKEY)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_DOCUMENT_TAMPERED" });
    expect(sha256Hex(text).length).toBe(64);
  });

  it("an unreachable WorkDrive during the verification read is a retryable failure, never a false match", async () => {
    const w = world();
    await w.worker().submit(input());
    const doc = docItem(w.wd) as { id: string };
    w.wd.mode = "unauthenticated";
    await expect(w.storage().readDocumentIdentity(`https://workdrive.zoho.com/file/${doc.id}`, UKEY)).rejects.toBeInstanceOf(StoreError);
  });
});
