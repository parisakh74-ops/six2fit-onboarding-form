import { join } from "node:path";
import { ConsultHandoffDirectory, FileOnboardingStore, LocalFileSink } from "./file-store";
import { StoreError } from "./errors";
import type { OnboardingStore } from "./ports";
import { createOnboardingService, type OnboardingService, type Result } from "./service";
import { createRequestsStore } from "./crm/factory";

/** Largest accepted request body. The form allows up to 7 files of 20 MB; photos are optional, so the limit is generous but bounded. */
export const DEFAULT_MAX_BODY_BYTES = 80 * 1024 * 1024;
const JSON_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

type Runtime = { service: OnboardingService; maxBodyBytes: number };
export type Deps = { runtime?: () => Runtime };

const req = (env: Record<string, string | undefined>, name: string): string => {
  const v = (env[name] ?? "").trim();
  if (!v) throw new StoreError("NOT_CONFIGURED", "missing configuration", "CONFIG");
  return v;
};

/** Builds the service from server-only environment variables (never from the browser). */
export function runtimeFromEnv(env: Record<string, string | undefined> = process.env): Runtime {
  if (req(env, "SIX2FIT_STAGING_MODE") !== "true") throw new StoreError("NOT_CONFIGURED", "staging mode disabled", "CONFIG");
  const secret = req(env, "SIX2FIT_STAGING_TOKEN_SECRET");
  if (secret.length < 32) throw new StoreError("NOT_CONFIGURED", "secret too short", "CONFIG");
  const storageDir = req(env, "SIX2FIT_STAGING_STORAGE_DIR");
  const kind = (env["SIX2FIT_ONBOARDING_STORE"] ?? "file").trim().toLowerCase();
  let store: OnboardingStore;
  if (kind === "file") store = new FileOnboardingStore(storageDir);
  else if (kind === "crm") store = createRequestsStore(env, join(storageDir, "onboarding-ledger"));
  else throw new StoreError("NOT_CONFIGURED", "unknown store", "CONFIG");
  const service = createOnboardingService({
    store,
    directory: new ConsultHandoffDirectory(storageDir),
    sink: new LocalFileSink(storageDir),
    secret,
    log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  });
  const limit = Number(env["SIX2FIT_ONBOARDING_MAX_BODY_BYTES"]);
  return { service, maxBodyBytes: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_BODY_BYTES };
}

const toResponse = (r: Result): Response => Response.json(r.body, { status: r.status, headers: { ...JSON_HEADERS, ...(r.headers ?? {}) } });
const plain = (status: number, error_code: string): Response => Response.json({ error_code, message: error_code }, { status, headers: JSON_HEADERS });

const isStagingHost = (request: Request): boolean => new URL(request.url).hostname.toLowerCase().includes("onboarding-staging");

function getRuntime(deps: Deps): Runtime | Response {
  try {
    return (deps.runtime ?? runtimeFromEnv)();
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
