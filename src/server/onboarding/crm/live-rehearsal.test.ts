// @vitest-environment node
// MOCK REHEARSAL of the operator-run live test (submission-workdrive.live.test.ts): the SAME fixtures and the SAME case sequence
// (A one-file submission, B duplicate/conflict, C injected WorkDrive failure + resumed retry) against MockZoho / MockWorkDrive,
// so a fixture or sequencing defect is found locally. Also the regression for the first live attempt (400 INVALID_SUBMISSION).
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../canonical";
import { handleSubmit, runtimeFromEnv } from "../http";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { SUBMISSION_ID_PATTERN } from "../service";
import { signLinkToken, uniqueFormKey, verifyLinkToken } from "../tokens";
import { MockWorkDrive } from "../workdrive/mock";
import { DOCUMENT_NAME } from "../workdrive/storage";
import { LIVE_EMAIL, buildSubmitRequest, liveSubmissionId, syntheticAnswers, syntheticFile } from "./live-fixtures";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const DEAL = "6223361000127334002";
const PRODUCT = "6223361000127336001";
const CONTACT = "6223361000127337001";
const SECRET = "rehearsal-secret-0123456789abcdef0123456789";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-rehearsal-"));
  await mkdir(dir, { recursive: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const ENV = (): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true", SIX2FIT_ONBOARDING_STORE: "crm", SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID, SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [] } }),
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

const link = (jti: string) => signLinkToken({ v: 2, deal_id: DEAL, jti, scope: "Combo", entitlements: [], exp: Math.floor(Date.now() / 1000) + 24 * 3600, is_first_request: true, product_related_to: "S2F-TEST-ONBOARDING-20261021" }, SECRET);
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const world = () => {
  const zoho = new MockZoho();
  const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const rt = runtimeFromEnv(ENV(), { dealReader: new Reader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { zoho, wd, rt };
};
const folderItems = (wd: MockWorkDrive, key: string) => {
  const f = wd.all(ROOT_ID).filter((i) => i.kind === "folder" && i.name === key);
  expect(f).toHaveLength(1);
  return wd.all((f[0] as { id: string }).id);
};

describe("regression: the first live attempt (400 INVALID_SUBMISSION)", () => {
  it("a base-36 timestamp in the submission id is refused FIRST, before any read, write, ledger entry or upload", async () => {
    const w = world();
    const stamp = "mvht1bep"; // the exact stamp of the failed live run
    const badSid = "aaaaaaaa-bbbb-4ccc-8ddd-" + stamp.padStart(12, "0").slice(-12);
    expect(SUBMISSION_ID_PATTERN.test(badSid)).toBe(false); // non-hex letters (m, v, h, t, p)
    const res = await handleSubmit(buildSubmitRequest({ token: link("s2ftest-bad"), submissionId: badSid, answers: syntheticAnswers(), file: syntheticFile() }), { runtime: () => w.rt });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_SUBMISSION" });
    expect(w.zoho.requests).toHaveLength(0); // not even the organisation check: rejected on the first line of submit
    expect(w.wd.calls.upload + w.wd.calls.createFolder + w.wd.calls.list + w.wd.calls.getItem).toBe(0);
    expect(await readdir(dir)).toEqual([]); // no ledger entry, no payment fact, no file
  });

  it("the fixture helper always yields a valid id (any stamp, including base-36), distinct per case, deterministic per input", () => {
    for (const stamp of ["mvht1bep", "zzzzzzzz", "0", "k9x8w7v6u5t4s3r2q1"]) for (const tag of ["A", "C"]) expect(SUBMISSION_ID_PATTERN.test(liveSubmissionId(tag, stamp))).toBe(true);
    expect(liveSubmissionId("A", "mvht1bep")).not.toBe(liveSubmissionId("C", "mvht1bep"));
    expect(liveSubmissionId("A", "mvht1bep")).toBe(liveSubmissionId("A", "mvht1bep"));
  });
});

describe("rehearsal of the live sequence (mocks)", () => {
  it("A + B: one-file submission, integrity, one Request with trigger [], duplicate deduplicated, conflict 409", async () => {
    const w = world();
    const stamp = "mvht1bep";
    const token = link(`s2ftest${stamp}A1`);
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const sid = liveSubmissionId("A", stamp);
    const file = syntheticFile();
    const res = await handleSubmit(buildSubmitRequest({ token, submissionId: sid, answers: syntheticAnswers(), file }), { runtime: () => w.rt });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });
    const items = folderItems(w.wd, key);
    expect(items).toHaveLength(2);
    const fileItem = items.find((i) => i.name.startsWith("MS-05.front-") && i.name.endsWith(".jpg"));
    expect(fileItem?.size).toBe(file.length);
    expect(items.some((i) => i.name === DOCUMENT_NAME)).toBe(true);
    expect(sha256Hex(await w.wd.download((fileItem as { id: string }).id))).toBe(sha256Hex(file));
    expect(posts(w.zoho)).toBe(1);
    expect((await readdir(dir)).filter((n) => !["onboarding-ledger", "payments", "issued-links"].includes(n))).toEqual([]);

    const again = await handleSubmit(buildSubmitRequest({ token, submissionId: sid, answers: syntheticAnswers(), file }), { runtime: () => w.rt });
    expect(await again.json()).toMatchObject({ deduplicated: true });
    const uploads = w.wd.calls.upload;
    const conflict = await handleSubmit(buildSubmitRequest({ token, submissionId: sid, answers: { ...syntheticAnswers(), "ON-01": "S2F-TEST Different" }, file }), { runtime: () => w.rt });
    expect(conflict.status).toBe(409);
    expect(w.wd.calls.upload).toBe(uploads);
    expect(posts(w.zoho)).toBe(1);
    expect(folderItems(w.wd, key)).toHaveLength(2);
  });

  it("C: an injected WorkDrive failure at the document upload gives 503 with no CRM write; the retry resumes with exactly two items and one Request", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 503, applied: false });
    const token = link("s2ftestmvht1bepC1");
    const key = uniqueFormKey(verifyLinkToken(token, SECRET));
    const sid = liveSubmissionId("C", "mvht1bep");
    const first = await handleSubmit(buildSubmitRequest({ token, submissionId: sid, answers: syntheticAnswers(), file: syntheticFile() }), { runtime: () => w.rt });
    expect(first.status).toBe(503);
    expect(posts(w.zoho)).toBe(0);
    expect(folderItems(w.wd, key)).toHaveLength(1);
    const second = await handleSubmit(buildSubmitRequest({ token, submissionId: sid, answers: syntheticAnswers(), file: syntheticFile() }), { runtime: () => w.rt });
    expect(second.status).toBe(200);
    const items = folderItems(w.wd, key);
    expect(items).toHaveLength(2);
    expect(items.some((i) => /\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(false);
    expect(posts(w.zoho)).toBe(1);
  });
});
