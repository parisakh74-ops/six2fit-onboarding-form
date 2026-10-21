import { sha256Hex } from "../canonical";
import { JPEG_HEAD, PDF_HEAD, PNG_HEAD, validAnswers } from "../fixtures";

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

/**
 * Answers that make ALL seven upload fields legitimate (the form activates a field only when its branch is on): equipment at home
 * (TR-05 home -> TR-06 + other photo), the cellulite add-on consent (MS-06; the signed link must carry the `cellulite` entitlement)
 * and the health-data consent that a medical document requires (CN-02). Found by the mock rehearsal (422 INACTIVE_FIELD / REQUIRED).
 */
export function syntheticMultiFileAnswers(email: string = LIVE_EMAIL): Record<string, string> {
  return validAnswers("Combo", { "ON-01": "S2F-TEST Synthetic", "ON-07": email, "TR-05": "home", "TR-06": ["dumbbell", "band"], "TR-06.other_name": "S2F-TEST synthetic item", "MS-06.consent": true, "CN-02": true, "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
}

/** The entitlement the multi-file submission needs on its signed link (and in the product map of the synthetic Product). */
export const MULTIFILE_ENTITLEMENTS = ["cellulite"] as const;

export type SyntheticFile = { name: string; type: "image/jpeg" | "image/png" | "application/pdf"; bytes: Uint8Array };

function pattern(head: Uint8Array, size: number, seed: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set(head);
  for (let i = head.length; i < size; i += 1) b[i] = (i * 31 + seed * 17 + 5) & 0xff;
  return b;
}

/**
 * Seven distinct synthetic uploads, one per accepted file field (body photos, a medical-document PDF, other photos). Every file has
 * its own size, seed and therefore its own SHA-256. Artificial bytes only: valid magic numbers, no picture or document content.
 */
export function syntheticFiles(): Record<string, SyntheticFile> {
  return {
    "MS-05.front": { name: "front.jpg", type: "image/jpeg", bytes: pattern(JPEG_HEAD, 3072, 1) },
    "MS-05.back": { name: "back.jpg", type: "image/jpeg", bytes: pattern(JPEG_HEAD, 4096, 2) },
    "MS-05.side": { name: "side.png", type: "image/png", bytes: pattern(PNG_HEAD, 5120, 3) },
    "MS-05.side_forward": { name: "side-forward.jpg", type: "image/jpeg", bytes: pattern(JPEG_HEAD, 6144, 4) },
    "MS-06.photo": { name: "measure.jpg", type: "image/jpeg", bytes: pattern(JPEG_HEAD, 7168, 5) },
    "TR-06.other_photo": { name: "other.png", type: "image/png", bytes: pattern(PNG_HEAD, 8192, 6) },
    "HL-09": { name: "document.pdf", type: "application/pdf", bytes: pattern(PDF_HEAD, 9216, 7) },
  };
}

export function buildMultiFileRequest(opts: { token: string; submissionId: string; answers: Record<string, string>; files: Record<string, SyntheticFile>; host?: string }): Request {
  const form = new FormData();
  form.append("form_session_token", opts.token);
  form.append("submission_id", opts.submissionId);
  form.append("verification_state", "{}");
  for (const [k, v] of Object.entries(opts.answers)) form.append(`answer:${k}`, v);
  for (const [k, f] of Object.entries(opts.files)) form.append(`file:${k}`, new File([f.bytes as BlobPart], f.name, { type: f.type }));
  return new Request(`${opts.host ?? "https://onboarding-staging.6tofit.com"}/api/onboarding/submit`, { method: "POST", headers: { "idempotency-key": opts.submissionId }, body: form });
}
