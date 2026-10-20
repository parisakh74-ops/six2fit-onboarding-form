import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../canonical";

/**
 * Authentication of the internal caller (the CRM Function). HMAC-SHA256 over `timestamp.METHOD.path.sha256(body)` with a
 * secret that is separate from the token-signing secret and from every other credential. The timestamp window (default
 * 5 minutes) bounds replay; a replayed request only re-issues or re-reads the same idempotent link and mutates nothing else.
 */
export const SIGNATURE_HEADER = "x-s2f-signature";
export const TIMESTAMP_HEADER = "x-s2f-timestamp";
export const MIN_ISSUER_SECRET_CHARS = 32;

const mac = (secret: string, timestamp: string, method: string, path: string, body: string): string =>
  createHmac("sha256", secret).update(`${timestamp}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`).digest("hex");

export function signIssuerRequest(secret: string, timestampSec: number, method: string, path: string, body: string): string {
  if (secret.length < MIN_ISSUER_SECRET_CHARS) throw new Error("ISSUER_SECRET_TOO_SHORT");
  return mac(secret, String(timestampSec), method, path, body);
}

export function verifyIssuerRequest(
  secret: string,
  input: { timestamp: string | null; signature: string | null; method: string; path: string; body: string },
  nowMs: number,
  skewSec = 300,
): boolean {
  if (secret.length < MIN_ISSUER_SECRET_CHARS) return false;
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{9,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > skewSec) return false;
  const expected = Buffer.from(mac(secret, timestamp, input.method, input.path, input.body), "hex");
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
