import { StoreError } from "../errors";
import type { PrefillResult, SubjectDirectory } from "../ports";
import type { LinkClaims, Subject } from "../tokens";
import { selectConsultationPrefill, normalizePhone, PREFILL_GROUPS, type PrefillDecision } from "./prefill";
import { CrmReadError, type CrmDealReader, type ProductScopeMap } from "./types";

export type DealDirectoryDeps = {
  crm: CrmDealReader;
  products: ProductScopeMap;
  /** Organisation (zgid) the reader must be connected to: the environment guard. */
  expectedOrgId: string;
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
  /** Consultation prefill. Absent or `enabled: false` = no prefill (empty form). */
  prefill?: {
    enabled: boolean;
    windowDays: number;
    limit: number;
    /** Receives ambiguity events (ids and a reason code only, never personal data). */
    onReview?: (e: { dealId: string; reason: string }) => void;
  };
};

const notEligible = (): StoreError => new StoreError("REJECTED", "link does not match trusted CRM data", "SUBJECT_NOT_ELIGIBLE");
const unavailable = (): StoreError => new StoreError("UNAVAILABLE", "crm could not be read", "IDENTITY_UNAVAILABLE");

/**
 * Deal-aware `SubjectDirectory` (READ-ONLY). The signed token proves the link was issued by us; this class re-checks it
 * against trusted CRM data on every bootstrap and submit:
 *   - the Deal exists and belongs to the configured organisation (environment guard);
 *   - the Deal still has a Contact that exists and matches the Deal's relation;
 *   - the Deal's Product still maps (explicit table only) to exactly the scope and entitlements claimed by the token.
 * It fails closed: any CRM read failure is `IDENTITY_UNAVAILABLE` (503); a mismatch is `SUBJECT_NOT_ELIGIBLE` (403); an
 * unknown Deal is `null` (404). The prefill is intentionally EMPTY: no customer data is copied out of the CRM.
 * It never writes anything and has no way to (the reader port is read-only).
 */
export class DealSubjectDirectory implements SubjectDirectory {
  constructor(private readonly deps: DealDirectoryDeps) {}

  async resolve(subject: Subject, claims?: LinkClaims): Promise<PrefillResult | null> {
    const log = this.deps.log ?? (() => undefined);
    if (subject.kind !== "deal" || !claims || claims.v !== 2 || claims.subject.kind !== "deal" || claims.subject.dealId !== subject.dealId) throw notEligible();
    try {
      const deal = await this.deps.crm.getDeal(subject.dealId);
      if (!deal) return null;
      if (deal.id !== subject.dealId || deal.orgId !== this.deps.expectedOrgId) {
        log("deal_directory.wrong_environment");
        throw notEligible();
      }
      if (!deal.contactId) throw notEligible();
      const contact = await this.deps.crm.getContact(deal.contactId);
      if (!contact || contact.id !== deal.contactId) throw notEligible();
      if (!deal.productId) throw notEligible();
      const mapping = this.deps.products.map({ id: deal.productId, name: deal.productName, productRelatedTo: deal.productRelatedTo });
      if (!mapping || mapping.scope !== claims.scope || [...new Set(mapping.entitlements)].sort().join(",") !== [...claims.entitlements].sort().join(",")) {
        log("deal_directory.scope_mismatch");
        throw notEligible();
      }
      return { prefill: {} };
    } catch (e) {
      if (e instanceof StoreError) throw e;
      log("deal_directory.crm_unavailable", { kind: e instanceof CrmReadError ? e.code : "UNEXPECTED" });
      throw unavailable();
    }
  }

  verificationGroupsFor(subject: Subject): ReadonlySet<string> | undefined {
    return subject.kind === "deal" && this.deps.prefill?.enabled ? PREFILL_GROUPS : undefined;
  }

  /**
   * Consultation prefill for the Deal's first onboarding cycle (read-only, after authorisation).
   * No match / ambiguity / stale data -> empty prefill (ambiguity also raises a review event).
   * CRM read error -> bounded retry, then PREFILL_UNAVAILABLE. Missing module/permission -> PREFILL_CONFIGURATION.
   */
  async consultationPrefill(subject: Subject, claims?: LinkClaims): Promise<{ prefill: Record<string, unknown> } | null> {
    const cfg = this.deps.prefill;
    if (!cfg?.enabled) return { prefill: {} };
    if (subject.kind !== "deal" || !claims) throw notEligible();
    const crm = this.deps.crm;
    if (!crm.findConsultationCandidates || !crm.findContactIdsByPhone || !crm.dealHasCompletedRequest) throw prefillConfiguration();
    const log = this.deps.log ?? (() => undefined);
    let decision: PrefillDecision;
    try {
      decision = await this.withRetry(async () => {
        const deal = await crm.getDeal(subject.dealId);
        if (!deal || deal.id !== subject.dealId || deal.orgId !== this.deps.expectedOrgId || !deal.contactId) throw notEligible();
        const contact = await crm.getContact(deal.contactId);
        if (!contact || contact.id !== deal.contactId) throw notEligible();
        const firstCycle = !(await crm.dealHasCompletedRequest!(deal.id));
        if (!firstCycle) return { prefill: {}, outcome: "not_first_cycle" } as PrefillDecision;
        const emails = [contact.email].filter((x): x is string => typeof x === "string" && x.length > 0);
        const phones = [...new Set([contact.mobile, contact.phone].map(normalizePhone).filter((p): p is string => p !== null))];
        const candidates = await crm.findConsultationCandidates!({ contactId: contact.id, emails, phones, limit: cfg.limit });
        const wanted = new Set<string>(phones);
        for (const c of candidates) {
          const p = normalizePhone(c.whatsapp);
          if (p) wanted.add(p);
        }
        const phoneOwners: Record<string, string[]> = {};
        for (const p of [...wanted].slice(0, cfg.limit + 2)) phoneOwners[p] = await crm.findContactIdsByPhone!(p);
        return selectConsultationPrefill({ dealCreatedAt: deal.createdAt ?? null, contact, candidates, phoneOwners, windowDays: cfg.windowDays, firstCycle });
      });
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const code = e instanceof CrmReadError ? e.code : "UNEXPECTED";
      log("deal_directory.prefill_failed", { kind: code });
      throw code === "FORBIDDEN" || code === "NOT_CONFIGURED" ? prefillConfiguration() : prefillUnavailable();
    }
    log("deal_directory.prefill", { outcome: decision.outcome, keys: Object.keys(decision.prefill).length });
    if (decision.outcome === "ambiguous") cfg.onReview?.({ dealId: subject.dealId, reason: "AMBIGUOUS_IDENTITY" });
    return { prefill: decision.prefill };
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < PREFILL_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (!(e instanceof CrmReadError) || e.code !== "UNAVAILABLE") throw e;
      }
    }
    throw last;
  }
}

const PREFILL_ATTEMPTS = 2;
const prefillUnavailable = (): StoreError => new StoreError("UNAVAILABLE", "prefill source could not be read", "PREFILL_UNAVAILABLE");
const prefillConfiguration = (): StoreError => new StoreError("NOT_CONFIGURED", "prefill source is not configured", "PREFILL_CONFIGURATION");

/** Routes by subject kind: Consultation links keep their file hand-off resolver unchanged; Deal links use the CRM resolver. */
export class CompositeSubjectDirectory implements SubjectDirectory {
  constructor(
    private readonly consult: SubjectDirectory | null,
    private readonly deal: SubjectDirectory | null,
  ) {}

  async resolve(subject: Subject, claims?: LinkClaims): Promise<PrefillResult | null> {
    if (subject.kind === "consult") {
      // Consultation hand-off is off by default (O1): there is no resolver, the link type is refused.
      if (!this.consult) throw new StoreError("REJECTED", "link type is not accepted", "SUBJECT_NOT_ELIGIBLE");
      return this.consult.resolve(subject, claims);
    }
    // No Deal resolver configured: the consultation resolver fails closed for deal subjects (IDENTITY_UNAVAILABLE).
    if (!this.deal) throw new StoreError("NOT_CONFIGURED", "no resolver for this link type", "IDENTITY_UNAVAILABLE");
    return this.deal.resolve(subject, claims);
  }

  consultationPrefill(subject: Subject, claims?: LinkClaims): Promise<PrefillResult | null> {
    if (subject.kind !== "deal" || !this.deal?.consultationPrefill) return Promise.resolve({ prefill: {} });
    return this.deal.consultationPrefill(subject, claims);
  }

  verificationGroupsFor(subject: Subject): ReadonlySet<string> | undefined {
    return subject.kind === "deal" ? this.deal?.verificationGroupsFor?.(subject) : undefined;
  }
}
