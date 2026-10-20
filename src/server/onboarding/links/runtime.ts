import { join } from "node:path";
import { StoreError } from "../errors";
import { FactStore, revocationKey } from "../payments/facts";
import { handleIssueLink } from "./http";
import { createLinkIssuer } from "./issuer";
import { productMapFromEnv } from "./product-map";
import type { CrmDealReader, IssuedLinkStore, SubmissionStatusReader } from "./types";

/** Server-side collaborators that do not exist yet in the deployed runtime (real read-only CRM reader, durable registry). */
export type IssuerRuntimeExtras = { crm?: CrmDealReader; links?: IssuedLinkStore; submissions?: SubmissionStatusReader; now?: () => number };

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const unavailable = (): Response => Response.json({ error_code: "ISSUER_NOT_CONFIGURED", message: "ISSUER_NOT_CONFIGURED" }, { status: 503, headers: HEADERS });

const req = (env: Record<string, string | undefined>, name: string): string => {
  const v = (env[name] ?? "").trim();
  if (!v) throw new StoreError("NOT_CONFIGURED", "missing configuration", "CONFIG");
  return v;
};

/**
 * Entry point of the internal issuer route. Fails closed (503) until every collaborator and setting is present, so
 * registering the route changes nothing in production behaviour: no reader / registry => no link can be issued.
 */
export async function handleIssueLinkFromEnv(request: Request, extras: IssuerRuntimeExtras = {}, env: Record<string, string | undefined> = process.env): Promise<Response> {
  if (!extras.crm || !extras.links || !extras.submissions) return unavailable();
  try {
    const secret = req(env, "SIX2FIT_ONBOARDING_TOKEN_SECRET");
    const payments = new FactStore(join(req(env, "SIX2FIT_STAGING_STORAGE_DIR"), "payments"));
    const issuer = createLinkIssuer({
      crm: extras.crm,
      products: productMapFromEnv(env["SIX2FIT_PRODUCT_SCOPE_MAP"]),
      links: extras.links,
      submissions: extras.submissions,
      isRevoked: async (jti) => (await payments.get(revocationKey(jti), "revoked")) !== null,
      secret,
      baseUrl: req(env, "SIX2FIT_FORM_BASE_URL"),
      expectedOrgId: req(env, "SIX2FIT_EXPECTED_ORG_ID"),
      englishUi: false,
      ttlSeconds: Number(req(env, "SIX2FIT_LINK_TTL_SECONDS")),
      ...(extras.now ? { now: extras.now } : {}),
    });
    return await handleIssueLink(request, { issuer, callerSecret: req(env, "SIX2FIT_ISSUER_CALLER_SECRET"), ...(extras.now ? { now: extras.now } : {}) });
  } catch {
    return unavailable();
  }
}
