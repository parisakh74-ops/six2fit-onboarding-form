import { sha256Hex } from "../canonical";
import { JPEG_HEAD, validAnswers } from "../fixtures";

/**
 * Fixtures shared by the operator-run LIVE tests and their mock REHEARSAL (`live-rehearsal.test.ts`), so a fixture defect is
 * caught locally before a live attempt. Synthetic data only.
 */
export const LIVE_MARK = "S2F-TEST-ONBOARDING-20261021";
export const LIVE_EMAIL = "s2f-test-onboarding-20261021@s2f-test.example.invalid";

/**
 * A submission id the service accepts: `SUBMISSION_ID_PATTERN` is /^[0-9a-f-]{20,80}$/i (HEX digits and dashes only).
 * Derived from a hash so any tag/stamp (e.g. a base-36 timestamp) yields a valid uuid-shaped id.
 * (The first live attempt used a base-36 stamp directly and was refused with 400 INVALID_SUBMISSION before any write.)
 */
export function liveSubmissionId(tag: string, stamp: string): string {
  const h = sha256Hex(`submission:${tag}:${stamp}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function syntheticAnswers(email: string = LIVE_EMAIL): Record<string, string> {
  return validAnswers("Combo", { "ON-01": "S2F-TEST Synthetic", "ON-07": email, "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
}

/** Deterministic pseudo-image (valid JPEG header + patterned bytes): no real picture content. */
export function syntheticFile(size = 4096): Uint8Array {
  const b = new Uint8Array(size);
  b.set(JPEG_HEAD);
  for (let i = 16; i < b.length; i += 1) b[i] = (i * 37 + 11) & 0xff;
  return b;
}

export function buildSubmitRequest(opts: { token: string; submissionId: string; answers: Record<string, string>; file: Uint8Array; host?: string }): Request {
  const form = new FormData();
  form.append("form_session_token", opts.token);
  form.append("submission_id", opts.submissionId);
  form.append("verification_state", "{}");
  for (const [k, v] of Object.entries(opts.answers)) form.append(`answer:${k}`, v);
  form.append("file:MS-05.front", new File([opts.file as BlobPart], "front.jpg", { type: "image/jpeg" }));
  return new Request(`${opts.host ?? "https://onboarding-staging.6tofit.com"}/api/onboarding/submit`, { method: "POST", headers: { "idempotency-key": opts.submissionId }, body: form });
}
