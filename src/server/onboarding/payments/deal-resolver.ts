import { CrmReadError, type CrmDealReader, type ProductScopeMap } from "../links/types";
import { PaymentError, type DealResolver, type ResolvedDeal, type VerifiedOrder } from "./types";

export interface DealOrderLookup extends CrmDealReader {
  findDealIdsByOrder(orderId: string): Promise<string[]>;
}

/**
 * Finds the CRM Deal created for a verified order, READ-ONLY. Zero Deals = not (yet) there (CRM synchronisation lags, the
 * caller retries); several Deals = "ambiguous" (never guessed, goes to review); exactly one Deal must belong to the expected
 * organisation, have a Contact and a mapped Product. First period = the Contact has no earlier Request (the legacy rule).
 * An unmapped product yields `scope: null` (manual review in the orchestrator). Nothing is ever written.
 */
export class CrmDealResolver implements DealResolver {
  constructor(private readonly deps: { crm: DealOrderLookup; products: ProductScopeMap; expectedOrgId: string }) {}

  async findByOrder(order: VerifiedOrder): Promise<ResolvedDeal | "ambiguous" | null> {
    const { crm, products, expectedOrgId } = this.deps;
    try {
      const ids = await crm.findDealIdsByOrder(order.orderId);
      if (ids.length === 0) return null;
      if (ids.length > 1) return "ambiguous";
      const deal = await crm.getDeal(ids[0] as string);
      if (!deal) return null;
      if (deal.orgId !== expectedOrgId) throw new PaymentError("CORRUPT", "deal belongs to another environment");
      if (!deal.contactId) return null;
      const contact = await crm.getContact(deal.contactId);
      if (!contact || contact.id !== deal.contactId) return null;
      const mapping = deal.productId ? products.map({ id: deal.productId, name: deal.productName, productRelatedTo: deal.productRelatedTo }) : null;
      const prior = await crm.hasPriorRequests(contact.id);
      return {
        dealId: deal.id,
        contactId: contact.id,
        scope: mapping?.scope ?? null,
        entitlements: mapping ? [...new Set(mapping.entitlements)].sort() : [],
        isFirstRequest: !prior,
        ...(deal.productRelatedTo ? { productRelatedTo: deal.productRelatedTo } : {}),
        ...(deal.productId ? { productId: deal.productId } : {}),
      };
    } catch (e) {
      if (e instanceof PaymentError) throw e;
      throw new PaymentError("UNAVAILABLE", e instanceof CrmReadError ? `crm ${e.code}` : "crm unreadable");
    }
  }
}
