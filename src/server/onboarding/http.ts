import { join } from "node:path";
import { ConsultHandoffDirectory, FileOnboardingStore, LocalFileSink } from "./file-store";
import { StoreError } from "./errors";
import type { OnboardingStore } from "./ports";
import { createOnboardingService, type OnboardingService, type Result } from "./service";
import { createCrmRuntime, type CrmRuntime, type CrmRuntimeOverrides } from "./crm/runtime";
import type { FileSink } from "./ports";
import { FactStore, revocationKey } from "./payments/facts";
import { CompositeSubjectDirectory, DealSubjectDirectory } from "./links/deal-directory";
import { productMapFromEnv } from "./links/product-map";
import type { CrmDealReader } from "./links/types";
import { createCrmReader, type ZohoCrmReader } from "./links/crm-reader";
import { notionSyncEnabled } from "./notion/config";
import { createNotionRuntime, type NotionOverrides, type NotionRuntime } from "./notion/runtime";

/** Largest accepted request body. The form allows up to 7 files of 20 MB; photos are optional, so the limit is generous but bounded. */
export const DEFAULT_MAX_BODY_BYTES = 80 * 1024 * 1024;
const JSON_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

export type Runtime = {
  service: OnboardingService;
  maxBodyBytes: number;
  /** CRM-backed persistence details for the operations endpoints (readiness, reconciliation). Absent for the `file` store. */
  ops?: { crm: CrmRuntime; reader: ZohoCrmReader | undefined; readerSharesWriterGrant: boolean; storageDir: string };
  /** Notion follow-up sync (test target only); absent unless `SIX2FIT_NOTION_SYNC=true`. */
  notion?: NotionRuntime;
};
export type Deps = { runtime?: () => Runtime };

const req = (env: Record<string, string | undefined>, name: string): string => {
  const v = (env[name] ?? "").trim();
  if (!v) throw new StoreError("NOT_CONFIGURED", "missing configuration", "CONFIG");
  return v;
};

/**
 * Builds the service from server-only environment variables (never from the browser).
 * `dealReader` is the READ-ONLY CRM reader for Deal-bound links. Without it the `crm` store builds the read-only Sandbox reader (links/crm-reader.ts); the `file` store has none and
 * Deal links fail closed exactly as before; Consultation links are unaffected either way.
 */
export function runtimeFromEnv(env: Record<string, string | undefined> = process.env, extras: { dealReader?: CrmDealReader; notion?: NotionOverrides } = {}, overrides: CrmRuntimeOverrides = {}): Runtime {
  if (req(env, "SIX2FIT_STAGING_MODE") !== "true") throw new StoreError("NOT_CONFIGURED", "staging mode disabled", "CONFIG");
  const kind0 = (env["SIX2FIT_ONBOARDING_STORE"] ?? "file").trim().toLowerCase();
  // O1: Consultation hand-off tokens are refused unless explicitly enabled for development/staging, and never with the CRM store.
  const acceptConsultHandoff = env["SIX2FIT_ACCEPT_CONSULT_HANDOFF"] === "true" && kind0 !== "crm";
  // Secret separation: the onboarding signing secret has its own variable. The legacy shared variable is honoured ONLY while the
  // hand-off is explicitly enabled (so a production-like configuration cannot keep sharing the Consultation secret).
  const secret = (env["SIX2FIT_ONBOARDING_TOKEN_SECRET"] ?? "").trim() || (acceptConsultHandoff ? req(env, "SIX2FIT_STAGING_TOKEN_SECRET") : req(env, "SIX2FIT_ONBOARDING_TOKEN_SECRET"));
  if (secret.length < 32) throw new StoreError("NOT_CONFIGURED", "secret too short", "CONFIG");
  const storageDir = req(env, "SIX2FIT_STAGING_STORAGE_DIR");
  const kind = (env["SIX2FIT_ONBOARDING_STORE"] ?? "file").trim().toLowerCase();
  let store: OnboardingStore;
  let sink: FileSink = new LocalFileSink(storageDir);
  let crmRuntime: CrmRuntime | undefined;
  if (kind === "file") store = new FileOnboardingStore(storageDir);
  else if (kind === "crm") {
    // Single composition point of CRM + WorkDrive persistence. In a WorkDrive mode the sink is the deferred one: uploads are
    // staged in WorkDrive under the ledger claim and never written to the local disk.
    const crm = createCrmRuntime(env, storageDir, sink, overrides);
    store = crm.store;
    sink = crm.sink;
    crmRuntime = crm;
  } else throw new StoreError("NOT_CONFIGURED", "unknown store", "CONFIG");
  // Deal links are verified against trusted CRM data. Without an explicit reader the CRM store builds the read-only Sandbox reader
  // (one per process); the `file` store (development) keeps failing closed for Deal links exactly as before.
  const built = !extras.dealReader && kind === "crm" ? createCrmReader(env, overrides) : undefined;
  const dealReader = extras.dealReader ?? built?.reader;
  // Notion follow-up: enabled explicitly, configured fail-closed (a bad configuration blocks the runtime instead of silently
  // dropping Notion entries), and only on top of CRM + WorkDrive persistence.
  let notion: NotionRuntime | undefined;
  if (notionSyncEnabled(env)) {
    if (!crmRuntime) throw new StoreError("NOT_CONFIGURED", "notion sync needs the crm store", "CONFIG");
    // Read-only Product.Fitness (Deal -> Product). A reader that cannot serve it leaves the form type empty (never inferred).
    const fitnessReader = extras.dealReader ?? built?.reader;
    const resolveFitness = fitnessReader?.getProductFitness
      ? async (dealId: string): Promise<string | null> => {
          const deal = await fitnessReader.getDeal(dealId);
          return deal?.productId ? ((await fitnessReader.getProductFitness?.(deal.productId)) ?? null) : null;
        }
      : undefined;
    notion = createNotionRuntime(env, storageDir, crmRuntime.workdrive?.storage, { ...(resolveFitness ? { resolveFitness } : {}), log: (event, fields) => console.info(JSON.stringify({ event, ...fields })), ...extras.notion });
  }
  const payments = new FactStore(join(storageDir, "payments"));
  const service = createOnboardingService({
    store,
    isRevoked: async (linkId) => (await payments.get(revocationKey(linkId), "revoked")) !== null,
    acceptConsultHandoff,
    directory: new CompositeSubjectDirectory(
      acceptConsultHandoff ? new ConsultHandoffDirectory(storageDir) : null,
      dealReader
        ? new DealSubjectDirectory({
            crm: dealReader,
            products: productMapFromEnv(env["SIX2FIT_PRODUCT_SCOPE_MAP"]),
            expectedOrgId: req(env, "SIX2FIT_EXPECTED_ORG_ID"),
            log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
            prefill: {
              enabled: env["SIX2FIT_CONSULT_PREFILL_ENABLED"] === "true",
              windowDays: Math.min(Math.max(Number(env["SIX2FIT_CONSULT_PREFILL_WINDOW_DAYS"]) || 90, 1), 365),
              limit: Math.min(Math.max(Number(env["SIX2FIT_CONSULT_PREFILL_CANDIDATE_LIMIT"]) || 10, 1), 25),
            },
          })
        : null,
    ),
    sink,
    secret,
    ...(notion
      ? {
          // Awaited: the pending sync is durable in the Notion ledger before success is returned; the bounded inline attempt never fails
          // the request, and reconciliation (ops endpoint) finishes whatever is left. Nothing depends on work after the response.
          afterPersist: (record, fx, persistedAt) => notion.registerAndSync(record, fx, persistedAt),
        }
      : {}),
    log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  });
  const limit = Number(env["SIX2FIT_ONBOARDING_MAX_BODY_BYTES"]);
  return {
    service,
    maxBodyBytes: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_BODY_BYTES,
    ...(notion ? { notion } : {}),
    ...(crmRuntime ? { ops: { crm: crmRuntime, reader: built?.reader, readerSharesWriterGrant: built?.sharedGrant ?? true, storageDir } } : {}),
  };
}

const toResponse = (r: Result): Response => Response.json(r.body, { status: r.status, headers: { ...JSON_HEADERS, ...(r.headers ?? {}) } });
const plain = (status: number, error_code: string): Response => Response.json({ error_code, message: error_code }, { status, headers: JSON_HEADERS });

const isStagingHost = (request: Request): boolean => new URL(request.url).hostname.toLowerCase().includes("onboarding-staging");

/**
 * One runtime per process: the CRM and WorkDrive clients keep their OAuth tokens and environment verification, so a request
 * does not refresh tokens or re-verify the organisation. A failed build is not cached (fixing the configuration and
 * retrying works); a configuration change needs a process restart, as with any environment variable.
 */
let cachedRuntime: Runtime | null = null;
export const resetRuntimeCache = (): void => {
  cachedRuntime = null;
};

/** The process runtime (built once, see above) for the operations endpoints; a configuration failure is returned, not thrown. */
export function processRuntime(): Runtime | null {
  try {
    cachedRuntime ??= runtimeFromEnv();
    return cachedRuntime;
  } catch {
    return null;
  }
}

function getRuntime(deps: Deps): Runtime | Response {
  try {
    if (deps.runtime) return deps.runtime();
    cachedRuntime ??= runtimeFromEnv();
    return cachedRuntime;
  } catch (e) {
    console.error(JSON.stringify({ event: "onboarding.config_unavailable", kind: e instanceof StoreError ? e.kind : "CONFIG" }));
    return plain(503, "STAGING_UNAVAILABLE");
  }
}

/** Reads the body up to `limit` bytes; `null` when it is larger. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Do not cancel(): cancelling a request body that is still being fed can raise an unhandled rejection inside the
      // runtime (observed with undici), which would crash the process. The caller answers 413 and the body is discarded.
      reader.releaseLock();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function handleBootstrap(request: Request, deps: Deps = {}): Promise<Response> {
  if (!isStagingHost(request)) return plain(403, "STAGING_ONLY");
  if (request.method !== "GET" && request.method !== "POST") return plain(405, "METHOD_NOT_ALLOWED");
  const rt = getRuntime(deps);
  if (rt instanceof Response) return rt;
  const token = new URL(request.url).searchParams.get("session") ?? "";
  return toResponse(await rt.service.bootstrap(token));
}

export async function handleSubmit(request: Request, deps: Deps = {}): Promise<Response> {
  if (!isStagingHost(request)) return plain(403, "STAGING_ONLY");
  if (request.method !== "POST") return plain(405, "METHOD_NOT_ALLOWED");
  const rt = getRuntime(deps);
  if (rt instanceof Response) return rt;
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get("content-type") ?? "")) return plain(415, "UNSUPPORTED_MEDIA_TYPE");
  const body = await readLimited(request, rt.maxBodyBytes);
  if (body === null) return plain(413, "PAYLOAD_TOO_LARGE");

  let form: FormData;
  try {
    form = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") as string }, body: new Blob([body as BlobPart]) }).formData();
  } catch {
    return plain(400, "INVALID_FORM");
  }
  const answers = Object.create(null) as Record<string, string>;
  const files = Object.create(null) as Record<string, { name: string; type: string; size: number; head: Uint8Array; bytes: Uint8Array }>;
  for (const [name, value] of form.entries()) {
    if (name.startsWith("answer:")) {
      if (typeof value !== "string") return plain(400, "INVALID_FORM");
      answers[name.slice(7)] = value;
    } else if (name.startsWith("file:")) {
      if (typeof value === "string") return plain(400, "INVALID_FORM");
      if (value.size === 0) continue; // an empty file part is "no file"
      const bytes = new Uint8Array(await value.arrayBuffer());
      files[name.slice(5)] = { name: value.name, type: value.type, size: bytes.byteLength, head: bytes.slice(0, 16), bytes };
    }
  }
  const verification = form.get("verification_state");
  const result = await rt.service.submit({
    token: String(form.get("form_session_token") ?? ""),
    submissionId: String(form.get("submission_id") ?? ""),
    idempotencyKey: request.headers.get("idempotency-key"),
    answers,
    verificationState: typeof verification === "string" ? verification : "{}",
    files,
  });
  return toResponse(result);
}
