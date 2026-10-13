import { z } from "zod";
import type { Answers, Scope } from "./data";
import { fileOf } from "./files";

const scopeSchema = z.enum(["Diet", "Training", "Combo", "CIP"]);

const bootstrapSchema = z.object({
  form_session_token: z.string().min(20),
  scope: scopeSchema,
  entitlements: z.array(z.string()).default([]),
  prefill: z.record(z.unknown()).default({}),
  expires_at: z.string().datetime(),
});

export type OnboardingBootstrap = {
  form_session_token: string;
  scope: Scope;
  entitlements: string[];
  prefill: Answers;
  expires_at: string;
};

export async function loadBootstrap(signal?: AbortSignal): Promise<OnboardingBootstrap> {
  const endpoint = new URL(import.meta.env["VITE_ONBOARDING_BOOTSTRAP_PATH"] || "/?six2fit_api=bootstrap", window.location.origin);
  const session = new URLSearchParams(window.location.search).get("session");
  if (!session) throw new Error("BOOTSTRAP_UNAVAILABLE");
  endpoint.searchParams.set("session", session);
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("BOOTSTRAP_UNAVAILABLE");
  const parsed = bootstrapSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("BOOTSTRAP_INVALID");
  return parsed.data;
}

function makeSubmissionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  throw new Error("SECURE_RANDOM_UNAVAILABLE");
}

/**
 * One submission id per link until the submission succeeds: a retry after a lost response reuses it (same Idempotency-Key)
 * instead of looking like a new submission. The server also deduplicates per link, so this is defence in depth.
 */
const SID_KEY = "six2fit-onboarding-sid:";
function stableSubmissionId(token: string): string {
  const key = SID_KEY + token.slice(-24);
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[0-9a-f-]{20,80}$/i.test(existing)) return existing;
    const id = makeSubmissionId();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return makeSubmissionId();
  }
}
function forgetSubmissionId(token: string) {
  try {
    sessionStorage.removeItem(SID_KEY + token.slice(-24));
  } catch {
    /* ignore */
  }
}

function appendAnswer(form: FormData, key: string, value: unknown) {
  const remembered = fileOf(value);
  if (remembered) {
    form.append(`file:${key}`, remembered, remembered.name);
    return;
  }
  // File metadata restored from autosave has no bytes: never send it as text ("[object Object]").
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof File)) return;
  if (value instanceof File) {
    form.append(`file:${key}`, value, value.name);
    return;
  }
  if (Array.isArray(value)) {
    form.append(`answer:${key}`, JSON.stringify(value));
    return;
  }
  form.append(`answer:${key}`, String(value));
}

export async function submitOnboarding(
  bootstrap: OnboardingBootstrap,
  answers: Answers,
  verificationState: Record<string, string>,
) {
  const submissionId = stableSubmissionId(bootstrap.form_session_token);
  const form = new FormData();
  form.append("form_session_token", bootstrap.form_session_token);
  form.append("submission_id", submissionId);
  form.append("verification_state", JSON.stringify(verificationState));
  for (const [key, value] of Object.entries(answers)) appendAnswer(form, key, value);

  const endpoint = import.meta.env["VITE_ONBOARDING_SUBMIT_PATH"] || "/?six2fit_api=submit";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Idempotency-Key": submissionId,
    },
    body: form,
  });
  if (!response.ok) {
    if (response.status === 409) throw new Error("SUBMISSION_CONFLICT");
    if (response.status === 401) throw new Error("SESSION_EXPIRED");
    if (response.status === 422) throw new Error("SUBMISSION_INVALID");
    throw new Error("SUBMISSION_FAILED");
  }
  const result = await response.json().catch(() => ({}));
  if (!result || result.status !== "accepted" && result.status !== "completed") {
    throw new Error("SUBMISSION_INVALID_RESPONSE");
  }
  forgetSubmissionId(bootstrap.form_session_token);
  return { submissionId, result };
}
