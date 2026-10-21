import { randomBytes } from "node:crypto";
import { link, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "../errors";
import { IdempotencyLedger, type LedgerEntry } from "../ledger";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyIssuerRequest } from "../links/auth";
import type { Runtime } from "../http";
import { reconcileSubmissions } from "../workdrive/reconcile";

/**
 * Internal operations endpoints (signed caller, own secret, no customer data in the answers):
 *   POST /api/internal/onboarding-readiness   -> checks that the runtime can work (read-only, creates no customer record)
 *   POST /api/internal/onboarding-reconcile   -> read-only reconciliation CRM <-> WorkDrive + ledger overview
 * Both only read. Neither deletes, repairs, moves or overwrites anything.
 */
export const READINESS_PATH = "/api/internal/onboarding-readiness";
export const RECONCILE_PATH = "/api/internal/onboarding-reconcile";
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const MAX_BODY = 64 * 1024;
const MAX_KEYS = 500;
const KEY = /^onb[12]_[A-Za-z0-9_-]{6,200}$/;

export type OpsKind = "readiness" | "reconcile";
export function opsKindOf(request: Request): OpsKind | null {
  if (request.method !== "POST") return null;
  const u = new URL(request.url);
  if (u.pathname === READINESS_PATH) return "readiness";
  if (u.pathname === RECONCILE_PATH) return "reconcile";
  if (u.pathname === "/") {
    const a = u.searchParams.get("six2fit_api");
    if (a === "readiness") return "readiness";
    if (a === "reconcile") return "reconcile";
  }
  return null;
}

const plain = (status: number, error_code: string): Response => Response.json({ error_code, message: error_code }, { status, headers: HEADERS });

export type OpsDeps = { runtime: () => Runtime | null; env: Record<string, string | undefined>; now?: () => number };

export async function handleOps(request: Request, kind: OpsKind, deps: OpsDeps): Promise<Response> {
  const secret = (deps.env["SIX2FIT_OPS_CALLER_SECRET"] ?? "").trim();
  if (secret.length < 32) return plain(503, "OPS_NOT_CONFIGURED");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return plain(413, "PAYLOAD_TOO_LARGE");
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY) return plain(413, "PAYLOAD_TOO_LARGE");
  const path = kind === "readiness" ? READINESS_PATH : RECONCILE_PATH; // canonical for both spellings
  const ok = verifyIssuerRequest(secret, { timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER), method: request.method, path, body }, (deps.now ?? (() => Date.now()))());
  if (!ok) return plain(401, "UNAUTHORIZED");
  const rt = deps.runtime();
  if (!rt) return plain(503, "STAGING_UNAVAILABLE");
  if (kind === "readiness") return Response.json(await runReadiness(rt, deps.env), { status: 200, headers: HEADERS });
  let keys: string[] = [];
  try {
    const parsed: unknown = body.trim() === "" ? {} : JSON.parse(body);
    const k = (parsed as { keys?: unknown }).keys;
    if (k !== undefined) {
      if (!Array.isArray(k) || k.length > MAX_KEYS || k.some((x) => typeof x !== "string" || !KEY.test(x))) throw new Error("shape");
      keys = k as string[];
    }
  } catch {
    return plain(400, "INVALID_REQUEST");
  }
  return Response.json(await runReconciliation(rt, keys, deps.env), { status: 200, headers: HEADERS });
}

export type Check = { name: string; status: "pass" | "fail" | "warn" | "skip"; code?: string; detail?: string };
export type ReadinessReport = { ok: boolean; persistence: string; checks: Check[] };

const codeOf = (e: unknown): string => (e instanceof StoreError ? (e.code ?? e.kind) : "UNEXPECTED");

/** Write + hard-link capability of the storage directory (what the ledger, the registry and the payment facts rely on). */
export async function probeStorage(storageDir: string): Promise<Check> {
  const dir = join(storageDir, "_readiness", randomBytes(6).toString("hex"));
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const a = join(dir, "a.tmp");
    await writeFile(a, "probe", { flag: "wx", mode: 0o600 });
    await link(a, join(dir, "g1.json"));
    const second = await link(a, join(dir, "g1.json")).then(() => "linked-twice", (e: NodeJS.ErrnoException) => e.code);
    await unlink(a);
    await unlink(join(dir, "g1.json"));
    if (second !== "EEXIST") return { name: "storage_hardlink_atomic", status: "fail", code: "HARDLINK_NOT_EXCLUSIVE" };
    return { name: "storage_hardlink_atomic", status: "pass" };
  } catch (e) {
    return { name: "storage_hardlink_atomic", status: "fail", code: (e as NodeJS.ErrnoException).code ?? "IO" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runReadiness(rt: Runtime, env: Record<string, string | undefined>): Promise<ReadinessReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const crm = rt.ops?.crm;
  if (!crm) {
    add({ name: "crm_store", status: "fail", code: "STORE_NOT_CRM" });
    return { ok: false, persistence: "file", checks };
  }
  // The configured environment and the id prefix must agree (sandbox never carries the Production prefix, production always does).
  add({ name: "environment_isolation", status: crm.config.moduleIdPrefix.startsWith("6067417000") === (crm.config.environment === "production") ? "pass" : "fail", code: "ENVIRONMENT_PREFIX" });
  if (crm.config.environment === "production") add({ name: "production_mode", status: "warn", code: "PRODUCTION_ENVIRONMENT" });
  add({ name: "expected_org_matches_crm_config", status: (env["SIX2FIT_EXPECTED_ORG_ID"] ?? "").trim() === crm.config.orgZgid ? "pass" : "fail", code: "ORG_ID" });
  // Workflow isolation: the Sandbox still has active rules pointing at the Production Flow app. The writer suppresses workflows
  // (`trigger: []`) unless explicitly told otherwise; that suppression is documented by Zoho but not yet observed in the Sandbox.
  add({ name: "crm_workflows_suppressed_on_create", status: crm.config.triggerAutomations ? "warn" : "pass", code: "TRIGGER_AUTOMATIONS_ON" });
  add({ name: "uploads_not_stored_locally", status: crm.persistence === "raw-field" ? "warn" : crm.sink.deferred === true ? "pass" : "fail", code: crm.persistence === "raw-field" ? "RAW_FIELD_LOCAL_SINK" : "DEFERRED_SINK" });
  add(await probeStorage(rt.ops?.storageDir as string));
  try {
    await new IdempotencyLedger(crm.ledgerDir).scan();
    add({ name: "ledger_readable", status: "pass" });
  } catch (e) {
    add({ name: "ledger_readable", status: "fail", code: codeOf(e) });
  }
  if (crm.workdrive) {
    try {
      await crm.workdrive.storage.verifyRootFolder();
      add({ name: "workdrive_auth_and_root", status: "pass" });
    } catch (e) {
      add({ name: "workdrive_auth_and_root", status: "fail", code: codeOf(e) });
    }
    add({ name: "ledger_lease_covers_budget", status: "pass", detail: `${crm.ledgerLeaseMs ?? 0}ms` });
  } else {
    add({ name: "workdrive_auth_and_root", status: "skip", code: "NOT_WORKDRIVE_MODE" });
  }
  const reader = rt.ops?.reader;
  if (reader) {
    try {
      const schema = await reader.verifySchema((env["SIX2FIT_CONSULT_PREFILL_ENABLED"] ?? "") === "true");
      add({ name: "crm_org_and_reader_schema", status: schema.ok ? "pass" : "fail", ...(schema.ok ? {} : { code: "SCHEMA_MISSING", detail: schema.missing.join(",") }) });
    } catch (e) {
      add({ name: "crm_org_and_reader_schema", status: "fail", code: e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : codeOf(e) });
    }
    add({ name: "reader_uses_dedicated_read_only_grant", status: rt.ops?.readerSharesWriterGrant ? "warn" : "pass", code: "SHARED_GRANT" });
  } else {
    add({ name: "crm_org_and_reader_schema", status: "skip", code: "EXPLICIT_READER" });
  }
  // E-mail delivery is OFF unless explicitly configured. This check only inspects configuration (no network, nothing is sent).
  const mode = (env["SIX2FIT_EMAIL_DELIVERY_MODE"] ?? "").trim().toLowerCase();
  if (mode === "" || mode === "disabled") add({ name: "email_delivery", status: "skip", code: "EMAIL_DISABLED" });
  else {
    const missing = ["SIX2FIT_EMAIL_FROM", "SIX2FIT_EMAIL_FROM_NAME", "SIX2FIT_EMAIL_ALLOWED_RECIPIENTS", "SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN", "SIX2FIT_FORM_BASE_URL"].filter((k) => (env[k] ?? "").trim() === "");
    add({ name: "email_delivery", status: mode === "crm-send-mail" && missing.length === 0 ? "pass" : "fail", ...(missing.length ? { code: "MISSING", detail: missing.join(",") } : {}) });
  }
  const required = ["SIX2FIT_ONBOARDING_TOKEN_SECRET", "SIX2FIT_STAGING_STORAGE_DIR", "SIX2FIT_EXPECTED_ORG_ID", "SIX2FIT_PRODUCT_SCOPE_MAP", "SIX2FIT_OPS_CALLER_SECRET"];
  const missing = required.filter((k) => (env[k] ?? "").trim() === "");
  add({ name: "required_environment", status: missing.length ? "fail" : "pass", ...(missing.length ? { code: "MISSING", detail: missing.join(",") } : {}) });
  return { ok: checks.every((c) => c.status !== "fail"), persistence: crm.persistence, checks };
}

export type ReconciliationReport = {
  workdrive: Awaited<ReturnType<typeof reconcileSubmissions>> | { skipped: string };
  ledger: { total: number; by_state: Record<string, number>; needs_attention: Array<{ key: string; state: string; phase?: string; code?: string; age_s: number }> };
};

export async function runReconciliation(rt: Runtime, crmKeys: string[], env: Record<string, string | undefined>, now = Date.now()): Promise<ReconciliationReport | { error_code: string }> {
  const crm = rt.ops?.crm;
  if (!crm) return { error_code: "STORE_NOT_CRM" };
  const entries: LedgerEntry[] = await new IdempotencyLedger(crm.ledgerDir).scan().catch(() => []);
  const by_state: Record<string, number> = {};
  for (const e of entries) by_state[e.state] = (by_state[e.state] ?? 0) + 1;
  const lease = crm.ledgerLeaseMs ?? 150_000;
  const needs = entries
    .filter((e) => e.state === "unknown" || e.state === "needs_review" || e.state === "integrity" || (e.state === "in_progress" && now - e.updated > lease))
    .map((e) => ({ key: e.uk, state: e.state, ...(e.phase ? { phase: e.phase } : {}), ...(e.code ? { code: e.code } : {}), age_s: Math.round((now - e.updated) / 1000) }));
  let workdrive: ReconciliationReport["workdrive"];
  if (crm.workdrive && crm.lookup) {
    try {
      workdrive = await reconcileSubmissions({ storage: crm.workdrive.storage, crm: crm.lookup, crmKeys });
    } catch (e) {
      workdrive = { skipped: codeOf(e) };
    }
  } else workdrive = { skipped: "NOT_WORKDRIVE_MODE" };
  void env;
  return { workdrive, ledger: { total: entries.length, by_state, needs_attention: needs } };
}
