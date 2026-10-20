import { join } from "node:path";
import { createCrmReader } from "./crm-reader";
import { ledgerDirOf } from "../crm/factory";
import { StoreError } from "../errors";
import { IdempotencyLedger } from "../ledger";
import { FactStore, revocationKey } from "../payments/facts";
import { handleIssueLink } from "./http";
import { createLinkIssuer } from "./issuer";
import { productMapFromEnv } from "./product-map";
import { FileIssuedLinkStore } from "./registry";
import { LedgerSubmissionStatusReader } from "./status";
import type { CrmDealReader, IssuedLinkStore, SubmissionStatusReader } from "./types";

/** Server-side collaborators of the issuer. When not supplied they are built from the environment (see `defaultIssuerExtras`). */
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
let memo: IssuerRuntimeExtras | null = null;
export const resetIssuerRuntimeCache = (): void => {
  memo = null;
};

/**
 * Real collaborators for the CRM-backed store: the READ-ONLY Sandbox reader, the durable hard-link registry under the
 * private storage directory and the ledger-backed submission status. Built once per process (the reader keeps its OAuth
 * token and environment verification). Returns `{}` (the route then answers 503) when the CRM store is not enabled or
 * incompletely configured: nothing is ever issued without a verified reader.
 */
export function defaultIssuerExtras(env: Record<string, string | undefined>): IssuerRuntimeExtras {
  if (memo) return memo;
  try {
    if ((env["SIX2FIT_ONBOARDING_STORE"] ?? "").trim().toLowerCase() !== "crm") return {};
    const storageDir = req(env, "SIX2FIT_STAGING_STORAGE_DIR");
    const { reader } = createCrmReader(env);
    memo = {
      crm: reader,
      links: new FileIssuedLinkStore(join(storageDir, "issued-links")),
      submissions: new LedgerSubmissionStatusReader(new IdempotencyLedger(ledgerDirOf(env, join(storageDir, "onboarding-ledger")))),
    };
    return memo;
  } catch {
    return {};
  }
}

export async function handleIssueLinkFromEnv(request: Request, supplied: IssuerRuntimeExtras = {}, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const extras: IssuerRuntimeExtras = { ...defaultIssuerExtras(env), ...supplied };
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
