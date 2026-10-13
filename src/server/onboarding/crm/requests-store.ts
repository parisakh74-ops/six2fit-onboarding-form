import { StoreError } from "../errors";
import type { CreateResult, CrmWriter, StoredRef, SubmissionRecord } from "../ports";
import { INVALID, ZohoClient, ZohoTransportError, type ZohoResponse } from "./client";
import type { CrmConfig } from "./config";
import { buildRequestsRecord, parseStoredRequest } from "./requests-mapping";

export type RequestsStoreDeps = {
  client: ZohoClient;
  config: CrmConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Codes, counts and timings only. */
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
};

type DataItem = { code?: unknown; details?: { more_records?: unknown; id?: unknown; api_name?: unknown; duplicate_record?: { id?: unknown } } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KEY = /^onb[12]_[A-Za-z0-9_-]{6,200}$/;
const DEFINITE_REFUSALS = new Set(["AUTH_FAILED", "FORBIDDEN", "RATE_LIMITED"]);

/**
 * `CrmWriter` for the Zoho CRM module `Requests` (Sandbox only). Create-only: no upsert, update or delete.
 *  - The unique field `uniqueformkey` is a guard against NON-concurrent repeats only (Zoho's unique check is not atomic
 *    under concurrency: observed on the Consultation module); concurrency is arbitrated by the idempotency ledger.
 *  - Timeouts, network errors, 5xx and unreadable answers are AMBIGUOUS: this class never writes again after one; it
 *    does one lookup (a hit proves existence; an empty search proves nothing because the index lags) and otherwise
 *    fails with `OUTCOME_UNKNOWN`. The ledger owns what happens next.
 *  - 429 is retried after the advertised delay (not processed). Every other failure is a `StoreError`.
 *  - `StoreError.notWritten` is set only when nothing can have been written.
 */
export class RequestsStore implements CrmWriter {
  constructor(private readonly deps: RequestsStoreDeps) {}

  private log(event: string, fields: Record<string, string | number | boolean> = {}) {
    this.deps.log?.(event, fields);
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    return Math.max(retryAfterMs ?? 0, Math.min(this.deps.config.retryBaseMs * 3 ** (attempt - 1), 5000));
  }

  private assertKey(key: string): void {
    if (!KEY.test(key)) throw new StoreError("UNAVAILABLE", "invalid key", "INVALID_ID");
  }

  private async call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<ZohoResponse> {
    try {
      return await this.deps.client.request(method, path, opts);
    } catch (e) {
      if (e instanceof ZohoTransportError) throw new StoreError("UNAVAILABLE", `crm ${e.reason}`, e.reason === "timeout" ? "TIMEOUT" : "NETWORK");
      throw e;
    }
  }

  private classifyFailure(res: ZohoResponse): void {
    const s = res.status;
    if (s >= 200 && s < 300) return;
    if (s === 401 && isObj(res.json) && res.json["code"] === "OAUTH_SCOPE_MISMATCH") throw new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN");
    if (s === 401) throw new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED");
    if (s === 403) throw new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN");
    if (s === 429) throw new StoreError("UNAVAILABLE", "crm rate limited", "RATE_LIMITED");
    if (s >= 500) throw new StoreError("UNAVAILABLE", "crm unavailable", "UPSTREAM_5XX");
    throw new StoreError("UNAVAILABLE", "crm request refused", `HTTP_${s}`);
  }

  private dataList(res: ZohoResponse): unknown[] {
    this.classifyFailure(res);
    const j = res.json;
    if (j === INVALID || j === null || !isObj(j) || !Array.isArray(j["data"])) throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
    return j["data"] as unknown[];
  }

  /** Exact-match search on the unique key. HTTP 204 / empty data = not found (NOT proof of absence). */
  async lookupId(uniqueFormKey: string): Promise<string | null> {
    this.assertKey(uniqueFormKey);
    await this.deps.client.verifyEnvironment();
    return this.search(uniqueFormKey);
  }

  private async search(key: string): Promise<string | null> {
    const res = await this.call("GET", `/${this.deps.config.moduleApiName}/search`, { query: { criteria: `(uniqueformkey:equals:${key})`, fields: "id,uniqueformkey" } });
    if (res.status === 204) return null;
    const list = this.dataList(res);
    const exact: string[] = [];
    for (const item of list) {
      if (!isObj(item) || typeof item["id"] !== "string") throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
      // `equals` is contains-like in Zoho search: keep only the exact key.
      if (item["uniqueformkey"] === key) exact.push(item["id"]);
    }
    if (exact.length > 1) throw new StoreError("CORRUPT", "more than one record for a submission", "DUPLICATE_RECORDS");
    return exact[0] ?? null;
  }

  async readRecord(recordId: string, uniqueFormKey: string): Promise<StoredRef> {
    this.assertKey(uniqueFormKey);
    await this.deps.client.verifyEnvironment();
    return this.read(recordId, uniqueFormKey);
  }

  private async read(recordId: string, key: string): Promise<StoredRef> {
    if (!/^\d{6,25}$/.test(recordId)) throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
    const res = await this.call("GET", `/${this.deps.config.moduleApiName}/${recordId}`);
    if (res.status === 204) throw new StoreError("UNAVAILABLE", "record not readable yet", "READ_AFTER_WRITE");
    const item = this.dataList(res)[0];
    if (isObj(item) && item["uniqueformkey"] !== key) throw new StoreError("CORRUPT", "stored request does not match its key", "KEY_MISMATCH");
    return parseStoredRequest(item, this.deps.config.rawField);
  }

  async create(record: SubmissionRecord): Promise<CreateResult> {
    const state = { posted: false };
    try {
      return await this.createInner(record, state);
    } catch (e) {
      if (e instanceof StoreError && (!state.posted || DEFINITE_REFUSALS.has(e.code ?? "") || e.kind === "REJECTED")) e.notWritten = true;
      throw e;
    }
  }

  private async createInner(record: SubmissionRecord, state: { posted: boolean }): Promise<CreateResult> {
    const { config } = this.deps;
    this.assertKey(record.unique_form_key);
    const mapped = buildRequestsRecord(record, { rawField: config.rawField, maxRawChars: config.maxRawPayloadChars, setNewRecordFlag: config.setNewRecordFlag });
    await this.deps.client.verifyEnvironment();

    // `trigger: []` suppresses workflows/blueprints/approvals on the new record. Default off for automations (Sandbox rules still point at Production Flow).
    const body = config.triggerAutomations ? { data: [mapped.record] } : { data: [mapped.record], trigger: [] as string[] };
    let lastError: StoreError | null = null;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      let res: ZohoResponse | null = null;
      let transport: "timeout" | "network" | null = null;
      try {
        state.posted = true;
        res = await this.deps.client.request("POST", `/${config.moduleApiName}`, { body });
      } catch (e) {
        if (e instanceof ZohoTransportError) transport = e.reason;
        else throw e;
      }
      if (res !== null) {
        const outcome = this.interpretCreate(res);
        if (outcome.kind === "created") {
          this.log("crm.created", { attempt, rawChars: mapped.rawChars });
          return { status: "created", record: { fingerprint: record.fingerprint, submitted_at: record.submitted_at, record_ref: outcome.id } };
        }
        if (outcome.kind === "duplicate") return this.resolveDuplicate(record.unique_form_key, outcome.existingId);
        if (outcome.kind === "fatal") throw outcome.error;
        if (outcome.kind === "retry-safe") {
          lastError = new StoreError("UNAVAILABLE", "crm rate limited", "RATE_LIMITED");
          this.log("crm.retry", { attempt, reason: "rate_limited" });
          if (attempt < config.maxAttempts) await this.deps.sleep(this.backoff(attempt, outcome.retryAfterMs));
          continue;
        }
        lastError = new StoreError("UNAVAILABLE", "crm outcome unknown", outcome.code);
      } else {
        lastError = new StoreError("UNAVAILABLE", "crm outcome unknown", transport === "timeout" ? "TIMEOUT" : "NETWORK");
      }
      // Ambiguous: NEVER write again. One lookup; a hit is proof of existence, an empty search is not proof of absence.
      this.log("crm.ambiguous", { attempt, reason: lastError.code ?? "unknown" });
      try {
        const existing = await this.search(record.unique_form_key);
        if (existing !== null) return { status: "exists", record: await this.read(existing, record.unique_form_key) };
      } catch (e) {
        if (!(e instanceof StoreError) || e.kind === "CORRUPT") throw e;
        this.log("crm.lookup_failed", { attempt, reason: e.code ?? "unknown" });
      }
      throw new StoreError("UNAVAILABLE", "crm outcome unknown", "OUTCOME_UNKNOWN");
    }
    throw lastError ?? new StoreError("UNAVAILABLE", "crm create failed", "EXHAUSTED");
  }

  private interpretCreate(
    res: ZohoResponse,
  ):
    | { kind: "created"; id: string }
    | { kind: "duplicate"; existingId: string | null }
    | { kind: "fatal"; error: StoreError }
    | { kind: "retry-safe"; retryAfterMs: number | undefined }
    | { kind: "ambiguous"; code: string } {
    const s = res.status;
    if (s === 401 && isObj(res.json) && res.json["code"] === "OAUTH_SCOPE_MISMATCH") return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    if (s === 401) return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED") };
    if (s === 403) return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    if (s === 429) return { kind: "retry-safe", retryAfterMs: res.retryAfterMs };
    if (s >= 500) return { kind: "ambiguous", code: "UPSTREAM_5XX" };
    const j = res.json;
    if (j === INVALID || j === null || !isObj(j)) return { kind: "ambiguous", code: "INVALID_RESPONSE" };
    const top = typeof j["code"] === "string" ? j["code"] : undefined;
    const items = Array.isArray(j["data"]) ? (j["data"] as DataItem[]) : null;
    const item = items?.[0];
    const code = typeof item?.code === "string" ? item.code : top;
    if (code === "SUCCESS" && items?.length === 1) {
      const id = item?.details?.id;
      if (typeof id === "string" && /^\d{6,25}$/.test(id)) return { kind: "created", id };
      return { kind: "ambiguous", code: "INVALID_RESPONSE" };
    }
    if (code === "DUPLICATE_DATA") {
      const field = item?.details?.api_name;
      if (field !== "uniqueformkey") return { kind: "fatal", error: new StoreError("REJECTED", "crm rejected the record", `DUPLICATE_DATA:${typeof field === "string" ? field : "unknown"}`.slice(0, 120)) };
      if (item?.details?.more_records === true) return { kind: "fatal", error: new StoreError("CORRUPT", "more than one record for a submission", "DUPLICATE_RECORDS") };
      const dup = item?.details?.id ?? item?.details?.duplicate_record?.id;
      return { kind: "duplicate", existingId: typeof dup === "string" && /^\d{6,25}$/.test(dup) ? dup : null };
    }
    if (code === "INVALID_TOKEN" || code === "AUTHENTICATION_FAILURE") return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED") };
    if (code === "OAUTH_SCOPE_MISMATCH" || code === "NO_PERMISSION" || code === "NO_ACCESS") return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    if (code === "TOO_MANY_REQUESTS" || code === "RATE_LIMIT_EXCEEDED") return { kind: "retry-safe", retryAfterMs: res.retryAfterMs };
    if (code === "INTERNAL_ERROR" || code === "SERVICE_UNAVAILABLE") return { kind: "ambiguous", code: "UPSTREAM_ERROR" };
    if (typeof code === "string" && s >= 400 && s < 500) {
      // Validation failure (INVALID_DATA, MANDATORY_NOT_FOUND, ...): our defect, never retried; names the field only.
      const field = typeof item?.details === "object" && item?.details && typeof item.details.api_name === "string" ? item.details.api_name : undefined;
      return { kind: "fatal", error: new StoreError("REJECTED", "crm rejected the record", `${code}${field ? `:${field}` : ""}`.slice(0, 120)) };
    }
    return { kind: "ambiguous", code: "INVALID_RESPONSE" };
  }

  /** A duplicate answer on `uniqueformkey` means the submission exists: read it (id from the error, else by search; the index can lag). */
  private async resolveDuplicate(key: string, existingId: string | null): Promise<CreateResult> {
    let id = existingId;
    for (let attempt = 1; id === null && attempt <= this.deps.config.maxAttempts; attempt += 1) {
      id = await this.search(key);
      if (id === null && attempt < this.deps.config.maxAttempts) await this.deps.sleep(this.backoff(attempt));
    }
    if (id === null) throw new StoreError("UNAVAILABLE", "duplicate reported but record not found", "DUPLICATE_UNRESOLVED");
    this.log("crm.duplicate", {});
    return { status: "exists", record: await this.read(id, key) };
  }
}
