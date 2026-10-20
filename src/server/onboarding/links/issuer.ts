import { randomBytes } from "node:crypto";
import { KNOWN_ENTITLEMENTS, MAX_LINK_LIFETIME_S, signLinkToken, type LinkClaims } from "../tokens";
import type { ContactView, CrmDealReader, DealView, IssuedLinkRecord, IssuedLinkStore, ProductScopeMap, SubmissionStatusReader } from "./types";
import { CrmReadError } from "./types";
import { buildFormUrls, normalizeBaseUrl } from "./urls";

export type IssueErrorCode =
  | "INVALID_DEAL_ID"
  | "DEAL_NOT_FOUND"
  | "WRONG_ENVIRONMENT"
  | "NO_CONTACT"
  | "NO_CONTACT_CHANNEL"
  | "PRODUCT_MISSING"
  | "PRODUCT_UNMAPPED"
  | "ALREADY_SUBMITTED"
  | "SUBMISSION_UNRESOLVED"
  | "CRM_UNAVAILABLE"
  | "ISSUER_UNAVAILABLE";

export type IssueResult =
  | {
      ok: true;
      status: "issued" | "reused";
      deal_id: string;
      jti: string;
      expires_at: string;
      scope: string;
      entitlements: string[];
      is_first_request: boolean;
      /** `en` is `null` unless the frontend really renders English (`englishUi`); a link that shows Persian is never offered as English. */
      urls: { fa: string; en: string | null };
      language_support: { fa: true; en: boolean };
    }
  | { ok: false; httpStatus: number; error_code: IssueErrorCode; message: string; jti?: string };

export type IssuerDeps = {
  crm: CrmDealReader;
  products: ProductScopeMap;
  links: IssuedLinkStore;
  submissions: SubmissionStatusReader;
  /** True when the link was revoked (existing revocation facts). A failing check fails closed. */
  isRevoked: (jti: string) => Promise<boolean>;
  /** Secret of the onboarding backend (the SAME one the bootstrap validates with; one per environment). */
  secret: string;
  /** Public origin of the onboarding form (https, no path). */
  baseUrl: string;
  /** Organisation (zgid) the CRM reader must be connected to: the environment guard. */
  expectedOrgId: string;
  /** True only when the frontend genuinely renders English for `lang=en`. Default false (it does not today). */
  englishUi?: boolean;
  /** Lifetime of a new link. A PROVISIONAL default (Product decision pending), capped by the token contract. */
  ttlSeconds: number;
  now?: () => number;
  newJti?: () => string;
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

const DEAL_ID = /^\d{6,25}$/;
const fail = (httpStatus: number, error_code: IssueErrorCode, message: string, extra: { jti?: string } = {}): IssueResult => ({ ok: false, httpStatus, error_code, message, ...extra });

/** The ONE place the token claims are assembled: the same record always yields byte-identical claims (and token). */
export function claimsOf(r: IssuedLinkRecord): Record<string, unknown> {
  return {
    v: 2,
    deal_id: r.deal_id,
    jti: r.jti,
    scope: r.scope,
    entitlements: r.entitlements,
    exp: r.exp,
    is_first_request: r.is_first_request,
    ...(r.product_related_to ? { product_related_to: r.product_related_to } : {}),
  };
}

/** `LinkClaims` of a stored record (used to find its ledger entry; works for expired links too). */
export const linkClaimsOf = (r: IssuedLinkRecord): LinkClaims => ({
  v: 2,
  subject: { kind: "deal", dealId: r.deal_id },
  scope: r.scope,
  entitlements: r.entitlements,
  exp: r.exp,
  jti: r.jti,
  isFirstRequest: r.is_first_request,
  productRelatedTo: r.product_related_to,
});

/**
 * Link Issuer (local, mock-tested). One job: turn a trusted Deal id into a signed link for the new onboarding form.
 * It READS the CRM (Deal, Contact, prior Requests) and NEVER writes anything: no CRM update, no Request, no message,
 * no WorkDrive. Product scope comes only from the explicit mapping; an unmapped product is refused.
 *
 * Reuse rule (provisional, Product decision pending): the newest link of the Deal is reused while it is unexpired,
 * unrevoked, unsubmitted and still matches the Deal's current mapping; a submitted or unresolved link stops issuance.
 */
export function createLinkIssuer(deps: IssuerDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  if (deps.secret.length < 32) throw new Error("ISSUER_SECRET_TOO_SHORT");
  if (!Number.isInteger(deps.ttlSeconds) || deps.ttlSeconds < 60 || deps.ttlSeconds > MAX_LINK_LIFETIME_S - 60) throw new Error("ISSUER_TTL_INVALID");
  const newJti = deps.newJti ?? (() => randomBytes(18).toString("base64url"));

  const englishUi = deps.englishUi === true;
  const respond = (status: "issued" | "reused", r: IssuedLinkRecord): IssueResult => {
    const token = signLinkToken(claimsOf(r), deps.secret);
    const urls = buildFormUrls(baseUrl, token);
    return {
      ok: true,
      status,
      deal_id: r.deal_id,
      jti: r.jti,
      expires_at: new Date(r.exp * 1000).toISOString(),
      scope: r.scope,
      entitlements: [...r.entitlements],
      is_first_request: r.is_first_request,
      urls: { fa: urls.fa, en: englishUi ? urls.en : null },
      language_support: { fa: true, en: englishUi },
    };
  };

  /** One issuance per Deal at a time inside this process (a second process still relies on the registry's compare-and-set). */
  const chains = new Map<string, Promise<unknown>>();
  function issue(dealIdInput: unknown): Promise<IssueResult> {
    if (typeof dealIdInput !== "string" || !DEAL_ID.test(dealIdInput)) return Promise.resolve(fail(400, "INVALID_DEAL_ID", "invalid deal id"));
    const key = dealIdInput;
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => issueOne(key));
    chains.set(key, run);
    void run.finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
    return run;
  }

  async function issueOne(dealId: string): Promise<IssueResult> {

    let deal: DealView | null;
    let contact: ContactView | null = null;
    let priorRequests = false;
    try {
      deal = await deps.crm.getDeal(dealId);
      if (!deal) return fail(404, "DEAL_NOT_FOUND", "deal not found");
      if (deal.id !== dealId || deal.orgId !== deps.expectedOrgId) {
        log("links.wrong_environment");
        return fail(403, "WRONG_ENVIRONMENT", "deal belongs to another environment");
      }
      if (!deal.contactId) return fail(422, "NO_CONTACT", "deal has no associated contact");
      contact = await deps.crm.getContact(deal.contactId);
      if (!contact || contact.id !== deal.contactId) return fail(422, "NO_CONTACT", "associated contact could not be resolved");
      if (!contact.email && !contact.phone && !contact.mobile) return fail(422, "NO_CONTACT_CHANNEL", "contact has no email, phone or mobile");
      if (!deal.productId) return fail(422, "PRODUCT_MISSING", "deal has no product");
      priorRequests = await deps.crm.hasPriorRequests(contact.id);
    } catch (e) {
      log("links.crm_unavailable", { kind: e instanceof CrmReadError ? e.code : "UNEXPECTED" });
      return fail(503, "CRM_UNAVAILABLE", "crm could not be read");
    }

    const mapping = deps.products.map({ id: deal.productId, name: deal.productName, productRelatedTo: deal.productRelatedTo });
    if (!mapping || mapping.entitlements.some((x) => !KNOWN_ENTITLEMENTS.has(x))) return fail(422, "PRODUCT_UNMAPPED", "no approved mapping for this product");
    const entitlements = [...new Set(mapping.entitlements)].sort();

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = await deps.links.latestFor(dealId);
        if (latest) {
          const state = await deps.submissions.statusFor(latest);
          if (state === "submitted") return fail(409, "ALREADY_SUBMITTED", "a link of this deal was already submitted", { jti: latest.jti });
          if (state === "unresolved") return fail(409, "SUBMISSION_UNRESOLVED", "a submission of this deal is unresolved", { jti: latest.jti });
          const stillMatches = latest.scope === mapping.scope && latest.product_id === deal.productId && latest.entitlements.join(",") === entitlements.join(",");
          const unexpired = latest.exp > Math.floor(now() / 1000) + 60;
          if (unexpired && stillMatches && !(await deps.isRevoked(latest.jti))) {
            log("links.reused");
            return respond("reused", latest);
          }
        }
        const iat = Math.floor(now() / 1000);
        const record: IssuedLinkRecord = {
          deal_id: dealId,
          jti: newJti(),
          scope: mapping.scope,
          entitlements,
          iat,
          exp: iat + deps.ttlSeconds,
          product_id: deal.productId,
          is_first_request: !priorRequests,
          ...(deal.productRelatedTo && deal.productRelatedTo.length <= 255 ? { product_related_to: deal.productRelatedTo } : {}),
        };
        if (await deps.links.tryRecord(record, latest?.jti ?? null)) {
          log("links.issued");
          return respond("issued", record);
        }
        // Lost the race to a concurrent click: re-read and reuse that link.
      }
      return fail(503, "ISSUER_UNAVAILABLE", "could not settle link state");
    } catch {
      log("links.issuer_failure");
      return fail(503, "ISSUER_UNAVAILABLE", "link issuer unavailable");
    }
  }

  return { issue };
}

export type LinkIssuer = ReturnType<typeof createLinkIssuer>;
