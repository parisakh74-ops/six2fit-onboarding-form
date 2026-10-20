import { sha256Hex } from "../canonical";
import { signLinkToken } from "../tokens";
import { FactStore, orderKey, revocationKey } from "./facts";
import type { IssuedLinkRecord, IssuedLinkStore } from "../links/types";
import { DeliveryError, PaymentError, type DealResolver, type LinkDelivery, type OrderVerifier, type ResolvedDeal, type VerifiedOrder } from "./types";

/**
 * Post-payment initiation of Onboarding. One verified payment -> at most one Onboarding link -> at most one delivery
 * (with an explicit unknown state, never a blind resend) -> at most one Request (the link id is derived from the order).
 *
 * Facts per order (append-only, see FactStore): `paid`, `deal`, `issued`, `delivery-<n>-sending`, `delivery-<n>-result`,
 * `revoked`, `review-<reason>`. Everything is idempotent and safe under concurrent or repeated events.
 */
export type Outcome =
  | { state: "not_paid"; status: string }
  | { state: "awaiting_deal" }
  | { state: "needs_review"; reason: "partial_refund" | "scope_unknown" | "delivery_unknown" | "delivery_exhausted" | "deal_ambiguous" | "link_conflict" | "delivery_rejected" | "link_expired" }
  /** ONB-PAY-01: only the FIRST period is invited automatically; later periods are started manually by staff. */
  | { state: "not_first_period" }
  | { state: "delivery_in_progress" }
  | { state: "delivery_retry_later" }
  | { state: "delivered"; jtiHint: string }
  | { state: "revoked"; reason: string };

export type OrchestratorDeps = {
  facts: FactStore;
  verifier: OrderVerifier;
  deals: DealResolver;
  delivery: LinkDelivery;
  /**
   * The durable registry of issued links (the same one the manual issuer uses). When present, the payment-driven link is
   * recorded there before delivery, so a later manual "Create Form" REUSES it, and an already existing different link of the
   * Deal stops the automatic invitation (`link_conflict`) instead of producing a second onboarding for the same period.
   */
  registry?: IssuedLinkStore;
  /** HMAC secret of the onboarding links (same secret the Onboarding API verifies with). */
  linkSecret: string;
  /** Public base URL of the Onboarding form (`https://onboarding-staging.6tofit.com/`). */
  onboardingBaseUrl: URL;
  now?: () => number;
  /** Counters and codes only: never names, e-mail, phone, tokens or order contents. */
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
  /** Link lifetime (a product decision; the Onboarding API enforces a 90-day maximum). Default 30 days. */
  linkTtlSeconds?: number;
  maxDeliveryAttempts?: number;
  /** Wait after a refused delivery before the next attempt. */
  retryBackoffMs?: number;
};

/** The link id is a pure function of the order: the same payment can only ever produce the same link id. */
export const linkIdForOrder = (orderId: string): string => `o${sha256Hex(`link:${orderId}`).slice(0, 40)}`;

export function createPaymentOnboarding(deps: OrchestratorDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const ttl = deps.linkTtlSeconds ?? 30 * 24 * 3600;
  const maxAttempts = deps.maxDeliveryAttempts ?? 3;
  const backoff = deps.retryBackoffMs ?? 15 * 60 * 1000;

  const mintLink = (orderId: string, deal: ResolvedDeal & { scope: NonNullable<ResolvedDeal["scope"]> }, exp: number): string => {
    const token = signLinkToken(
      {
        v: 2,
        deal_id: deal.dealId,
        jti: linkIdForOrder(orderId),
        scope: deal.scope,
        entitlements: [...new Set(deal.entitlements)].sort(),
        exp,
        ...(deal.isFirstRequest !== undefined ? { is_first_request: deal.isFirstRequest } : {}),
        ...(deal.productRelatedTo ? { product_related_to: deal.productRelatedTo } : {}),
      },
      deps.linkSecret,
    );
    const url = new URL(deps.onboardingBaseUrl);
    url.searchParams.set("session", token);
    return url.toString();
  };

  async function revoke(orderId: string, key: string, reason: string): Promise<Outcome> {
    const created = await deps.facts.put(key, "revoked", { reason, at: now() });
    await deps.facts.put(revocationKey(linkIdForOrder(orderId)), "revoked", { reason, at: now() });
    if (created) log("payment.link_revoked", { reason });
    return { state: "revoked", reason };
  }

  async function deliver(orderId: string, key: string, deal: ResolvedDeal & { scope: NonNullable<ResolvedDeal["scope"]> }, exp: number): Promise<Outcome> {
    const names = await deps.facts.names(key);
    // A permanent refusal (no/invalid/opted-out recipient, sender not allowed) waits for a human: never retried by a later event.
    if (names.includes("review-delivery_rejected")) return { state: "needs_review", reason: "delivery_rejected" };
    const attempts = names.filter((n) => /^delivery-\d+-sending$/.test(n)).map((n) => Number(/^delivery-(\d+)-/.exec(n)?.[1])).sort((a, b) => a - b);
    const last = attempts.at(-1) ?? 0;
    if (last > 0) {
      const result = await deps.facts.get<{ status: "sent" | "refused" | "unknown"; at: number }>(key, `delivery-${last}-result`);
      if (result?.status === "sent") return { state: "delivered", jtiHint: linkIdForOrder(orderId).slice(0, 6) };
      // No result (the sender died after the marker) or an ambiguous result: the link MAY have been sent. Never resend automatically.
      if (!result || result.status === "unknown") {
        await deps.facts.put(key, "review-delivery_unknown", { at: now() });
        return { state: "needs_review", reason: "delivery_unknown" };
      }
      if (last >= maxAttempts) {
        await deps.facts.put(key, "review-delivery_exhausted", { at: now() });
        return { state: "needs_review", reason: "delivery_exhausted" };
      }
      if (now() - result.at < backoff) return { state: "delivery_retry_later" };
    }
    // Never send a link that is expired (or about to be) or that was revoked meanwhile (a retry can come days later).
    if (exp - Math.floor(now() / 1000) < 60) {
      await deps.facts.put(key, "review-link_expired", { at: now() });
      return { state: "needs_review", reason: "link_expired" };
    }
    if (await deps.facts.get(key, "revoked")) return { state: "revoked", reason: "revoked" };
    const attempt = last + 1;
    // Durable marker BEFORE the send: from here on an outcome we did not record is "unknown", not "not sent".
    if (!(await deps.facts.put(key, `delivery-${attempt}-sending`, { at: now() }))) return { state: "delivery_in_progress" };
    let reference: string | undefined;
    try {
      const sent = await deps.delivery.send({ dealId: deal.dealId, contactId: deal.contactId, orderId, link: mintLink(orderId, deal, exp), attempt });
      reference = sent && typeof sent === "object" && typeof sent.reference === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(sent.reference) ? sent.reference : undefined;
    } catch (e) {
      if (e instanceof DeliveryError && e.kind === "permanent") {
        await deps.facts.put(key, `delivery-${attempt}-result`, { status: "refused", permanent: true, code: e.code, at: now() });
        await deps.facts.put(key, "review-delivery_rejected", { code: e.code, at: now() });
        log("payment.delivery_rejected", { attempt });
        return { state: "needs_review", reason: "delivery_rejected" };
      }
      const ambiguous = !(e instanceof DeliveryError) || e.kind === "ambiguous";
      await deps.facts.put(key, `delivery-${attempt}-result`, { status: ambiguous ? "unknown" : "refused", code: e instanceof DeliveryError ? e.code : "UNEXPECTED", at: now() });
      log("payment.delivery_failed", { attempt, ambiguous });
      if (ambiguous) {
        await deps.facts.put(key, "review-delivery_unknown", { at: now() });
        return { state: "needs_review", reason: "delivery_unknown" };
      }
      return { state: "delivery_retry_later" };
    }
    // "sent" = the provider ACCEPTED the message; it is not proof that it reached an inbox.
    await deps.facts.put(key, `delivery-${attempt}-result`, { status: "sent", proof: "provider_accepted", ...(reference ? { reference } : {}), at: now() });
    log("payment.link_delivered", { attempt });
    return { state: "delivered", jtiHint: linkIdForOrder(orderId).slice(0, 6) };
  }

  /**
   * Handles a payment event for an order (a webhook delivery, a retry, a reconciliation sweep: all the same). The order is
   * always re-read from the payment platform. Throws `PaymentError(UNAVAILABLE)` when it cannot be read or the fact store
   * is unavailable: the caller answers 5xx so the platform retries; nothing is lost and nothing is duplicated.
   */
  async function process(orderId: string): Promise<Outcome> {
    const key = orderKey(orderId);
    const revoked = await deps.facts.get(key, "revoked");
    if (revoked) return { state: "revoked", reason: String(revoked["reason"] ?? "revoked") };

    const order: VerifiedOrder = await deps.verifier.verify(orderId);
    if (order.orderId !== orderId) throw new PaymentError("CORRUPT", "verifier answered for another order");

    const issuedBefore = await deps.facts.get(key, "issued");
    if (order.refunded || order.status === "refunded" || order.status === "cancelled" || order.status === "failed" || order.status === "trash") {
      if (issuedBefore || (await deps.facts.get(key, "paid"))) return revoke(orderId, key, order.refunded ? "refunded" : order.status);
      return { state: "not_paid", status: order.status };
    }
    if (!order.paid) return { state: "not_paid", status: order.status }; // pending / on-hold: a later event may complete it

    // Auditable payment reference: order id, gateway, gateway transaction reference, paid date, amount. No customer data.
    await deps.facts.put(key, "paid", { order_id: orderId, status: order.status, total: order.total, currency: order.currency, date_paid: order.datePaid, gateway: order.gateway, transaction_id: order.transactionId, at: now() });

    if (order.partialRefund && !issuedBefore) {
      await deps.facts.put(key, "review-partial_refund", { at: now() });
      return { state: "needs_review", reason: "partial_refund" };
    }

    let deal = await deps.facts.get<ResolvedDeal>(key, "deal");
    if (!deal) {
      const found = await deps.deals.findByOrder(order); // may throw UNAVAILABLE: caller retries
      if (found === "ambiguous") {
        await deps.facts.put(key, "review-deal_ambiguous", { at: now() });
        return { state: "needs_review", reason: "deal_ambiguous" };
      }
      if (!found) {
        log("payment.awaiting_deal", {});
        return { state: "awaiting_deal" }; // CRM synchronisation can lag: the reconciliation sweep or the next event continues
      }
      await deps.facts.put(key, "deal", found);
      deal = (await deps.facts.get<ResolvedDeal>(key, "deal")) as ResolvedDeal;
    }
    if (!deal.scope) {
      await deps.facts.put(key, "review-scope_unknown", { at: now() });
      return { state: "needs_review", reason: "scope_unknown" };
    }
    const dealOk = deal as ResolvedDeal & { scope: NonNullable<ResolvedDeal["scope"]> };
    // First period only (unknown = not proven first = no automatic invitation).
    if (dealOk.isFirstRequest !== true) {
      await deps.facts.put(key, "skipped-not_first_period", { at: now() });
      log("payment.not_first_period", {});
      return { state: "not_first_period" };
    }

    // Exactly one issuance per order: the first writer decides the expiry; everyone else reuses it.
    await deps.facts.put(key, "issued", { jti: linkIdForOrder(orderId), deal_id: dealOk.dealId, at: now(), exp: Math.floor(now() / 1000) + ttl });
    const issued = (await deps.facts.get<{ exp: number }>(key, "issued")) as { exp: number };
    if (deps.registry) {
      const jti = linkIdForOrder(orderId);
      const latest = await deps.registry.latestFor(dealOk.dealId);
      let conflict = latest !== null && latest.jti !== jti;
      if (!latest && !conflict) {
        const record: IssuedLinkRecord | null = dealOk.productId
          ? { deal_id: dealOk.dealId, jti, scope: dealOk.scope, entitlements: [...new Set(dealOk.entitlements)].sort(), iat: Math.floor(now() / 1000), exp: issued.exp, product_id: dealOk.productId, is_first_request: true, ...(dealOk.productRelatedTo && dealOk.productRelatedTo.length <= 255 ? { product_related_to: dealOk.productRelatedTo } : {}) }
          : null;
        conflict = record === null || !(await deps.registry.tryRecord(record, null));
      }
      if (conflict) {
        await deps.facts.put(key, "review-link_conflict", { at: now() });
        log("payment.link_conflict", {});
        return { state: "needs_review", reason: "link_conflict" };
      }
    }
    return deliver(orderId, key, dealOk, issued.exp);
  }

  /** Re-runs every order that has progressed but not finished (awaiting a Deal, retrying a delivery). */
  async function reconcile(): Promise<Array<{ orderId: string; outcome: Outcome | { state: "error"; code: string } }>> {
    const out: Array<{ orderId: string; outcome: Outcome | { state: "error"; code: string } }> = [];
    for (const key of await deps.facts.orders()) {
      const paid = await deps.facts.get<{ order_id: string }>(key, "paid");
      if (!paid || (await deps.facts.get(key, "revoked"))) continue;
      const names = await deps.facts.names(key);
      if (names.some((n) => n.startsWith("review-"))) continue; // waits for a human
      try {
        const outcome = await process(paid.order_id);
        if (outcome.state !== "delivered") out.push({ orderId: paid.order_id, outcome });
      } catch (e) {
        out.push({ orderId: paid.order_id, outcome: { state: "error", code: e instanceof PaymentError ? e.code : "UNEXPECTED" } });
      }
    }
    return out;
  }

  return { process, reconcile, revokeOrder: async (orderId: string, reason: string) => revoke(orderId, orderKey(orderId), reason) };
}

export type PaymentOnboarding = ReturnType<typeof createPaymentOnboarding>;
