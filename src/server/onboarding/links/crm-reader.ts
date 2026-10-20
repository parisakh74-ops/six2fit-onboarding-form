import { StoreError } from "../errors";
import { ZohoClient, ZohoTransportError, INVALID, type ClientDeps, type ZohoResponse } from "../crm/client";
import { loadCrmConfig, type CrmConfig } from "../crm/config";
import { CrmReadError, type ConsultationCandidate, type ContactView, type CrmDealReader, type DealView } from "./types";

/**
 * READ-ONLY Zoho CRM reader behind the `CrmDealReader` port (Deal, Contact, prior Requests, Consultation prefill candidates).
 * It can only issue GET requests (the client method is typed `"GET" | "POST"` but this class never passes POST) and
 * it reuses the environment guard of `ZohoClient.verifyEnvironment` (organisation zgid + sandbox type + module id prefix),
 * so a token of another organisation can never read here. Nothing returned by this class is written anywhere.
 *
 * Field names (STANDARD Zoho names unless marked): Deals `Contact_Name`, `Product` (custom lookup, per the 2026-10-18 discovery),
 * `Product_Related_to`, `Persian_Form_Link`, `Created_Time`; Contacts `Email`, `Phone`, `Mobile`; Requests `Contact`, `Deal`,
 * `Form_Completion_Date`; Consultation_Submissions `Contact`, `Email`, `WhatsApp`, `Received_At`, `Onboarding_Prefill_JSON`.
 * They are NOT yet confirmed against a live Sandbox read: `verifySchema()` (used by the readiness probe) checks them
 * against `GET /settings/fields` and fails closed when one is missing.
 */
const ID = /^\d{6,25}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const lookupId = (v: unknown): string | null => (isObj(v) && typeof v["id"] === "string" && ID.test(v["id"]) ? v["id"] : null);
/** Zoho search criteria: escape the reserved characters of a value. */
const crit = (v: string): string => v.replace(/([\\(),])/g, "\\$1");

export const READER_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  Deals: ["Contact_Name", "Product", "Product_Related_to", "Persian_Form_Link"],
  Contacts: ["Email", "Phone", "Mobile"],
  Requests: ["Contact", "Deal", "Form_Completion_Date", "uniqueformkey"],
};
export const CONSULTATION_MODULE = "Consultation_Submissions";
export const CONSULTATION_SCHEMA: readonly string[] = ["Contact", "Email", "WhatsApp", "Onboarding_Prefill_JSON"];

export class ZohoCrmReader implements CrmDealReader {
  constructor(
    private readonly client: ZohoClient,
    private readonly orgZgid: string,
    /** API name of the module displayed as "Requests" (a renamed custom module keeps its original API name, e.g. `CustomModule3`). */
    private readonly requestsModule = "Requests",
  ) {}

  private async get(path: string, query?: Record<string, string>): Promise<ZohoResponse> {
    try {
      await this.client.verifyEnvironment();
      const res = await this.client.request("GET", path, query ? { query } : {});
      this.classify(res);
      return res;
    } catch (e) {
      throw this.toReadError(e);
    }
  }

  private toReadError(e: unknown): CrmReadError {
    if (e instanceof CrmReadError) return e;
    if (e instanceof ZohoTransportError) return new CrmReadError("UNAVAILABLE");
    if (e instanceof StoreError) {
      if (e.kind === "NOT_CONFIGURED") return new CrmReadError("NOT_CONFIGURED");
      if (e.code === "AUTH_FAILED" || e.code === "FORBIDDEN" || e.code === "SCOPE_MISSING") return new CrmReadError("FORBIDDEN");
    }
    return new CrmReadError("UNAVAILABLE");
  }

  private classify(res: ZohoResponse): void {
    const s = res.status;
    if (s === 401 || s === 403) throw new CrmReadError("FORBIDDEN");
    if (s === 204 || (s >= 200 && s < 300)) return;
    // 404, or 400 INVALID_DATA about the record `id` itself, mean "no such record". Any other 400 (e.g. an unknown field in
    // `fields`, a wrong module) is a configuration defect and must NOT look like a missing Deal: it is "unavailable" (fail closed).
    if (s === 404) return;
    if (s === 400 && isObj(res.json) && res.json["code"] === "INVALID_DATA" && isObj(res.json["details"]) && (res.json["details"] as Record<string, unknown>)["api_name"] === "id") return;
    throw new CrmReadError("UNAVAILABLE");
  }

  private list(res: ZohoResponse): Array<Record<string, unknown>> {
    if (res.status === 204 || res.status === 404 || (res.status === 400 && isObj(res.json) && res.json["code"] === "INVALID_DATA" && isObj(res.json["details"]) && (res.json["details"] as Record<string, unknown>)["api_name"] === "id")) return [];
    const j = res.json;
    if (j === INVALID || !isObj(j) || !Array.isArray(j["data"])) throw new CrmReadError("UNAVAILABLE");
    return (j["data"] as unknown[]).filter(isObj);
  }

  async getDeal(dealId: string): Promise<DealView | null> {
    if (!ID.test(dealId)) return null;
    const rows = this.list(await this.get(`/Deals/${dealId}`, { fields: "id,Contact_Name,Product,Product_Related_to,Persian_Form_Link,Created_Time" }));
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new CrmReadError("UNAVAILABLE");
    const r = rows[0] as Record<string, unknown>;
    if (r["id"] !== dealId) return null;
    const product = isObj(r["Product"]) ? r["Product"] : null;
    return {
      id: dealId,
      orgId: this.orgZgid, // proven by verifyEnvironment on this very client
      contactId: lookupId(r["Contact_Name"]),
      productId: lookupId(product),
      productName: product ? str(product["name"]) : null,
      productRelatedTo: str(r["Product_Related_to"]),
      persianFormLink: str(r["Persian_Form_Link"]),
      createdAt: str(r["Created_Time"]),
    };
  }

  async getContact(contactId: string): Promise<ContactView | null> {
    if (!ID.test(contactId)) return null;
    const rows = this.list(await this.get(`/Contacts/${contactId}`, { fields: "id,Email,Phone,Mobile" }));
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new CrmReadError("UNAVAILABLE");
    const r = rows[0] as Record<string, unknown>;
    if (r["id"] !== contactId) return null;
    return { id: contactId, email: str(r["Email"]), phone: str(r["Phone"]), mobile: str(r["Mobile"]) };
  }

  async hasPriorRequests(contactId: string): Promise<boolean> {
    if (!ID.test(contactId)) throw new CrmReadError("UNAVAILABLE");
    return this.list(await this.get(`/${this.requestsModule}/search`, { criteria: `(Contact:equals:${contactId})`, fields: "id", per_page: "1" })).length > 0;
  }

  async dealHasCompletedRequest(dealId: string): Promise<boolean> {
    if (!ID.test(dealId)) throw new CrmReadError("UNAVAILABLE");
    const rows = this.list(await this.get(`/${this.requestsModule}/search`, { criteria: `(Deal:equals:${dealId})`, fields: "id,Form_Completion_Date", per_page: "200" }));
    return rows.some((r) => str(r["Form_Completion_Date"]) !== null);
  }

  /**
   * Deals whose `Transaction` (the WooCommerce order-pay URL written by the order function) names this order. The CRM has no
   * dedicated order-id field yet (CRM-CHG-004 is a proposal), so the URL is matched exactly client-side; the URL (which carries an
   * order key) is read in memory only and never logged or stored. Several Deals can claim one order (legacy re-fire): the caller decides.
   * `Transaction` is a WEBSITE field: Zoho's search supports only equals / not_equal / starts_with / in for it (`contains` is not
   * listed); the documented `equals` behaves like "contains", and the exact URL is re-checked client-side below.
   */
  async findDealIdsByOrder(orderId: string): Promise<string[]> {
    if (!/^[1-9]\d{0,11}$/.test(orderId)) return [];
    const needle = `/order-pay/${orderId}/`;
    const rows = this.list(await this.get("/Deals/search", { criteria: `(Transaction:equals:${crit(needle)})`, fields: "id,Transaction", per_page: "50" }));
    return [...new Set(rows.filter((r) => typeof r["Transaction"] === "string" && (r["Transaction"] as string).includes(needle)).map((r) => (typeof r["id"] === "string" && ID.test(r["id"]) ? r["id"] : "")).filter(Boolean))];
  }

  async findContactIdsByPhone(phone: string): Promise<string[]> {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 20) return [];
    const rows = this.list(await this.get("/Contacts/search", { phone: digits, fields: "id", per_page: "200" }));
    return [...new Set(rows.map((r) => (typeof r["id"] === "string" && ID.test(r["id"]) ? r["id"] : "")).filter(Boolean))];
  }

  async findConsultationCandidates(q: { contactId: string; emails: string[]; phones: string[]; limit: number }): Promise<ConsultationCandidate[]> {
    const criteria: string[] = [];
    if (ID.test(q.contactId)) criteria.push(`(Contact:equals:${q.contactId})`);
    for (const e of q.emails.slice(0, 3)) criteria.push(`(Email:equals:${crit(e)})`);
    for (const p of q.phones.slice(0, 3)) criteria.push(`(WhatsApp:equals:${crit(p)})`);
    const seen = new Map<string, ConsultationCandidate>();
    for (const c of criteria) {
      const rows = this.list(await this.get(`/${CONSULTATION_MODULE}/search`, { criteria: c, fields: "id,Contact,Email,WhatsApp,Received_At,Created_Time,Onboarding_Prefill_JSON", per_page: String(Math.min(Math.max(q.limit, 1), 50)) }));
      for (const r of rows) {
        const id = typeof r["id"] === "string" && ID.test(r["id"]) ? r["id"] : null;
        if (!id || seen.has(id)) continue;
        seen.set(id, { id, createdAt: str(r["Received_At"]) ?? str(r["Created_Time"]) ?? new Date(0).toISOString(), email: str(r["Email"]), whatsapp: str(r["WhatsApp"]), contactId: lookupId(r["Contact"]), prefillJson: str(r["Onboarding_Prefill_JSON"]) });
      }
    }
    return [...seen.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, q.limit);
  }

  /** Readiness helper: every field this reader selects must exist in the Sandbox schema. Fails closed, names missing fields only. */
  async verifySchema(includeConsultation: boolean): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    const targets: Array<[string, readonly string[]]> = Object.entries(READER_SCHEMA).map(([m, f]) => [m === "Requests" ? this.requestsModule : m, f]);
    if (includeConsultation) targets.push([CONSULTATION_MODULE, CONSULTATION_SCHEMA]);
    for (const [module, fields] of targets) {
      // Without `type=all` Zoho returns only USED fields: a field that exists but sits on no layout (verified live: Deals.Form_Completion_Date,
      // Contacts.Email_Opt_Out; Requests 243 used vs 322 total) would be reported missing although the API can read and write it.
      const res = await this.get("/settings/fields", { module, type: "all" });
      const j = res.json;
      if (res.status !== 200 || j === INVALID || !isObj(j) || !Array.isArray(j["fields"])) {
        missing.push(`${module}:*`);
        continue;
      }
      const have = new Set((j["fields"] as unknown[]).filter(isObj).map((f) => String(f["api_name"])));
      for (const f of fields) if (!have.has(f)) missing.push(`${module}.${f}`);
    }
    return { ok: missing.length === 0, missing };
  }
}

/**
 * Builds the reader from the environment. A dedicated READ-ONLY grant is preferred
 * (`SIX2FIT_ZOHO_READER_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN`); without one the Requests-writer grant is reused and
 * `sharedGrant` is reported by the readiness probe. Same Sandbox guards as the writer (organisation, type, id prefix).
 */
export function createCrmReader(env: Record<string, string | undefined>, overrides: Partial<ClientDeps> = {}): { reader: ZohoCrmReader; config: CrmConfig; sharedGrant: boolean } {
  const get = (k: string) => (env[k] ?? "").trim();
  const dedicated = get("SIX2FIT_ZOHO_READER_REFRESH_TOKEN") !== "";
  const readerEnv = dedicated
    ? { ...env, SIX2FIT_ZOHO_CLIENT_ID: get("SIX2FIT_ZOHO_READER_CLIENT_ID"), SIX2FIT_ZOHO_CLIENT_SECRET: get("SIX2FIT_ZOHO_READER_CLIENT_SECRET"), SIX2FIT_ZOHO_REFRESH_TOKEN: get("SIX2FIT_ZOHO_READER_REFRESH_TOKEN") }
    : env;
  const config = loadCrmConfig(readerEnv);
  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as ClientDeps["fetch"] | undefined);
  if (!fetchImpl) throw new StoreError("NOT_CONFIGURED", "crm reader: fetch unavailable", "CRM_NOT_CONFIGURED");
  const deps: ClientDeps = { fetch: fetchImpl, now: overrides.now ?? (() => Date.now()), sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
  return { reader: new ZohoCrmReader(new ZohoClient(config, deps), config.orgZgid, config.moduleApiName), config, sharedGrant: !dedicated };
}
