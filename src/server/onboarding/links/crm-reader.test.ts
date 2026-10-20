// @vitest-environment node
// T05: read-only CRM reader against a FIXTURE Zoho (shapes per the Zoho CRM v8 API; NOT yet verified on a live Sandbox).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "../crm/mock-zoho";
import { CONSULTATION_SCHEMA, READER_SCHEMA, createCrmReader } from "./crm-reader";
import { CrmReadError } from "./types";

const ENV: Record<string, string> = {
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client",
  SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON",
  SIX2FIT_ZOHO_TIMEOUT_MS: "200",
};
const DEAL = "6223361000127220003";
const CONTACT = "6223361000127220001";
const PRODUCT = "6223361000999000001";

beforeEach(() => void vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); })));
afterEach(() => vi.unstubAllGlobals());

type Handler = (url: URL, method: string) => Response | null;
function crm(handlers: Handler[]) {
  const zoho = new MockZoho();
  const calls: Array<{ method: string; path: string; query: string }> = [];
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const u = new URL(url);
    for (const h of handlers) {
      const r = h(u, init.method);
      if (r) {
        calls.push({ method: init.method, path: u.pathname, query: u.search });
        return r;
      }
    }
    return zoho.fetch(url, init as never);
  }) as never;
  const { reader } = createCrmReader(ENV, { fetch, now: () => Date.now(), sleep: async () => undefined });
  return { reader, calls, json, zoho };
}
const J = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("T05 CRM reader", () => {
  it("reads a Deal and its Contact; the organisation comes from the verified environment, not from the record", async () => {
    const { reader, calls } = crm([
      (u) => (u.pathname === `/crm/v8/Deals/${DEAL}` ? J(200, { data: [{ id: DEAL, Contact_Name: { id: CONTACT, name: "n" }, Product: { id: PRODUCT, name: "Plan" }, Product_Related_to: "Fitness", Persian_Form_Link: null, Created_Time: "2026-10-01T10:00:00+00:00" }] }) : null),
      (u) => (u.pathname === `/crm/v8/Contacts/${CONTACT}` ? J(200, { data: [{ id: CONTACT, Email: "a@example.invalid", Phone: null, Mobile: "+989121234567" }] }) : null),
    ]);
    expect(await reader.getDeal(DEAL)).toEqual({ id: DEAL, orgId: MOCK_ORG_ID, contactId: CONTACT, productId: PRODUCT, productName: "Plan", productRelatedTo: "Fitness", persianFormLink: null, createdAt: "2026-10-01T10:00:00+00:00" });
    expect(await reader.getContact(CONTACT)).toEqual({ id: CONTACT, email: "a@example.invalid", phone: null, mobile: "+989121234567" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("missing records are null (204/400/404), malformed ids are null without a request, ambiguity and bad shapes are unavailable", async () => {
    const { reader, calls } = crm([
      (u) => (u.pathname === `/crm/v8/Deals/${DEAL}` ? J(204, null) : null),
      (u) => (u.pathname === "/crm/v8/Deals/6223361000127220009" ? J(400, { code: "INVALID_DATA", details: { api_name: "id" } }) : null),
      (u) => (u.pathname === "/crm/v8/Deals/6223361000127220012" ? J(400, { code: "INVALID_DATA", details: { api_name: "fields" } }) : null),
      (u) => (u.pathname === "/crm/v8/Deals/6223361000127220010" ? J(200, { data: [{ id: "x" }, { id: "y" }] }) : null),
      (u) => (u.pathname === "/crm/v8/Deals/6223361000127220011" ? J(200, { nope: true }) : null),
    ]);
    expect(await reader.getDeal(DEAL)).toBeNull();
    expect(await reader.getDeal("6223361000127220009")).toBeNull();
    expect(await reader.getDeal("not-an-id")).toBeNull();
    // a configuration defect (unknown selected field) is NOT reported as a missing Deal
    await expect(reader.getDeal("6223361000127220012")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(reader.getDeal("6223361000127220010")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(reader.getDeal("6223361000127220011")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(calls.some((c) => c.path.includes("not-an-id"))).toBe(false);
  });

  it("maps permission, rate-limit, server and transport failures to the reader error codes", async () => {
    const mk = (status: number) => crm([(u) => (u.pathname.startsWith("/crm/v8/Deals/") ? J(status, { code: "X" }) : null)]).reader;
    await expect(mk(403).getDeal(DEAL)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mk(401).getDeal(DEAL)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mk(429).getDeal(DEAL)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(mk(503).getDeal(DEAL)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const t = crm([(u) => { if (u.pathname.startsWith("/crm/v8/Deals/")) throw new TypeError("fetch failed"); return null; }]).reader;
    await expect(t.getDeal(DEAL)).rejects.toBeInstanceOf(CrmReadError);
  });

  it("a token of the wrong organisation is refused before any record is read (environment isolation)", async () => {
    const { reader, calls } = crm([
      (u) => (u.pathname === "/crm/v8/org" ? J(200, { org: [{ id: "6223361000000000999", zgid: "999999999", type: "sandbox" }] }) : null),
      (u) => (u.pathname.startsWith("/crm/v8/Deals/") ? J(200, { data: [{ id: DEAL }] }) : null),
    ]);
    await expect(reader.getDeal(DEAL)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(calls.some((c) => c.path.startsWith("/crm/v8/Deals/"))).toBe(false);
  });

  it("prior-Request and completed-Request checks use bounded searches", async () => {
    const { reader, calls } = crm([
      (u) => (u.pathname === "/crm/v8/Requests/search" && u.searchParams.get("criteria") === `(Contact:equals:${CONTACT})` ? J(200, { data: [{ id: "6223361000127000001" }] }) : null),
      (u) => (u.pathname === "/crm/v8/Requests/search" && u.searchParams.get("criteria") === `(Deal:equals:${DEAL})` ? J(200, { data: [{ id: "1", Form_Completion_Date: null }, { id: "2", Form_Completion_Date: "2026-09-01" }] }) : null),
    ]);
    expect(await reader.hasPriorRequests(CONTACT)).toBe(true);
    expect(await reader.dealHasCompletedRequest(DEAL)).toBe(true);
    expect(calls.every((c) => /per_page=(1|200)\b/.test(c.query))).toBe(true);
  });

  it("consultation candidates are merged, de-duplicated, newest first, bounded, with escaped criteria", async () => {
    const seen: string[] = [];
    const { reader } = crm([
      (u) => {
        if (u.pathname !== "/crm/v8/Consultation_Submissions/search") return null;
        const c = u.searchParams.get("criteria") ?? "";
        seen.push(c);
        const row = (id: string, at: string) => ({ id, Received_At: at, Email: "a@example.invalid", WhatsApp: "+989121234567", Contact: { id: CONTACT }, Onboarding_Prefill_JSON: "{}" });
        if (c.startsWith("(Contact")) return J(200, { data: [row("6223361000127111111", "2026-08-01T00:00:00Z"), row("6223361000127222222", "2026-09-01T00:00:00Z")] });
        if (c.startsWith("(Email")) return J(200, { data: [row("6223361000127222222", "2026-09-01T00:00:00Z")] });
        return J(204, null);
      },
    ]);
    const out = await reader.findConsultationCandidates({ contactId: CONTACT, emails: ["a,b(c)@example.invalid"], phones: ["+989121234567"], limit: 1 });
    expect(out.map((c) => c.id)).toEqual(["6223361000127222222"]);
    expect(seen.some((c) => c.includes("a\\,b\\(c\\)@example.invalid"))).toBe(true);
  });

  it("schema verification asks for ALL fields (not only the used ones), names missing fields and never passes silently", async () => {
    const fieldsOf = (m: string) => (m === "Deals" ? READER_SCHEMA["Deals"]! : m === "Contacts" ? READER_SCHEMA["Contacts"]! : m === "Requests" ? READER_SCHEMA["Requests"]! : CONSULTATION_SCHEMA);
    const queries: string[] = [];
    const answer = (drop: string[]) => (u: URL) => {
      if (u.pathname !== "/crm/v8/settings/fields") return null;
      queries.push(u.search);
      // like Zoho: without type=all the unused fields are NOT returned
      const unused = u.searchParams.get("type") === "all" ? [] : ["Form_Completion_Date", "Persian_Form_Link"];
      return J(200, { fields: fieldsOf(u.searchParams.get("module") ?? "").filter((f) => !drop.includes(f) && !unused.includes(f)).map((api_name) => ({ api_name })) });
    };
    const full = crm([answer([])]);
    expect(await full.reader.verifySchema(true)).toEqual({ ok: true, missing: [] });
    expect(queries.every((q) => q.includes("type=all"))).toBe(true);
    const partial = crm([answer(["Product"])]);
    expect(await partial.reader.verifySchema(false)).toEqual({ ok: false, missing: ["Deals.Product"] });
  });

  it("finds Deals of an order with `equals` on the website field (not the unsupported `contains`) and re-checks the exact URL", async () => {
    const seen: string[] = [];
    const { reader } = crm([
      (u) => {
        if (u.pathname !== "/crm/v8/Deals/search") return null;
        seen.push(u.searchParams.get("criteria") ?? "");
        return J(200, { data: [
          { id: "6223361000127220003", Transaction: "https://shop.example.invalid/checkout/order-pay/17563/?pay_for_order=true&key=wc_order_synthetic" },
          { id: "6223361000127220004", Transaction: "https://shop.example.invalid/checkout/order-pay/175630/?pay_for_order=true" },
        ] });
      },
    ]);
    expect(await reader.findDealIdsByOrder("17563")).toEqual(["6223361000127220003"]);
    expect(seen).toEqual(["(Transaction:equals:/order-pay/17563/)"]);
    expect(await reader.findDealIdsByOrder("../1")).toEqual([]);
  });

  it("uses a dedicated read-only grant when configured and reports a shared grant otherwise", () => {
    expect(createCrmReader(ENV, { fetch: (async () => new Response()) as never }).sharedGrant).toBe(true);
    const dedicated = createCrmReader({ ...ENV, SIX2FIT_ZOHO_READER_CLIENT_ID: "rc", SIX2FIT_ZOHO_READER_CLIENT_SECRET: "rs", SIX2FIT_ZOHO_READER_REFRESH_TOKEN: "rr" }, { fetch: (async () => new Response()) as never });
    expect(dedicated.sharedGrant).toBe(false);
    expect(dedicated.config.refreshToken).toBe("rr");
  });

  it("addresses the Requests module by its configured API name (a renamed custom module keeps e.g. `CustomModule3`)", async () => {
    const zoho = new MockZoho();
    const seen: string[] = [];
    const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
      const u = new URL(url);
      if (u.pathname === "/crm/v8/settings/modules") return J(200, { modules: [{ api_name: "CustomModule3", id: "6223361000127040089" }] });
      if (u.pathname.startsWith("/crm/v8/CustomModule3/search")) { seen.push(u.pathname); return J(204, null); }
      return zoho.fetch(url, init as never);
    }) as never;
    const { reader } = createCrmReader({ ...ENV, SIX2FIT_ONBOARDING_REQUESTS_MODULE: "CustomModule3" }, { fetch, now: () => Date.now(), sleep: async () => undefined });
    expect(await reader.hasPriorRequests(CONTACT)).toBe(false);
    expect(seen).toEqual(["/crm/v8/CustomModule3/search"]);
    // the default name does NOT verify against a module list that only has the original API name (fail closed)
    const wrong = createCrmReader(ENV, { fetch, now: () => Date.now(), sleep: async () => undefined }).reader;
    await expect(wrong.hasPriorRequests(CONTACT)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(() => createCrmReader({ ...ENV, SIX2FIT_ONBOARDING_REQUESTS_MODULE: "../x" }, { fetch })).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
  });
});
