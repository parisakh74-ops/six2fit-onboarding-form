import { fingerprint, sha256Hex } from "./canonical";
import { StoreError } from "./errors";
import type { FileSink, OnboardingStore, SubjectDirectory, StoredFile, SubmissionRecord } from "./ports";
import { TokenError, subjectKey, uniqueFormKey, verifyLinkToken, type LinkClaims } from "./tokens";
import { validateSubmission, type FileInput, type Issue } from "./validate";

export type Result = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/** Submission id sent by the browser (`crypto.randomUUID()`); also the `Idempotency-Key` header. */
export const SUBMISSION_ID_PATTERN = /^[0-9a-f-]{20,80}$/i;
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

export type SubmitInput = {
  token: string;
  submissionId: string;
  idempotencyKey: string | null;
  /** `answer:<key>` form fields, raw strings. */
  answers: Record<string, string>;
  verificationState: string;
  /** `file:<key>` parts. `bytes` are only read for hashing and storage. */
  files: Record<string, FileInput & { bytes: Uint8Array }>;
};

export type OnboardingServiceDeps = {
  store: OnboardingStore;
  directory: SubjectDirectory;
  sink: FileSink;
  secret: string;
  /** True when the link was revoked (payment refunded/cancelled). Optional; a failing check fails closed (503). */
  isRevoked?: (linkId: string) => Promise<boolean>;
  /** Consultation (v1) hand-off tokens are REFUSED unless this is explicitly true (development/staging only; never in production). */
  acceptConsultHandoff?: boolean;
  now?: () => number;
  /** Counters and codes only: never answers, tokens, ids of people or paths. */
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

const err = (status: number, error_code: string, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: { error_code, message: error_code, ...extra },
  headers: { ...NO_STORE },
});

/** The single implementation of the Onboarding API business logic (bootstrap + submit). */
export function createOnboardingService(deps: OnboardingServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);

  async function authorize(token: string): Promise<LinkClaims | Result> {
    let claims: LinkClaims;
    try {
      claims = verifyLinkToken(token, deps.secret, now());
    } catch (e) {
      const code = e instanceof TokenError ? e.code : "MALFORMED";
      log("onboarding.token_rejected", { code });
      return err(401, "INVALID_OR_EXPIRED_SESSION");
    }
    if (claims.v === 1 && deps.acceptConsultHandoff !== true) {
      log("onboarding.consult_handoff_refused", {});
      return err(401, "INVALID_OR_EXPIRED_SESSION");
    }
    if (deps.isRevoked) {
      try {
        if (await deps.isRevoked(claims.jti)) {
          log("onboarding.link_revoked", {});
          return err(403, "LINK_REVOKED");
        }
      } catch {
        log("onboarding.revocation_check_failed", {});
        return err(503, "STORAGE_UNAVAILABLE");
      }
    }
    return claims;
  }

  const failure = (e: unknown, startedAt: number): Result => {
    const kind = e instanceof StoreError ? e.kind : "UNEXPECTED";
    const code = e instanceof StoreError ? e.code : undefined;
    log(code === "DUPLICATE_RECORDS" ? "onboarding.integrity_exception" : "onboarding.storage_failure", { kind, ...(code ? { code } : {}), ms: now() - startedAt });
    if (e instanceof StoreError && e.code === "IDENTITY_UNAVAILABLE") return err(503, "IDENTITY_UNAVAILABLE");
    if (e instanceof StoreError && e.code === "SUBJECT_NOT_ELIGIBLE") return err(403, "NOT_ELIGIBLE");
    if (e instanceof StoreError && (e.code === "PREFILL_UNAVAILABLE" || e.code === "PREFILL_CONFIGURATION")) return err(503, e.code);
    // Same key, different content, found in the document store when the ledger could not arbitrate (e.g. after its loss).
    if (e instanceof StoreError && e.code === "WD_SUBMISSION_CONFLICT") return err(409, "SUBMISSION_CONFLICT");
    return err(503, "STORAGE_UNAVAILABLE");
  };

  async function bootstrap(token: string): Promise<Result> {
    const startedAt = now();
    const claims = await authorize(token);
    if ("status" in claims) return claims;
    try {
      const resolved = await deps.directory.resolve(claims.subject, claims);
      if (!resolved) return err(404, "SESSION_NOT_FOUND");
      // Prefill runs only AFTER authorisation and can neither grant nor deny access.
      const prefill = deps.directory.verificationGroupsFor?.(claims.subject) && deps.directory.consultationPrefill
        ? ((await deps.directory.consultationPrefill(claims.subject, claims))?.prefill ?? {})
        : resolved.prefill;
      return {
        status: 200,
        headers: { ...NO_STORE },
        body: {
          form_session_token: token,
          scope: claims.scope,
          entitlements: claims.entitlements,
          prefill,
          expires_at: new Date(claims.exp * 1000).toISOString(),
        },
      };
    } catch (e) {
      return failure(e, startedAt);
    }
  }

  async function submit(input: SubmitInput): Promise<Result> {
    const startedAt = now();
    if (!SUBMISSION_ID_PATTERN.test(input.submissionId) || input.idempotencyKey !== input.submissionId) return err(400, "INVALID_SUBMISSION");
    const claims = await authorize(input.token);
    if ("status" in claims) return claims;

    let prefillBases: Set<string>;
    try {
      const resolved = await deps.directory.resolve(claims.subject, claims);
      if (!resolved) return err(404, "SESSION_NOT_FOUND");
      // Static groups when the directory provides them (no second lookup at submit); otherwise derived from the resolved prefill.
      prefillBases = new Set(deps.directory.verificationGroupsFor?.(claims.subject) ?? Object.keys(resolved.prefill).map((k) => k.split(".")[0] as string));
    } catch (e) {
      return failure(e, startedAt);
    }

    let verification: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(input.verificationState || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!prefillBases.has(k) || (v !== "confirmed" && v !== "edited")) throw new Error("value");
        verification[k] = v;
      }
    } catch {
      return err(400, "INVALID_VERIFICATION_STATE");
    }
    verification = Object.fromEntries(Object.entries(verification).sort(([a], [b]) => (a < b ? -1 : 1)));

    const validated = validateSubmission(input.answers, input.files, { scope: claims.scope, entitlements: claims.entitlements, now: new Date(now()) });
    if (!validated.ok) {
      log("onboarding.rejected.invalid_payload", { issues: validated.issues.length });
      return err(422, "INVALID_PAYLOAD", { issues: validated.issues satisfies Issue[] });
    }

    const files: StoredFile[] = validated.files.map((f) => {
      const src = input.files[f.key] as FileInput & { bytes: Uint8Array };
      return { key: f.key, name: f.name, type: f.type, size: f.size, sha256: sha256Hex(src.bytes) };
    });
    const key = subjectKey(claims);
    const fp = fingerprint({
      subject: claims.subject,
      scope: claims.scope,
      entitlements: claims.entitlements,
      answers: validated.answers,
      verification_state: verification,
      files: files.map((f) => ({ key: f.key, sha256: f.sha256, size: f.size, type: f.type })),
    });

    const done = (r: Result, event: string): Result => {
      log(event, { status: r.status, ms: now() - startedAt });
      return r;
    };
    const ok = (deduplicated: boolean): Result => ({
      status: 200,
      headers: { ...NO_STORE },
      body: { status: "completed", submission_id: input.submissionId, deduplicated },
    });

    try {
      const existing = await deps.store.get(key);
      if (existing) return existing.fingerprint === fp ? done(ok(true), "onboarding.deduplicated") : done(err(409, "SUBMISSION_CONFLICT"), "onboarding.conflict");

      // Files first (content-addressed, idempotent on retry), so the CRM record can reference them.
      // A deferred sink (WorkDrive) writes them later, under the ledger claim, inside `store.create`: nothing is written here.
      const stored: StoredFile[] = [];
      const fileBytes: Record<string, Uint8Array> = {};
      for (const f of files) {
        const src = input.files[f.key] as FileInput & { bytes: Uint8Array };
        if (deps.sink.deferred) {
          fileBytes[f.key] = src.bytes;
          stored.push({ ...f });
          continue;
        }
        const ref = await deps.sink.put(key, f.key, { name: f.name, type: f.type, bytes: src.bytes, sha256: f.sha256 });
        stored.push({ ...f, ref });
      }

      const record: SubmissionRecord = {
        subject_key: key,
        unique_form_key: uniqueFormKey(claims),
        fingerprint: fp,
        scope: claims.scope,
        subject: claims.subject,
        link_id: claims.jti,
        entitlements: claims.entitlements,
        answers: validated.answers,
        verification_state: verification,
        files: stored,
        submitted_at: new Date(now()).toISOString(),
        is_first_request: claims.isFirstRequest,
        product_related_to: claims.productRelatedTo,
      };
      const created = await deps.store.create(key, record, deps.sink.deferred ? { fileBytes } : undefined);
      if (created.status === "created") return done(ok(false), "onboarding.created");
      return created.record.fingerprint === fp ? done(ok(true), "onboarding.deduplicated") : done(err(409, "SUBMISSION_CONFLICT"), "onboarding.conflict");
    } catch (e) {
      return failure(e, startedAt);
    }
  }

  return { bootstrap, submit };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
