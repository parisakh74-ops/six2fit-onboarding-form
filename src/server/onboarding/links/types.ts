import type { Scope } from "../tokens";

/**
 * Ports of the Onboarding Link Issuer. Every CRM dependency is READ-ONLY by construction: there is no method that can
 * create, update or delete a CRM record, send a message or touch WorkDrive.
 */

export type DealView = {
  id: string;
  /** Organisation the record was read from (zgid); compared with the configured expectation (environment guard). */
  orgId: string;
  contactId: string | null;
  productId: string | null;
  productName: string | null;
  /** The `Product_Related_to` text of the Deal (carried into the token as a hint, never used for mapping). */
  productRelatedTo: string | null;
  /** Current value of the EXISTING Deal field `Persian_Form_Link` (read only). Lets reuse work without any new storage. */
  persianFormLink?: string | null;
  /** CRM creation time of the Deal (ISO). Used only to bound the Consultation prefill window. */
  createdAt?: string | null;
};

/** Contact facts needed to validate reachability. They are NEVER put into a URL, a token or a response. */
export type ContactView = { id: string; email: string | null; phone: string | null; mobile: string | null };

/** A Consultation record as seen by the read-only prefill lookup: identity fields and the minimal prefill block only. */
export type ConsultationCandidate = {
  id: string;
  /** Server creation time (ISO); the client timestamp is never trusted. */
  createdAt: string;
  email: string | null;
  whatsapp: string | null;
  /** Value of the plain `Contact` lookup when it was filled (strongest signal); `null` today. */
  contactId: string | null;
  prefillJson: string | null;
};

export interface CrmDealReader {
  getDeal(dealId: string): Promise<DealView | null>;
  getContact(contactId: string): Promise<ContactView | null>;
  /** True when the Contact already has at least one Request (mirrors the legacy `isFirstReq` rule). */
  hasPriorRequests(contactId: string): Promise<boolean>;
  /** Prefill support (all optional: a reader without them cannot serve prefill). Read-only, bounded, explicit field list. */
  findConsultationCandidates?(q: { contactId: string; emails: string[]; phones: string[]; limit: number }): Promise<ConsultationCandidate[]>;
  /** Ids of ALL Contacts carrying this normalised number (to detect shared numbers). */
  findContactIdsByPhone?(phone: string): Promise<string[]>;
  /** True when the Deal already has a Request with a completion date (then it is not its first onboarding cycle). */
  dealHasCompletedRequest?(dealId: string): Promise<boolean>;
}

export class CrmReadError extends Error {
  constructor(public readonly code: "UNAVAILABLE" | "FORBIDDEN" | "NOT_CONFIGURED") {
    super(`crm read ${code}`);
    this.name = "CrmReadError";
  }
}

export type ScopeMapping = {
  scope: Scope;
  entitlements: readonly string[];
  /**
   * Commercial attributes (Core/VIP level, duration) are DISTINCT from the token scope. They are kept for audit only and
   * never enter a token, a URL or a form decision. No default values exist: only an approved table can fill them.
   */
  commercial?: { level?: string; duration_months?: number };
};

/**
 * Explicit Product -> scope/entitlement mapping. It returns `null` for a product it has no approved entry for;
 * the issuer then refuses (`PRODUCT_UNMAPPED`). Nothing is ever guessed from names.
 */
export interface ProductScopeMap {
  map(product: { id: string; name: string | null; productRelatedTo: string | null }): ScopeMapping | null;
}

/** What is remembered about an issued link: ids, claims and timestamps only. No tokens, no names, no contact data. */
export type IssuedLinkRecord = {
  deal_id: string;
  jti: string;
  scope: Scope;
  entitlements: string[];
  /** Unix seconds. */
  iat: number;
  exp: number;
  product_id: string;
  is_first_request: boolean;
  product_related_to?: string | undefined;
};

/**
 * Minimum registry the reuse rule needs. NOT implemented persistently in this phase (see docs): the interface is
 * compare-and-set so two simultaneous clicks cannot issue two links.
 */
export interface IssuedLinkStore {
  latestFor(dealId: string): Promise<IssuedLinkRecord | null>;
  /** Stores `record` only if the latest link of the Deal is still `expectedLatestJti` (null = none). Returns false on a lost race. */
  tryRecord(record: IssuedLinkRecord, expectedLatestJti: string | null): Promise<boolean>;
}

export type LinkSubmissionStatus = "none" | "submitted" | "unresolved";

/** State of the submission made with a given link, derived from the onboarding ledger (not from the browser). */
export interface SubmissionStatusReader {
  statusFor(link: IssuedLinkRecord): Promise<LinkSubmissionStatus>;
}
