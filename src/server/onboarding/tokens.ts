import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./canonical";

/**
 * Signed onboarding link tokens (HMAC-SHA256, `base64url(payload).base64url(signature)`).
 *
 *  - v1 (existing, Approved/Tested contract of the Consultation hand-off): `{v:1, consult_submission_id, scope, entitlements, exp}`.
 *    Binds the link to a Consultation submission. Kept verbatim so the Consultation service stays compatible.
 *  - v2 (PROPOSAL, not yet issued by any system): `{v:2, deal_id, jti, scope, entitlements, exp, is_first_request?, product_related_to?}`.
 *    Binds the link to ONE CRM Deal (the Production onboarding link is built from the Deal today: dealId, productName,
 *    productRelatedTo, isFirstReq). `jti` is the unique link id; one link can complete the form once.
 * Scope and entitlements come only from the signed claims, never from the URL or the browser.
 */
export type Scope = "Diet" | "Training" | "Combo" | "CIP";
export type Subject = { kind: "consult"; consultSubmissionId: string } | { kind: "deal"; dealId: string };
export type LinkClaims = {
  subject: Subject;
  scope: Scope;
  entitlements: string[];
  /** Unix seconds. */
  exp: number;
  /** Unique id of the link (v2) or a stable derivation of the Consultation submission id (v1). */
  jti: string;
  isFirstRequest?: boolean | undefined;
  productRelatedTo?: string | undefined;
  v: 1 | 2;
};

export class TokenError extends Error {
  constructor(public readonly code: "MALFORMED" | "SIGNATURE" | "EXPIRED" | "CLAIMS" | "SECRET") {
    super(`token ${code}`);
    this.name = "TokenError";
  }
}

const SCOPES = new Set<string>(["Diet", "Training", "Combo", "CIP"]);
/** Add-ons a signed link may grant (data-driven by the order, never inferred from the scope). */
export const KNOWN_ENTITLEMENTS = new Set<string>(["cellulite"]);
const MAX_TOKEN_CHARS = 2048;
/** A link may not be valid for more than this (guards against an issuer that forgets `exp`). */
export const MAX_LINK_LIFETIME_S = 90 * 24 * 3600;

const b64 = (s: string) => Buffer.from(s, "base64url");

export function signLinkToken(claims: Record<string, unknown>, secret: string): string {
  if (secret.length < 32) throw new TokenError("SECRET");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyLinkToken(token: string, secret: string, nowMs: number = Date.now()): LinkClaims {
  if (secret.length < 32) throw new TokenError("SECRET");
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) throw new TokenError("MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TokenError("MALFORMED");
  const [payload, signature] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = b64(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new TokenError("SIGNATURE");

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(b64(payload).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new TokenError("MALFORMED");
  }

  const exp = raw["exp"];
  if (typeof exp !== "number" || !Number.isInteger(exp)) throw new TokenError("CLAIMS");
  const nowS = Math.floor(nowMs / 1000);
  if (exp <= nowS) throw new TokenError("EXPIRED");
  if (exp - nowS > MAX_LINK_LIFETIME_S) throw new TokenError("CLAIMS");

  const scope = raw["scope"];
  if (typeof scope !== "string" || !SCOPES.has(scope)) throw new TokenError("CLAIMS");
  const entRaw = raw["entitlements"] ?? [];
  if (!Array.isArray(entRaw) || entRaw.some((e) => typeof e !== "string" || !KNOWN_ENTITLEMENTS.has(e))) throw new TokenError("CLAIMS");
  const entitlements = [...new Set(entRaw as string[])].sort();

  if (raw["v"] === 1) {
    const id = raw["consult_submission_id"];
    if (typeof id !== "string" || !/^cns_[0-9a-f-]{20,60}$/i.test(id)) throw new TokenError("CLAIMS");
    return { v: 1, subject: { kind: "consult", consultSubmissionId: id }, scope: scope as Scope, entitlements, exp, jti: `c1_${sha256Hex(id).slice(0, 32)}` };
  }
  if (raw["v"] === 2) {
    const dealId = raw["deal_id"];
    const jti = raw["jti"];
    if (typeof dealId !== "string" || !/^\d{6,25}$/.test(dealId)) throw new TokenError("CLAIMS");
    if (typeof jti !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(jti)) throw new TokenError("CLAIMS");
    const first = raw["is_first_request"];
    const prod = raw["product_related_to"];
    if (first !== undefined && typeof first !== "boolean") throw new TokenError("CLAIMS");
    if (prod !== undefined && (typeof prod !== "string" || prod.length > 255)) throw new TokenError("CLAIMS");
    return { v: 2, subject: { kind: "deal", dealId }, scope: scope as Scope, entitlements, exp, jti, isFirstRequest: first as boolean | undefined, productRelatedTo: prod as string | undefined };
  }
  throw new TokenError("CLAIMS");
}

/** Id of the idempotency/ledger entry: one onboarding per link. Safe for file names. */
export const subjectKey = (claims: LinkClaims): string => `onb_${sha256Hex(`${claims.v}:${claims.subject.kind === "deal" ? claims.subject.dealId : claims.subject.consultSubmissionId}:${claims.v === 2 ? claims.jti : ""}`).slice(0, 40)}`;

/** Deterministic CRM unique key (`uniqueformkey`), prefixed so it can never collide with the legacy Zoho Forms keys. */
export const uniqueFormKey = (claims: LinkClaims): string =>
  claims.subject.kind === "deal" ? `onb2_${claims.subject.dealId}_${claims.jti}` : `onb1_${claims.subject.consultSubmissionId}`;
