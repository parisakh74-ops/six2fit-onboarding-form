// @vitest-environment node
// Explicit `sandbox` / `production` support of the CRM configuration and the environment guard. MOCKS ONLY: no network, no Zoho.
import { describe, expect, it } from "vitest";
import { buildEmailDelivery } from "../payments/email-runtime";
import { ZohoClient } from "./client";
import { loadCrmConfig, PRODUCTION_ID_PREFIX } from "./config";

const SANDBOX: Record<string, string> = {
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true", SIX2FIT_ZOHO_ENVIRONMENT: "sandbox", SIX2FIT_ZOHO_ORG_ZGID: "850673613",
  SIX2FIT_ZOHO_API_DOMAIN: "https://sandbox.zohoapis.com", SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: "https://accounts.zoho.com",
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000", SIX2FIT_ZOHO_CLIENT_ID: "c", SIX2FIT_ZOHO_CLIENT_SECRET: "s", SIX2FIT_ZOHO_REFRESH_TOKEN: "r",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key", SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: "76a80aad8e6f6764944278234c783ad4a4f95", SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: "S2F-ONBOARDING-TEST",
};
const PROD: Record<string, string> = {
  ...SANDBOX, SIX2FIT_ZOHO_ENVIRONMENT: "production", SIX2FIT_ZOHO_ORG_ZGID: "600000001", SIX2FIT_ZOHO_ORG_API_ID: "6067417000000000684",
  SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.com", SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6067417000",
};
const without = (e: Record<string, string>, k: string) => { const c = { ...e }; delete c[k]; return c; };
const reject = (env: Record<string, string>) => { try { loadCrmConfig(env); } catch (e) { return (e as { kind?: string }).kind === "NOT_CONFIGURED"; } return false; };

describe("configuration: explicit environment", () => {
  it("accepts a valid Sandbox configuration and carries 'sandbox'", () => {
    expect(loadCrmConfig(SANDBOX).environment).toBe("sandbox");
    expect(loadCrmConfig({ ...SANDBOX, SIX2FIT_ZOHO_ORG_API_ID: "6223361000000000999" }).environment).toBe("sandbox");
  });
  it("accepts a valid Production configuration and carries 'production' (not a hard-coded 'sandbox')", () => {
    const c = loadCrmConfig(PROD);
    expect(c.environment).toBe("production");
    expect(c.apiDomain).toBe("https://www.zohoapis.com");
    expect(c.moduleIdPrefix).toBe(PRODUCTION_ID_PREFIX);
    expect(c.triggerAutomations).toBe(false); // workflows stay suppressed unless explicitly approved
  });
  it("has NO default environment: missing, blank, mixed-up or unknown values are refused", () => {
    expect(reject(without(PROD, "SIX2FIT_ZOHO_ENVIRONMENT"))).toBe(true);
    for (const v of ["", "prod", "live", "developer", "sandbox,production"]) expect(reject({ ...PROD, SIX2FIT_ZOHO_ENVIRONMENT: v })).toBe(true);
  });
  it("Sandbox rejects the Production host, prefix, org api id", () => {
    expect(reject({ ...SANDBOX, SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.com" })).toBe(true);
    expect(reject({ ...SANDBOX, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6067417000" })).toBe(true);
    expect(reject({ ...SANDBOX, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "60674170001234" })).toBe(true);
    expect(reject({ ...SANDBOX, SIX2FIT_ZOHO_ORG_API_ID: "6067417000000000684" })).toBe(true);
  });
  it("Production rejects the Sandbox host, prefix, org api id and a missing org api id", () => {
    expect(reject({ ...PROD, SIX2FIT_ZOHO_API_DOMAIN: "https://sandbox.zohoapis.com" })).toBe(true);
    expect(reject({ ...PROD, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000" })).toBe(true);
    expect(reject({ ...PROD, SIX2FIT_ZOHO_ORG_API_ID: "6223361000000000999" })).toBe(true);
    expect(reject(without(PROD, "SIX2FIT_ZOHO_ORG_API_ID"))).toBe(true);
    expect(reject(without(PROD, "SIX2FIT_ZOHO_ORG_ZGID"))).toBe(true);
  });
  it("rejects host paths, other schemes, mismatched data centres and an unlisted accounts domain", () => {
    expect(reject({ ...PROD, SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.com/crm" })).toBe(true);
    expect(reject({ ...PROD, SIX2FIT_ZOHO_API_DOMAIN: "http://www.zohoapis.com" })).toBe(true);
    expect(reject({ ...PROD, SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.eu" })).toBe(true); // accounts .com vs api .eu
    expect(reject({ ...PROD, SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: "https://accounts.example.com" })).toBe(true);
  });
  it("error messages never contain configured values", () => {
    let message = "";
    try { loadCrmConfig({ ...PROD, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000", SIX2FIT_ZOHO_CLIENT_SECRET: "super-secret-value" }); } catch (e) { message = String((e as Error).message); }
    expect(message).not.toContain("super-secret-value");
    expect(message).not.toContain("6223361000");
  });
});

// A minimal Zoho mock whose hosts and org identity are configurable; records every call so writes can be ruled out.
function zoho(opts: { orgType?: string; zgid?: string; apiId?: string; moduleId?: string; tokenApiDomain?: string; apiOrigin: string; accountsOrigin?: string }) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: `${u.origin}${u.pathname}` });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.origin === (opts.accountsOrigin ?? "https://accounts.zoho.com") && u.pathname === "/oauth/v2/token") return json(200, { access_token: "t", api_domain: opts.tokenApiDomain ?? "https://www.zohoapis.com", expires_in: 3600 });
    if (u.origin !== opts.apiOrigin) return json(404, {});
    if (u.pathname === "/crm/v8/org") return json(200, { org: [{ id: opts.apiId ?? "6067417000000000684", zgid: opts.zgid ?? "600000001", type: opts.orgType ?? "production" }] });
    if (u.pathname === "/crm/v8/settings/modules") return json(200, { modules: [{ api_name: "Requests", id: opts.moduleId ?? "6067417000000123456" }] });
    return json(404, {});
  };
  return { calls, fetch: fetch as never };
}
const client = (env: Record<string, string>, z: ReturnType<typeof zoho>) => new ZohoClient(loadCrmConfig(env), { fetch: z.fetch, now: () => 1_000_000, sleep: async () => undefined });
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string; kind?: string }).code ?? (e as { kind?: string }).kind ?? "ERR"; } };

describe("environment guard (production, mocks only)", () => {
  it("verifies org identity, type and module prefix with GET requests to the Production host only; nothing is written", async () => {
    const z = zoho({ apiOrigin: "https://www.zohoapis.com" });
    await client(PROD, z).verifyEnvironment();
    expect(z.calls.every((c) => c.method === "GET" || c.url.endsWith("/oauth/v2/token"))).toBe(true);
    expect(z.calls.filter((c) => c.method === "POST" && !c.url.endsWith("/oauth/v2/token"))).toHaveLength(0);
    expect(z.calls.every((c) => c.url.startsWith("https://www.zohoapis.com") || c.url.startsWith("https://accounts.zoho.com"))).toBe(true);
    expect(z.calls.some((c) => c.url.includes("sandbox"))).toBe(false);
  });
  it("refuses a Sandbox organisation, a wrong zgid, a wrong api id, a Sandbox-prefixed module id", async () => {
    for (const bad of [{ orgType: "sandbox" }, { zgid: "111111111" }, { apiId: "6067417000000009999" }, { apiId: "6223361000000000999" }, { moduleId: "6223361000000123456" }]) {
      const z = zoho({ apiOrigin: "https://www.zohoapis.com", ...bad });
      expect(await code(client(PROD, z).verifyEnvironment())).toBe("ENV_MISMATCH");
    }
  });
  it("refuses a token whose api_domain is a Sandbox host or another data centre (no fallback)", async () => {
    for (const tokenApiDomain of ["https://sandbox.zohoapis.com", "https://www.zohoapis.eu", "https://www.zohoapis.com.evil.example"]) {
      const z = zoho({ apiOrigin: "https://www.zohoapis.com", tokenApiDomain });
      const c = client(PROD, z);
      expect(await code(c.verifyEnvironment())).toBe("ENV_MISMATCH");
      expect(await code(c.verifyEnvironment())).toBe("ENV_MISMATCH"); // still refused: a failed verification is never cached
    }
  });
  it("a Production-typed organisation behind a Sandbox configuration is refused, and a Sandbox organisation behind Production too", async () => {
    const sb = zoho({ apiOrigin: "https://sandbox.zohoapis.com", tokenApiDomain: "https://www.zohoapis.com", orgType: "production", zgid: "850673613", apiId: "6223361000000000999", moduleId: "6223361000000123456" });
    expect(await code(client(SANDBOX, sb).verifyEnvironment())).toBe("ENV_MISMATCH");
    const ok = zoho({ apiOrigin: "https://sandbox.zohoapis.com", tokenApiDomain: "https://www.zohoapis.com", orgType: "sandbox", zgid: "850673613", apiId: "6223361000000000999", moduleId: "6223361000000123456" });
    expect(await code(client(SANDBOX, ok).verifyEnvironment())).toBe("OK");
  });
  it("a Sandbox organisation api id carrying the Production prefix is refused even if the pin is unset", async () => {
    const z = zoho({ apiOrigin: "https://sandbox.zohoapis.com", orgType: "sandbox", zgid: "850673613", apiId: "6067417000000000684", moduleId: "6223361000000123456" });
    expect(await code(client(SANDBOX, z).verifyEnvironment())).toBe("ENV_MISMATCH");
  });
});

describe("invitations stay off in Production", () => {
  it("refuses e-mail delivery configured against a Production environment", () => {
    const env = { ...PROD, SIX2FIT_EMAIL_DELIVERY_MODE: "crm-send-mail", SIX2FIT_EMAIL_FROM: "a@example.invalid", SIX2FIT_EMAIL_FROM_NAME: "x", SIX2FIT_EMAIL_ALLOWED_RECIPIENTS: "b@example.invalid", SIX2FIT_ZOHO_MAILER_CLIENT_ID: "m", SIX2FIT_ZOHO_MAILER_CLIENT_SECRET: "m", SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN: "mr", SIX2FIT_FORM_BASE_URL: "https://onboarding.example.com" };
    expect(() => buildEmailDelivery(env)).toThrow();
  });
});
