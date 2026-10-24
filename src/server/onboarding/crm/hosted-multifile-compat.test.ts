// @vitest-environment node
// The HOSTED request (hostedMultiFileRequest) accepted by the REAL server logic against mocks: proves the hosted smoke test sends
// something the activated application can process (token, scope, entitlements, product map, seven files). Not live evidence.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSubmit, runtimeFromEnv } from "../http";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { MockWorkDrive } from "../workdrive/mock";
import { hostedMultiFileRequest } from "./hosted-fixtures";
import { LIVE_EMAIL } from "./live-fixtures";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const DEAL = "6223361000127334002";
const PRODUCT = "6223361000127336001";
const CONTACT = "6223361000127337001";
const SECRET = "hosted-compat-secret-0123456789abcdef0123456789";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-hosted-compat-"));
  await mkdir(dir, { recursive: true });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const env = (map: unknown): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true", SIX2FIT_ONBOARDING_STORE: "crm", SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID, SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify(map),
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
const world = (map: unknown) => {
  const zoho = new MockZoho();
  const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const rt = runtimeFromEnv(env(map), { dealReader: new Reader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { zoho, wd, rt };
};
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;

describe("hosted smoke-test request against the real server logic (mocks)", () => {
  it("with the Combo + cellulite product map: 200 completed, 7 files + document, ONE Request; the identical replay is deduplicated with no new write", async () => {
    const w = world({ [PRODUCT]: { scope: "Combo", entitlements: ["cellulite"] } });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const m = hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp: "compat01", nowSeconds });
    const res = await handleSubmit(m.request, { runtime: () => w.rt });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });
    const folder = w.wd.all(ROOT_ID).filter((i) => i.kind === "folder" && i.name === m.formKey);
    expect(folder).toHaveLength(1);
    expect(w.wd.all((folder[0] as { id: string }).id)).toHaveLength(8);
    expect(posts(w.zoho)).toBe(1);

    const uploads = w.wd.calls.upload;
    const again = hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp: "compat01", nowSeconds });
    expect(again.token).toBe(m.token);
    const res2 = await handleSubmit(again.request, { runtime: () => w.rt });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ deduplicated: true });
    expect(w.wd.calls.upload).toBe(uploads);
    expect(posts(w.zoho)).toBe(1);
  });

  it("documents the dependency: without the cellulite entitlement in the product map (or with no map at all) the hosted request is refused and nothing is written", async () => {
    for (const map of [{ [PRODUCT]: { scope: "Combo", entitlements: [] } }, {}]) {
      const w = world(map);
      const m = hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp: "compat02" });
      const res = await handleSubmit(m.request, { runtime: () => w.rt });
      expect(res.status).toBe(403);
      expect(posts(w.zoho)).toBe(0);
      expect(w.wd.calls.upload + w.wd.calls.createFolder).toBe(0);
    }
  });
});
