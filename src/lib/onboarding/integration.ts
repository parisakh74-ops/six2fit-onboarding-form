import { z } from "zod";
import type { Answers, Scope } from "./data";

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
  const endpoint = new URL(import.meta.env["VITE_ONBOARDING_BOOTSTRAP_PATH"] || "/api/onboarding/bootstrap", window.location.origin);
  const session = new URLSearchParams(window.location.search).get("session");
  if (!session) throw new Error("BOOTSTRAP_UNAVAILABLE");
  endpoint.searchParams.set("session", session);
  const response = await fetch(endpoint, {
    method: "GET",
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

function appendAnswer(form: FormData, key: string, value: unknown) {
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
  const submissionId = makeSubmissionId();
  const form = new FormData();
  form.append("form_session_token", bootstrap.form_session_token);
  form.append("submission_id", submissionId);
  form.append("verification_state", JSON.stringify(verificationState));
  for (const [key, value] of Object.entries(answers)) appendAnswer(form, key, value);

  const endpoint = import.meta.env["VITE_ONBOARDING_SUBMIT_PATH"] || "/api/onboarding/submit";
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
    throw new Error("SUBMISSION_FAILED");
  }
  const result = await response.json().catch(() => ({}));
  if (!result || result.status !== "accepted" && result.status !== "completed") {
    throw new Error("SUBMISSION_INVALID_RESPONSE");
  }
  return { submissionId, result };
}
