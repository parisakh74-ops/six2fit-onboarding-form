import { join } from "node:path";
import { defaultIssuerExtras } from "../links/runtime";
import { FileIssuedLinkStore } from "../links/registry";
import { productMapFromEnv } from "../links/product-map";
import { CrmDealResolver, type DealOrderLookup } from "./deal-resolver";
import { FactStore } from "./facts";
import { handlePaymentWebhook } from "./http";
import { createPaymentOnboarding } from "./orchestrator";
import type { DealResolver, LinkDelivery, OrderVerifier } from "./types";
import { WooCommerceOrderVerifier } from "./verifier";

export type PaymentRuntimeExtras = { delivery?: LinkDelivery; verifier?: OrderVerifier; deals?: DealResolver; now?: () => number; fetch?: ConstructorParameters<typeof WooCommerceOrderVerifier>[0]["fetch"] };

const unavailable = (code: string): Response => Response.json({ error_code: code, message: code }, { status: 503, headers: { "Cache-Control": "no-store" } });

/**
 * Entry point of the payment webhook. FAILS CLOSED (503) until every collaborator exists. In particular there is NO default
 * delivery channel: how the first invitation reaches the customer (e-mail / WhatsApp provider) is an open product decision
 * (D-PAY-7), so this route cannot send anything until a `LinkDelivery` is supplied. Nothing is sent by default.
 *
 *   SIX2FIT_WOO_WEBHOOK_SECRET (>= 16 chars), SIX2FIT_WOO_BASE_URL (https shop, the Production order source is six2fit.com),
 *   SIX2FIT_WOO_CONSUMER_KEY / _CONSUMER_SECRET (READ-ONLY key), SIX2FIT_PAYMENT_GATEWAYS (optional comma list of gateway ids),
 *   SIX2FIT_FORM_BASE_URL, SIX2FIT_LINK_TTL_SECONDS, SIX2FIT_ONBOARDING_TOKEN_SECRET, SIX2FIT_STAGING_STORAGE_DIR, SIX2FIT_EXPECTED_ORG_ID
 */
export async function handlePaymentWebhookFromEnv(request: Request, extras: PaymentRuntimeExtras = {}, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const get = (k: string) => (env[k] ?? "").trim();
  try {
    if (!extras.delivery) return unavailable("PAYMENT_DELIVERY_NOT_CONFIGURED");
    const webhookSecret = get("SIX2FIT_WOO_WEBHOOK_SECRET");
    if (webhookSecret.length < 16) return unavailable("PAYMENT_NOT_CONFIGURED");
    const storageDir = get("SIX2FIT_STAGING_STORAGE_DIR");
    if (!storageDir) return unavailable("PAYMENT_NOT_CONFIGURED");
    const gateways = get("SIX2FIT_PAYMENT_GATEWAYS").split(",").map((g) => g.trim()).filter(Boolean);
    const verifier =
      extras.verifier ??
      new WooCommerceOrderVerifier({ baseUrl: get("SIX2FIT_WOO_BASE_URL"), consumerKey: get("SIX2FIT_WOO_CONSUMER_KEY"), consumerSecret: get("SIX2FIT_WOO_CONSUMER_SECRET"), allowedGateways: gateways, ...(extras.fetch ? { fetch: extras.fetch } : {}) });
    let deals = extras.deals;
    if (!deals) {
      const crm = defaultIssuerExtras(env).crm as (DealOrderLookup | undefined);
      if (!crm || typeof crm.findDealIdsByOrder !== "function") return unavailable("PAYMENT_DEAL_RESOLVER_NOT_CONFIGURED");
      deals = new CrmDealResolver({ crm, products: productMapFromEnv(env["SIX2FIT_PRODUCT_SCOPE_MAP"]), expectedOrgId: get("SIX2FIT_EXPECTED_ORG_ID") });
    }
    const facts = new FactStore(join(storageDir, "payments"));
    const orchestrator = createPaymentOnboarding({
      facts,
      verifier,
      deals,
      delivery: extras.delivery,
      registry: new FileIssuedLinkStore(join(storageDir, "issued-links")),
      linkSecret: get("SIX2FIT_ONBOARDING_TOKEN_SECRET"),
      onboardingBaseUrl: new URL(get("SIX2FIT_FORM_BASE_URL")),
      linkTtlSeconds: Number(get("SIX2FIT_LINK_TTL_SECONDS")) || 25 * 24 * 3600,
      ...(extras.now ? { now: extras.now } : {}),
      log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
    });
    return await handlePaymentWebhook(request, { orchestrator, facts, webhookSecret });
  } catch {
    return unavailable("PAYMENT_NOT_CONFIGURED");
  }
}
