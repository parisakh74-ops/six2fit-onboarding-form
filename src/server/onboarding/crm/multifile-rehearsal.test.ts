// @vitest-environment node
// MOCK REHEARSAL of the operator-run MULTI-FILE live test (submission-multifile.live.test.ts): the same seven synthetic files, the
// same submission builder and the same case sequence against MockZoho / MockWorkDrive. Not live evidence.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../canonical";
import { handleSubmit, runtimeFromEnv } from "../http";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { signLinkToken, uniqueFormKey, verifyLinkToken } from "../tokens";
import { MockWorkDrive } from "../workdrive/mock";
import { DOCUMENT_NAME } from "../workdrive/storage";
import { LIVE_EMAIL, MULTIFILE_ENTITLEMENTS, buildMultiFileRequest, liveSubmissionId, syntheticFiles, syntheticMultiFileAnswers } from "./live-fixtures";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const DEAL = "6223361000127334002";
const PRODUCT = "6223361000127336001";
const CONTACT = "6223361000127337001";
const SECRET = "rehearsal-secret-0123456789abcdef0123456789";

let dir: string;
let logs: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-mf-rehearsal-"));
  await mkdir(dir, { recursive: true });
  logs = [];
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const ENV = (): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true", SIX2FIT_ONBOARDING_STORE: "crm", SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID, SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [...MULTIFILE_ENTITLEMENTS] } }),
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true", SIX2FIT_ZOHO_ENVIRONMENT: "sandbox", SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN, SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "c", SIX2FIT_ZOHO_CLIENT_SECRET: "s", SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh", SIX2FIT_ZOHO_TIMEOUT_MS: "400",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key", SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID, SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
  SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN, SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.com/workdrive/api/v1",
  SIX2FIT_WORKDRIVE_CLIENT_ID: "wc", SIX2FIT_WORKDRIVE_CLIENT_SECRET: "ws", SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "synthetic-wd-refresh",
  SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "50",
});
class Reader implements CrmDealReader {
  async getDeal(): Promise<DealView> { return { id: DEAL, orgId: MOCK_ORG_ID, contactId: CONTACT, productId: PRODUCT, productName: "S2F-TEST-ONBOARDING-20261021", productRelatedTo: null }; }
  async getContact(): Promise<ContactView> { return { id: CONTACT, email: LIVE_EMAIL, phone: null, mobile: null }; }
  async hasPriorRequests() { return false; }
}
const link = (jti: string) => signLinkToken({ v: 2, deal_id: DEAL, jti, scope: "Combo", entitlements: [...MULTIFILE_ENTITLEMENTS], exp: Math.floor(Date.now() / 1000) + 24 * 3600, is_first_request: true, product_related_to: "S2F-TEST-ONBOARDING-20261021" }, SECRET);
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const world = () => {
  const zoho = new MockZoho();
  const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const rt = runtimeFromEnv(ENV(), { dealReader: new Reader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { zoho, wd, rt };
};
const items = (wd: MockWorkDrive, key: string) => {
  const f = wd.all(ROOT_ID).filter((i) => i.kind === "folder" && i.name === key);
  expect(f).toHaveLength(1);
  return wd.all((f[0] as { id: string }).id);
};
const submit = (w: ReturnType<typeof world>, token: string, sid: string, over: { answers?: Record<string, string>; files?: ReturnType<typeof syntheticFiles> } = {}) =>
  handleSubmit(buildMultiFileRequest({ token, submissionId: sid, answers: over.answers ?? syntheticMultiFileAnswers(), files: over.files ?? syntheticFiles() }), { runtime: () => w.rt });

describe("multi-file rehearsal (mocks)", () => {
  it("the fixture really has seven files with distinct identities, sizes, hashes and the three accepted types", () => {
    const f = syntheticFiles();
    expect(Object.keys(f)).toHaveLength(7);
    const hashes = new Set(Object.values(f).map((x) => sha256Hex(x.bytes)));
    expect(hashes.size).toBe(7);
    expect(new Set(Object.values(f).map((x) => x.bytes.length)).size).toBe(7);
    expect(new Set(Object.values(f).map((x) => x.type))).toEqual(new Set(["image/jpeg", "image/png", "application/pdf"]));
  });

  it("A: seven files in ONE submission -> folder with 7 files + one canonical document, every hash and reference correct, one Request, nothing on the local disk, no sensitive content in logs", async () => {
    const w = world();
    const files = syntheticFiles();
    const token = link("s2ftestmultifileA1xx");
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const res = await submit(w, token, liveSubmissionId("MF-A", "t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });

    const folderItems = items(w.wd, key);
    expect(folderItems).toHaveLength(8);
    expect(new Set(folderItems.map((i) => i.name)).size).toBe(8); // every item exactly once
    expect(folderItems.filter((i) => i.name === DOCUMENT_NAME)).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(await w.wd.download((folderItems.find((i) => i.name === DOCUMENT_NAME) as { id: string }).id))) as { files: Array<{ key: string; name: string; type: string; size: number; sha256: string; ref: string }>; unique_form_key: string };
    expect(doc.unique_form_key).toBe(key);
    expect(doc.files).toHaveLength(7);
    expect(new Set(doc.files.map((f) => f.key)).size).toBe(7);
    for (const [k, f] of Object.entries(files)) {
      const entry = doc.files.find((x) => x.key === k);
      expect(entry, k).toBeDefined();
      expect(entry?.sha256).toBe(sha256Hex(f.bytes));
      expect(entry?.size).toBe(f.bytes.length);
      expect(entry?.type).toBe(f.type);
      const stored = folderItems.find((i) => i.id === (entry as { ref: string }).ref.replace(/^wd:/, ""));
      expect(stored?.name).toBe(`${k.replace(/[^A-Za-z0-9_.-]/g, "_")}-${sha256Hex(f.bytes).slice(0, 16)}.${f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : "jpg"}`);
      expect(sha256Hex(await w.wd.download((stored as { id: string }).id))).toBe(sha256Hex(f.bytes)); // the stored bytes are the submitted bytes
    }
    expect(posts(w.zoho)).toBe(1);
    expect((await readdir(dir)).filter((n) => !["onboarding-ledger", "payments", "issued-links"].includes(n))).toEqual([]);
    const text = logs.join("\n");
    expect(text).not.toContain(LIVE_EMAIL);
    for (const f of Object.values(files)) expect(text).not.toContain(sha256Hex(f.bytes));
    expect(text).not.toMatch(/front\.jpg|document\.pdf|MS-05|HL-09|S2F-TEST Synthetic/);
  });

  it("B: identical retry deduplicated; conflicting answers or one changed file -> 409; no new upload, item or Request", async () => {
    const w = world();
    const token = link("s2ftestmultifileB1xx");
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const sid = liveSubmissionId("MF-B", "t1");
    expect((await submit(w, token, sid)).status).toBe(200);
    const uploads = w.wd.calls.upload;
    const again = await submit(w, token, sid);
    expect(await again.json()).toMatchObject({ deduplicated: true });
    expect((await submit(w, token, sid, { answers: { ...syntheticMultiFileAnswers(), "ON-01": "S2F-TEST Different" } })).status).toBe(409);
    const changed = syntheticFiles();
    changed["MS-05.back"] = { ...changed["MS-05.back"]!, bytes: changed["MS-05.back"]!.bytes.map((b, i) => (i === 100 ? b ^ 1 : b)) };
    expect((await submit(w, token, sid, { files: changed })).status).toBe(409);
    expect(w.wd.calls.upload).toBe(uploads);
    expect(items(w.wd, key)).toHaveLength(8);
    expect(posts(w.zoho)).toBe(1);
  });

  it("C: the 4th of 7 uploads is refused (definite) -> 503, no CRM write, 3 files kept; the retry resumes: 8 items, no renamed duplicates, exactly one Request", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 4, status: 503, applied: false });
    const token = link("s2ftestmultifileC1xx");
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const sid = liveSubmissionId("MF-C", "t1");
    expect((await submit(w, token, sid)).status).toBe(503);
    expect(posts(w.zoho)).toBe(0);
    expect(items(w.wd, key)).toHaveLength(3);
    const uploadsBefore = w.wd.calls.upload;
    expect((await submit(w, token, sid)).status).toBe(200);
    const done = items(w.wd, key);
    expect(done).toHaveLength(8);
    expect(done.some((i) => /\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(false);
    expect(w.wd.calls.upload - uploadsBefore).toBe(5); // 4 remaining files + the document: the 3 stored files were NOT uploaded again
    expect(posts(w.zoho)).toBe(1);
  });

  it("D: an upload that was applied but whose answer was lost (ambiguous) is recovered by looking, not re-uploading: still one item per file", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 0, applied: true });
    const token = link("s2ftestmultifileD1xx");
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const sid = liveSubmissionId("MF-D", "t1");
    const first = await submit(w, token, sid);
    expect([200, 503]).toContain(first.status);
    if (first.status === 503) expect((await submit(w, token, sid)).status).toBe(200);
    const done = items(w.wd, key);
    expect(done).toHaveLength(8);
    expect(new Set(done.map((i) => i.name)).size).toBe(8);
    expect(posts(w.zoho)).toBe(1);
  });
});
