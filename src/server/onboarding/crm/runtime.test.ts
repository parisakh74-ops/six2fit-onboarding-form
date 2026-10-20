// @vitest-environment node
// Runtime composition through the REAL entry point (`runtimeFromEnv` -> `handleSubmit`): CRM Requests + WorkDrive.
// MOCKS ONLY: MockZoho, MockWorkDrive, a fake read-only Deal reader. No network (global fetch throws).
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { handleSubmit, runtimeFromEnv } from "../http";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { MockWorkDrive } from "../workdrive/mock";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const PRODUCT = "6223361000999000001";
const CONTACT = "6223361000127220001";
const HOST = "https://onboarding-staging.6tofit.com";

let dir: string;
let storage: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-runtime-"));
  storage = join(dir, "storage");
  await mkdir(storage, { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const BASE_ENV = (): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true",
  SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET,
  SIX2FIT_STAGING_STORAGE_DIR: storage,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID,
  SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [] } }),
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
  SIX2FIT_ZOHO_TIMEOUT_MS: "400",
  SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "50",
});
const WD_ENV = (): Record<string, string> => ({
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID,
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
  SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.com/workdrive/api/v1",
  SIX2FIT_WORKDRIVE_CLIENT_ID: "synthetic-wd-client",
  SIX2FIT_WORKDRIVE_CLIENT_SECRET: "synthetic-wd-secret",
  SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "synthetic-wd-refresh",
});

class FakeReader implements CrmDealReader {
  async getDeal(): Promise<DealView> {
    return { id: DEAL_ID, orgId: MOCK_ORG_ID, contactId: CONTACT, productId: PRODUCT, productName: "Synthetic Plan", productRelatedTo: "Fitness and Nutrition" };
  }
  async getContact(): Promise<ContactView> {
    return { id: CONTACT, email: "synthetic@example.invalid", phone: null, mobile: null };
  }
  async hasPriorRequests() {
    return false;
  }
}

const ANSWERS = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
const SID = "11111111-2222-4333-8444-555555555555";

function request(files = 1, sid = SID, answers: Record<string, string> = ANSWERS) {
  const form = new FormData();
  form.append("form_session_token", dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }));
  form.append("submission_id", sid);
  form.append("verification_state", "{}");
  for (const [k, v] of Object.entries(answers)) form.append(`answer:${k}`, v);
  const names = ["MS-05.front", "MS-05.back", "MS-05.side"];
  for (let i = 0; i < files; i += 1) {
    const f = jpegFile(`f${i}.jpg`, 2048 + i * 100);
    form.append(`file:${names[i]}`, new File([f.bytes as BlobPart], f.name, { type: f.type }));
  }
  return new Request(`${HOST}/api/onboarding/submit`, { method: "POST", headers: { "idempotency-key": sid }, body: form });
}

const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;

function runtime(env: Record<string, string>, zoho: MockZoho, wd: MockWorkDrive) {
  const rt = runtimeFromEnv(env, { dealReader: new FakeReader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { runtime: () => rt };
}

const localFiles = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  await walk(storage, "");
  return out;
};

describe("T01 runtime composition (workdrive-key through runtimeFromEnv -> handleSubmit)", () => {
  it("submits through WorkDrive staging and one CRM POST, and never writes an upload to the local disk", async () => {
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    const res = await handleSubmit(request(2), runtime({ ...BASE_ENV(), ...WD_ENV() }, zoho, wd));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });
    const folders = wd.all(ROOT_ID).filter((i) => i.kind === "folder");
    expect(folders).toHaveLength(1);
    const items = wd.all((folders[0] as { id: string }).id).map((i) => i.name);
    expect(items).toContain("submission.v1.json");
    expect(items.filter((n) => n.startsWith("MS-05."))).toHaveLength(2);
    expect(posts(zoho)).toBe(1);
    const local = await localFiles();
    // only the ledger lives locally: no upload, no canonical document
    expect(local.every((f) => f.startsWith("onboarding-ledger/"))).toBe(true);
  });

  it("an identical retry is deduplicated: no second Request, no second upload", async () => {
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    const deps = runtime({ ...BASE_ENV(), ...WD_ENV() }, zoho, wd);
    expect((await handleSubmit(request(1), deps)).status).toBe(200);
    const uploads = wd.calls.upload;
    const again = await handleSubmit(request(1), deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true });
    expect(posts(zoho)).toBe(1);
    expect(wd.calls.upload).toBe(uploads);
  });

  it("raw-field mode keeps the local sink (existing behaviour preserved)", async () => {
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    const res = await handleSubmit(request(1), runtime({ ...BASE_ENV(), SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON" }, zoho, wd));
    expect(res.status).toBe(200);
    expect((await localFiles()).some((f) => !f.startsWith("onboarding-ledger/"))).toBe(true);
    expect(wd.calls.upload).toBe(0);
  });

  it("fails closed with no network call and no write when the WorkDrive configuration is incomplete", async () => {
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    for (const drop of ["SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN", "SIX2FIT_WORKDRIVE_API_BASE", "SIX2FIT_WORKDRIVE_CLIENT_ID", "SIX2FIT_WORKDRIVE_CLIENT_SECRET", "SIX2FIT_WORKDRIVE_REFRESH_TOKEN", "SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID"]) {
      const env = { ...BASE_ENV(), ...WD_ENV() };
      delete env[drop];
      expect(() => runtimeFromEnv(env, { dealReader: new FakeReader() }, { fetch: zoho.fetch, workdriveApi: wd })).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
      const res = await handleSubmit(request(1), { runtime: () => runtimeFromEnv(env, { dealReader: new FakeReader() }, { fetch: zoho.fetch, workdriveApi: wd }) });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error_code: "STAGING_UNAVAILABLE" });
    }
    expect(zoho.requests).toHaveLength(0);
    expect(wd.calls.upload + wd.calls.createFolder + wd.calls.list).toBe(0);
  });

  it("refuses to share the CRM grant with WorkDrive, a cross-DC combination, and a lease shorter than the time budget", () => {
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    const build = (extra: Record<string, string>) => () => runtimeFromEnv({ ...BASE_ENV(), ...WD_ENV(), ...extra }, { dealReader: new FakeReader() }, { fetch: zoho.fetch, workdriveApi: wd });
    expect(build({ SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "synthetic-refresh" })).toThrowError(expect.objectContaining({ code: "WORKDRIVE_GRANT_SHARED" }));
    expect(build({ SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: "https://accounts.zoho.eu", SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.eu/workdrive/api/v1" })).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
    expect(build({ SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.eu/workdrive/api/v1" })).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
    expect(build({ SIX2FIT_WORKDRIVE_API_BASE: "https://evil.example/workdrive/api/v1" })).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
    expect(build({ SIX2FIT_ONBOARDING_LEDGER_LEASE_MS: "30000" })).toThrowError(expect.objectContaining({ code: "LEASE_TOO_SHORT" }));
    expect(build({})).not.toThrow();
  });
});
