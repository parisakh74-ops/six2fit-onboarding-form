/**
 * Deterministic in-memory MOCK of the parts of the Zoho CRM v8 API the adapter uses. Test support only:
 * it contacts nothing. Its behaviour (error shapes, duplicate response, 204 on empty search) is modelled
 * on the Zoho documentation and is NOT verified Zoho behaviour; the CA Dev API tests will confirm it.
 */
import type { FetchLike } from "./client";

/** Synthetic identifiers shaped like the observed CA Dev contract: UI "Org ID" = API zgid; API id is another number. */
export const MOCK_ORG_ID = "850000000";
export const MOCK_ORG_API_ID = "6223361000000000999";
export const MOCK_MODULE_ID = "6223361000127040089";
export const MOCK_API_DOMAIN = "https://sandbox.zohoapis.com";
export const MOCK_ACCOUNTS_DOMAIN = "https://accounts.zoho.com";

type Fault =
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "garbage"; status?: number }
  /** The write is applied, then the response is lost (timeout). */
  | { kind: "persist-then-timeout" }
  | { kind: "persist-then-status"; status: number };

export type MockRecord = Record<string, unknown> & { id: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class MockZoho {
  records: MockRecord[] = [];
  triggerModes: Array<"suppressed" | "workflows-run"> = [];
  requests: Array<{ method: string; path: string; auth: boolean; query: string }> = [];
  faults: Array<{ match: RegExp; method?: string; fault: Fault; times: number }> = [];
  tokenCalls = 0;
  validTokens = new Set<string>();
  orgId = MOCK_ORG_ID; // the zgid
  orgApiId = MOCK_ORG_API_ID;
  moduleId = MOCK_MODULE_ID;
  orgType = "sandbox";
  /** Observed: a Sandbox grant returns the generic host. */
  tokenApiDomain = "https://www.zohoapis.com";
  /**
   * Reproduces the OBSERVED CA Dev behaviour: the uniqueness check and the commit are not atomic, so concurrent
   * identical inserts all succeed (L8). The check happens first; the commit follows after a macrotask.
   */
  nonAtomicInsert = false;
  /** Reproduces the observed search index lag (HTTP 204 for records that exist). GET by id is unaffected. */
  searchLag = false;
  /** Field length limit in characters (text 255, textarea fields 2000, raw 32000). */
  private nextId = 6223361000127060100n;
  /** Zoho counts characters; the mock uses code points. */
  rawLimit = 32_000;

  failNext(match: RegExp, fault: Fault, times = 1, method?: string) {
    this.faults.push({ match, fault, times, ...(method ? { method } : {}) });
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method;
    const header = init.headers["authorization"] ?? "";
    const auth = header.startsWith("Zoho-oauthtoken ");
    const tokenOk = auth && this.validTokens.has(header.replace("Zoho-oauthtoken ", ""));
    this.requests.push({ method, path, auth, query: u.search });

    // Faults first (token endpoint included).
    for (const f of this.faults) {
      if (f.times > 0 && f.match.test(path) && (!f.method || f.method === method)) {
        f.times -= 1;
        const fault = f.fault;
        if (fault.kind === "timeout") return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        if (fault.kind === "network") throw new TypeError("fetch failed");
        if (fault.kind === "status") return fault.status === 204 ? new Response(null, { status: 204 }) : json(fault.status, fault.body ?? {}, fault.headers);
        if (fault.kind === "garbage") return new Response("<html>not json</html>", { status: fault.status ?? 200 });
        if (fault.kind === "persist-then-timeout" || fault.kind === "persist-then-status") {
          this.handle(u, init, method, tokenOk);
          if (fault.kind === "persist-then-status") return json(fault.status, { message: "boom" });
          return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
      }
    }
    if (this.nonAtomicInsert && tokenOk && method === "POST" && u.pathname === "/crm/v8/Requests") {
      const staged = this.stageInsert(init.body ?? "");
      if (typeof staged !== "function") return staged;
      await new Promise((r) => setTimeout(r, 5));
      return staged();
    }
    return this.handle(u, init, method, tokenOk);
  };

  private handle(u: URL, init: { headers: Record<string, string>; body?: string }, method: string, tokenOk: boolean): Response {
    const path = u.pathname;
    if (u.origin === MOCK_ACCOUNTS_DOMAIN && path === "/oauth/v2/token") {
      this.tokenCalls += 1;
      const form = new URLSearchParams(init.body ?? "");
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== "synthetic-refresh") {
        return json(400, { error: "invalid_code" });
      }
      const token = `synthetic-access-${this.tokenCalls}`;
      this.validTokens.add(token);
      return json(200, { access_token: token, api_domain: this.tokenApiDomain, token_type: "Bearer", expires_in: 3600 });
    }
    if (u.origin !== MOCK_API_DOMAIN) return json(404, { code: "NOT_FOUND" });
    if (!tokenOk) return json(401, { code: "INVALID_TOKEN", message: "invalid oauth token", status: "error" });

    if (method === "GET" && path === "/crm/v8/org") return json(200, { org: [{ id: this.orgApiId, zgid: this.orgId, type: this.orgType, company_name: "Synthetic Org" }] });
    if (method === "GET" && path === "/crm/v8/settings/modules") {
      return json(200, { modules: [{ api_name: "Leads", id: "6223361000000002375" }, { api_name: "Requests", id: this.moduleId }] });
    }
    if (method === "POST" && path === "/crm/v8/Requests") return this.insert(init.body ?? "");
    if (method === "GET" && path === "/crm/v8/Requests/search") {
      const m = /^\(uniqueformkey:equals:(.+)\)$/.exec(u.searchParams.get("criteria") ?? "");
      // Zoho documents `equals` in search as contains-like: the mock reproduces that.
      const hit = m && !this.searchLag ? this.records.filter((r) => String(r["uniqueformkey"]).includes(m[1] as string)) : [];
      if (hit.length === 0) return new Response(null, { status: 204 });
      return json(200, { data: hit.map((r) => ({ id: r.id, uniqueformkey: r["uniqueformkey"] })), info: { count: hit.length } });
    }
    const byId = /^\/crm\/v8\/Requests\/(\d+)$/.exec(path);
    if (method === "GET" && byId) {
      const rec = this.records.find((r) => r.id === byId[1]);
      if (!rec) return json(404, { code: "INVALID_DATA", status: "error" });
      return json(200, { data: [rec] });
    }
    return json(400, { code: "INVALID_URL_PATTERN", status: "error" });
  }

  private insert(raw: string): Response {
    const staged = this.stageInsert(raw);
    return typeof staged === "function" ? staged() : staged;
  }

  /** Validation and uniqueness check now; the returned function commits the record. */
  private stageInsert(raw: string): Response | (() => Response) {
    let body: { data?: Array<Record<string, unknown>>; trigger?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { code: "INVALID_REQUEST", status: "error" });
    }
    const data = body.data;
    if (!Array.isArray(data) || data.length !== 1) return json(400, { code: "INVALID_DATA", status: "error" });
    const rec = data[0] as Record<string, unknown>;
    const invalid = (field: string) => json(400, { data: [{ code: "INVALID_DATA", details: { api_name: field }, message: "invalid data", status: "error" }] });

    const sid = rec["uniqueformkey"];
    if (typeof sid !== "string" || sid === "") return json(400, { data: [{ code: "MANDATORY_NOT_FOUND", details: { api_name: "uniqueformkey" }, status: "error" }] });
    for (const [k, v] of Object.entries(rec)) {
      if (typeof v === "string") {
        const cps = [...v].length;
        const limit = k === "Onboarding_Raw_JSON" ? this.rawLimit : k === "Email" ? 100 : 255;
        if (cps > limit) return invalid(k);
      }
    }
    // `trigger: []` suppresses workflows; an absent `trigger` lets them run (recorded in `triggerModes`).
    if (body.trigger !== undefined && (!Array.isArray(body.trigger) || (body.trigger as unknown[]).length !== 0)) {
      return json(400, { code: "INVALID_DATA", details: { api_name: "trigger" }, status: "error" });
    }
    this.triggerModes.push(body.trigger === undefined ? "workflows-run" : "suppressed");
    const existing = this.records.find((r) => r["uniqueformkey"] === sid);
    if (existing) {
      return json(400, { data: [{ code: "DUPLICATE_DATA", details: { api_name: "uniqueformkey", id: existing.id }, message: "duplicate data", status: "error" }] });
    }
    return () => {
      const id = String(this.nextId++);
      this.records.push({ ...rec, id, Created_Time: "2026-10-12T10:00:00+00:00" });
      return json(201, { data: [{ code: "SUCCESS", details: { id, Created_Time: "2026-10-12T10:00:00+00:00" }, message: "record added", status: "success" }] });
    };
  }
}
