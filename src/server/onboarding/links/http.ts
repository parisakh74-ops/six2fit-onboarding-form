import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyIssuerRequest } from "./auth";
import type { LinkIssuer } from "./issuer";

/** Path the CRM Function calls. It is part of the request signature. (Route registration is a separate, later step.) */
export const ISSUE_LINK_PATH = "/api/internal/onboarding-link";
/** Same fallback the other APIs use when Passenger rewrites sub-paths: POST `/?six2fit_api=issue_link`. The signature always covers the canonical path. */
export const ISSUE_LINK_ACTION = "issue_link";

/** True when the request addresses the issuer (canonical path or the sub-path-safe alias). */
export function isIssueLinkRequest(request: Request): boolean {
  const u = new URL(request.url);
  return request.method === "POST" && (u.pathname === ISSUE_LINK_PATH || (u.pathname === "/" && u.searchParams.get("six2fit_api") === ISSUE_LINK_ACTION));
}
const MAX_BODY_BYTES = 1024;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

export type IssueLinkHttpDeps = {
  issuer: LinkIssuer;
  /** Secret of the internal caller (distinct from the token-signing secret). */
  callerSecret: string;
  now?: () => number;
};

const plain = (status: number, error_code: string): Response => Response.json({ error_code, message: error_code }, { status, headers: HEADERS });

/**
 * POST { "deal_id": "<digits>" } from a signed internal caller -> a signed onboarding link for that Deal.
 * The response never contains customer data: ids, scope, expiry and the two form URLs only.
 */
export async function handleIssueLink(request: Request, deps: IssueLinkHttpDeps): Promise<Response> {
  if (request.method !== "POST") return plain(405, "METHOD_NOT_ALLOWED");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return plain(413, "PAYLOAD_TOO_LARGE");
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return plain(413, "PAYLOAD_TOO_LARGE");

  const path = ISSUE_LINK_PATH; // canonical: identical for both spellings
  const authorized = isIssueLinkRequest(request) && verifyIssuerRequest(deps.callerSecret, { timestamp: request.headers.get(TIMESTAMP_HEADER), signature: request.headers.get(SIGNATURE_HEADER), method: request.method, path, body }, (deps.now ?? (() => Date.now()))());
  if (!authorized) return plain(401, "UNAUTHORIZED");

  let dealId: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((k) => k !== "deal_id")) throw new Error("shape");
    dealId = (parsed as Record<string, unknown>)["deal_id"];
  } catch {
    return plain(400, "INVALID_REQUEST");
  }

  const result = await deps.issuer.issue(dealId);
  if (!result.ok) return Response.json({ error_code: result.error_code, message: result.message, ...(result.jti ? { jti: result.jti } : {}) }, { status: result.httpStatus, headers: HEADERS });
  const { ok: _ok, ...payload } = result;
  return Response.json(payload, { status: 200, headers: HEADERS });
}
