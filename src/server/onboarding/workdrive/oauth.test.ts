// @vitest-environment node
// T03 (data-centre handling) and T02 (WorkDrive OAuth provider). MOCKS ONLY: no network.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../errors";
import { loadCrmConfig } from "../crm/config";
import { assertSameDc, dcOfAccountsDomain, dcOfApiDomain, dcOfSandboxApiDomain, dcOfWorkDriveApiBase } from "../zoho-dc";
import { WdHttpError, WdTokenError } from "./api";
import { loadWorkDriveConfig } from "./config";
import { HttpWorkDriveApi } from "./http-api";
import { FileTokenCache, WorkDriveTokenProvider } from "./token-provider";

const CRM_ENV = (accounts = "https://accounts.zoho.com", api = "https://sandbox.zohoapis.com"): Record<string, string> => ({
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: "850000000",
  SIX2FIT_ZOHO_API_DOMAIN: api,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: accounts,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "c",
  SIX2FIT_ZOHO_CLIENT_SECRET: "s",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "crm-refresh",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: "76a80aad8e6f6764944278234c783ad4a4f95",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: "S2F-ONBOARDING-TEST",
});
const WD_ENV = (accounts = "https://accounts.zoho.com", base = "https://www.zohoapis.com/workdrive/api/v1"): Record<string, string> => ({
  SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: accounts,
  SIX2FIT_WORKDRIVE_API_BASE: base,
  SIX2FIT_WORKDRIVE_CLIENT_ID: "wc",
  SIX2FIT_WORKDRIVE_CLIENT_SECRET: "ws",
  SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "wd-refresh",
});

describe("T03 data-centre handling", () => {
  it("maps every supported accounts host, including Canada's zohocloud.ca (not accounts.zoho.ca)", () => {
    expect(dcOfAccountsDomain("https://accounts.zoho.com")).toBe("com");
    expect(dcOfAccountsDomain("https://accounts.zoho.eu/")).toBe("eu");
    expect(dcOfAccountsDomain("https://accounts.zoho.com.au")).toBe("com.au");
    expect(dcOfAccountsDomain("https://accounts.zohocloud.ca")).toBe("ca");
    expect(dcOfAccountsDomain("https://accounts.zoho.ca")).toBeNull();
    expect(dcOfAccountsDomain("http://accounts.zoho.com")).toBeNull();
    expect(dcOfAccountsDomain("https://accounts.zoho.com.evil.example")).toBeNull();
    expect(dcOfAccountsDomain("https://evil.example/accounts.zoho.com")).toBeNull();
  });

  it("accepts only sandbox / www zohoapis hosts of a supported DC and the exact WorkDrive base path", () => {
    expect(dcOfSandboxApiDomain("https://sandbox.zohoapis.ca")).toBe("ca");
    expect(dcOfSandboxApiDomain("https://www.zohoapis.ca")).toBeNull();
    expect(dcOfWorkDriveApiBase("https://www.zohoapis.in/workdrive/api/v1")).toBe("in");
    expect(dcOfWorkDriveApiBase("https://www.zohoapis.in/workdrive/api/v2")).toBeNull();
    expect(dcOfWorkDriveApiBase("https://workdrive.zoho.com/api/v1")).toBeNull();
    expect(dcOfApiDomain("https://www.zohoapis.com")).toBe("com");
    expect(() => assertSameDc("x", "com", "eu")).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
    expect(() => assertSameDc("x", null, null)).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
  });

  it("CRM config: Canada passes, a US accounts host with a Canadian API host fails closed", () => {
    expect(loadCrmConfig(CRM_ENV("https://accounts.zohocloud.ca", "https://sandbox.zohoapis.ca")).accountsDomain).toBe("https://accounts.zohocloud.ca");
    expect(() => loadCrmConfig(CRM_ENV("https://accounts.zoho.com", "https://sandbox.zohoapis.ca"))).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
    expect(() => loadCrmConfig(CRM_ENV("https://accounts.zoho.ca", "https://sandbox.zohoapis.ca"))).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
  });

  it("WorkDrive config: same-DC combinations pass; cross-DC needs an explicit flag; foreign hosts never pass", () => {
    const crm = loadCrmConfig(CRM_ENV());
    expect(loadWorkDriveConfig({ ...WD_ENV() }, crm).dc).toBe("com");
    const eu = { ...WD_ENV("https://accounts.zoho.eu", "https://www.zohoapis.eu/workdrive/api/v1") };
    expect(() => loadWorkDriveConfig(eu, crm)).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
    expect(loadWorkDriveConfig({ ...eu, SIX2FIT_WORKDRIVE_ALLOW_CROSS_DC: "true" }, crm).dc).toBe("eu");
    expect(() => loadWorkDriveConfig(WD_ENV("https://accounts.zoho.com", "https://www.zohoapis.eu/workdrive/api/v1"), crm)).toThrowError(expect.objectContaining({ code: "DC_MISMATCH" }));
    expect(() => loadWorkDriveConfig(WD_ENV("https://accounts.zoho.com", "https://attacker.example/workdrive/api/v1"), crm)).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
    expect(() => loadWorkDriveConfig({ ...WD_ENV(), SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "crm-refresh" }, crm)).toThrowError(expect.objectContaining({ code: "WORKDRIVE_GRANT_SHARED" }));
  });

  it("configuration errors never contain configured values", () => {
    const crm = loadCrmConfig(CRM_ENV());
    try {
      loadWorkDriveConfig({ ...WD_ENV(), SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "crm-refresh" }, crm);
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/crm-refresh|wd-refresh|wc|ws/);
    }
  });
});

type Reply = { status: number; body: unknown };
function tokenFetch(replies: Reply[], seen: Array<{ url: string; body: string }> = []) {
  const fetch = async (url: string, init: { body: string }) => {
    seen.push({ url, body: init.body });
    const r = replies.shift() ?? { status: 500, body: "" };
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetch, seen };
}
const GOOD = { access_token: "access-1", api_domain: "https://www.zohoapis.com", expires_in: 3600 };
const CFG = { accountsDomain: "https://accounts.zoho.com", clientId: "wc", clientSecret: "ws", refreshToken: "wd-refresh", dc: "com" as const };

describe("T02 WorkDrive token provider", () => {
  it("refreshes against the pinned accounts host and reuses the token until the safety margin", async () => {
    const clock = { t: 1_000_000 };
    const { fetch, seen } = tokenFetch([{ status: 200, body: GOOD }, { status: 200, body: { ...GOOD, access_token: "access-2" } }]);
    const p = new WorkDriveTokenProvider(CFG, { fetch, now: () => clock.t, sleep: async () => undefined });
    expect(await p.accessToken()).toBe("access-1");
    expect(await p.accessToken()).toBe("access-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://accounts.zoho.com/oauth/v2/token");
    clock.t += 3600_000 - 4 * 60_000; // inside the 5-minute safety margin
    expect(await p.accessToken()).toBe("access-2");
    expect(seen).toHaveLength(2);
  });

  it("concurrent callers cause one refresh", async () => {
    const { fetch, seen } = tokenFetch([{ status: 200, body: GOOD }]);
    const p = new WorkDriveTokenProvider(CFG, { fetch, sleep: async () => undefined });
    expect(await Promise.all([p.accessToken(), p.accessToken(), p.accessToken()])).toEqual(["access-1", "access-1", "access-1"]);
    expect(seen).toHaveLength(1);
  });

  it("a refused grant (HTTP 200 with error, or 400) is a definite WD_AUTH_FAILED with no retry and no secret in the message", async () => {
    for (const reply of [{ status: 200, body: { error: "invalid_code" } }, { status: 400, body: { error: "invalid_client" } }]) {
      const { fetch, seen } = tokenFetch([reply]);
      const p = new WorkDriveTokenProvider(CFG, { fetch, sleep: async () => undefined });
      const err = await p.accessToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("WD_AUTH_FAILED");
      expect(String((err as Error).message)).not.toMatch(/wd-refresh|ws|wc/);
      expect(seen).toHaveLength(1);
    }
  });

  it("transport failures and 5xx are retried a bounded number of times, then reported as unreachable", async () => {
    const { fetch, seen } = tokenFetch([{ status: 503, body: "" }, { status: 502, body: "" }, { status: 500, body: "" }]);
    const p = new WorkDriveTokenProvider(CFG, { fetch, sleep: async () => undefined });
    await expect(p.accessToken()).rejects.toMatchObject({ code: "WD_TOKEN_TRANSPORT" });
    expect(seen).toHaveLength(3);
    const ok = tokenFetch([{ status: 503, body: "" }, { status: 200, body: GOOD }]);
    expect(await new WorkDriveTokenProvider(CFG, { fetch: ok.fetch, sleep: async () => undefined }).accessToken()).toBe("access-1");
  });

  it("refuses a token that belongs to another data centre", async () => {
    const { fetch } = tokenFetch([{ status: 200, body: { ...GOOD, api_domain: "https://www.zohoapis.eu" } }]);
    await expect(new WorkDriveTokenProvider(CFG, { fetch, sleep: async () => undefined }).accessToken()).rejects.toMatchObject({ code: "DC_MISMATCH" });
  });

  it("the optional file cache is shared between providers and holds only the short-lived token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s2f-wdcache-"));
    try {
      const a = tokenFetch([{ status: 200, body: GOOD }]);
      const b = tokenFetch([]);
      const pa = new WorkDriveTokenProvider(CFG, { fetch: a.fetch, cache: new FileTokenCache(dir, "wc:wd-refresh") });
      const pb = new WorkDriveTokenProvider(CFG, { fetch: b.fetch, cache: new FileTokenCache(dir, "wc:wd-refresh") });
      expect(await pa.accessToken()).toBe("access-1");
      expect(await pb.accessToken()).toBe("access-1");
      expect(b.seen).toHaveLength(0); // the second worker did not refresh
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const raw = await readFile(join(dir, files[0] as string), "utf8");
      expect(raw).not.toMatch(/wd-refresh|ws/); // no refresh token or client secret on disk
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("HttpWorkDriveApi token handling", () => {
  const ok = (data: unknown) => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({ data }) });
  const item = { id: "a".repeat(30), attributes: { name: "x", parent_id: "p", type: "folder" } };

  it("a token failure is DEFINITE (never ambiguous): the request was not sent", async () => {
    let sent = 0;
    const api = new HttpWorkDriveApi({ fetch: async () => (sent++, ok(item)), accessToken: async () => { throw new StoreError("UNAVAILABLE", "x", "WD_AUTH_FAILED"); }, baseUrl: "https://api.invalid" });
    const err = await api.getItem("a".repeat(30)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WdTokenError);
    expect((err as WdHttpError).status).toBe(401);
    expect((err as WdHttpError).ambiguous).toBe(false);
    const down = new HttpWorkDriveApi({ fetch: async () => (sent++, ok(item)), accessToken: async () => { throw new StoreError("UNAVAILABLE", "x", "WD_TOKEN_TRANSPORT"); }, baseUrl: "https://api.invalid" });
    const e2 = (await down.getItem("a".repeat(30)).catch((e: unknown) => e)) as WdHttpError;
    expect(e2.status).toBe(503);
    expect(e2.ambiguous).toBe(false);
    expect(sent).toBe(0);
  });

  it("a 401 invalidates the token and retries exactly once", async () => {
    const tokens = ["old", "new"];
    const used: string[] = [];
    const invalidated: string[] = [];
    let i = 0;
    const api = new HttpWorkDriveApi({
      fetch: async (_u, init) => {
        used.push(String(init?.headers?.["Authorization"]));
        return used.length === 1 ? { status: 401, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) } : ok(item);
      },
      accessToken: async () => tokens[Math.min(i++, 1)] as string,
      invalidateToken: (t) => invalidated.push(t),
      baseUrl: "https://api.invalid",
    });
    expect((await api.getItem("a".repeat(30))).id).toBe("a".repeat(30));
    expect(used).toEqual(["Zoho-oauthtoken old", "Zoho-oauthtoken new"]);
    expect(invalidated).toEqual(["old"]);
    // a second consecutive 401 is reported, not retried forever
    let calls = 0;
    const stuck = new HttpWorkDriveApi({ fetch: async () => (calls++, { status: 401, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }), accessToken: async () => "t", invalidateToken: () => undefined, baseUrl: "https://api.invalid" });
    await expect(stuck.getItem("a".repeat(30))).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(2);
  });
});
