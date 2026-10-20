import type { IdempotencyLedger } from "../ledger";
import { subjectKey } from "../tokens";
import { linkClaimsOf } from "./issuer";
import type { IssuedLinkRecord, IssuedLinkStore, LinkSubmissionStatus, SubmissionStatusReader } from "./types";

/**
 * Submission state of a link, read from the onboarding idempotency ledger (the same entry the submit path uses).
 *   no entry / released            -> "none"       (nothing was settled for this link)
 *   created                        -> "submitted"
 *   in_progress / unknown / needs_review / integrity -> "unresolved" (a write may have happened: stop, never re-issue silently)
 * Read-only; never writes the ledger.
 */
export class LedgerSubmissionStatusReader implements SubmissionStatusReader {
  constructor(private readonly ledger: IdempotencyLedger) {}

  async statusFor(link: IssuedLinkRecord): Promise<LinkSubmissionStatus> {
    const entry = await this.ledger.current(subjectKey(linkClaimsOf(link)));
    if (!entry || entry.state === "released") return "none";
    return entry.state === "created" ? "submitted" : "unresolved";
  }
}

/**
 * NON-PERSISTENT registry with the compare-and-set semantics the issuer needs. For tests and local use only: it is
 * lost on restart, which would re-issue a new link on the next click. A durable store is a pending decision.
 */
export class InMemoryIssuedLinkStore implements IssuedLinkStore {
  private readonly byDeal = new Map<string, IssuedLinkRecord[]>();

  async latestFor(dealId: string): Promise<IssuedLinkRecord | null> {
    const list = this.byDeal.get(dealId);
    return list && list.length > 0 ? { ...(list[list.length - 1] as IssuedLinkRecord) } : null;
  }

  async tryRecord(record: IssuedLinkRecord, expectedLatestJti: string | null): Promise<boolean> {
    const list = this.byDeal.get(record.deal_id) ?? [];
    const current = list.length > 0 ? (list[list.length - 1] as IssuedLinkRecord).jti : null;
    if (current !== expectedLatestJti) return false;
    this.byDeal.set(record.deal_id, [...list, { ...record }]);
    return true;
  }

  count(dealId: string): number {
    return this.byDeal.get(dealId)?.length ?? 0;
  }
}
