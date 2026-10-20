// @vitest-environment node
// T14 / ONB-PAY-01: verified-payment-driven FIRST invitation. MOCKS ONLY: no WooCommerce, no CRM, nothing is sent.
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEAL_ID, NOW_MS, SECRET } from "../fixtures";
import { createLinkIssuer } from "../links/issuer";
import { ExplicitProductMap } from "../links/product-map";
import { FileIssuedLinkStore } from "../links/registry";
import type { ContactView, DealView } from "../links/types";
import { CrmDealResolver, type DealOrderLookup } from "./deal-resolver";
import { FactStore, orderKey } from "./facts";
import { handlePaymentWebhook } from "./http";
import { createPaymentOnboarding, linkIdForOrder } from "./orchestrator";
import { handlePaymentWebhookFromEnv } from "./runtime";
import { DeliveryError, PaymentError, type DealResolver, type LinkDelivery, type OrderVerifier, type ResolvedDeal, type VerifiedOrder } from "./types";
import { WooCommerceOrderVerifier } from "./verifier";

let dir: string;
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "s2f-onbpay-"))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

const WH_SECRET = "woo-webhook-secret-0123456789";
const BASE = new URL("https://onboarding-staging.6tofit.com/");
const PRODUCT = "6223361000999000001";
const order = (over: Partial<VerifiedOrder> = {}): VerifiedOrder => ({ orderId: "17563", status: "processing", paid: true, refunded: false, partialRefund: false, total: "49.00", currency: "CAD", datePaid: "2026-10-14T09:00:00", gateway: "stripe", transactionId: "txn_synthetic", productSkus: [], ...over });
const deal = (over: Partial<ResolvedDeal> = {}): ResolvedDeal => ({ dealId: DEAL_ID, contactId: "6067417000999999001", scope: "Combo", entitlements: [], isFirstRequest: true, productRelatedTo: "VIP Fitness", productId: PRODUCT, ...over });

function make(o: { order?: VerifiedOrder; deal?: ResolvedDeal | "ambiguous" | null; down?: boolean } = {}) {
  const sent: Array<{ link: string; orderId: string }> = [];
  const verifier: OrderVerifier = { verify: async () => { if (o.down) throw new PaymentError("UNAVAILABLE"); return o.order ?? order(); } };
  const deals: DealResolver = { findByOrder: async () => (o.deal === undefined ? deal() : o.deal) };
  const delivery: LinkDelivery = { send: async (i) => { sent.push({ link: i.link, orderId: i.orderId }); } };
  const facts = new FactStore(join(dir, "payments"));
  const registry = new FileIssuedLinkStore(join(dir, "issued-links"));
  const orchestrator = createPaymentOnboarding({ facts, verifier, deals, delivery, registry, linkSecret: SECRET, onboardingBaseUrl: BASE, now: () => NOW_MS });
  return { orchestrator, facts, registry, sent };
}

describe("ONB-PAY-01 verification", () => {
  const wc = (over: Record<string, unknown> = {}) => ({ id: 17563, status: "processing", total: "49.00", currency: "CAD", date_paid: "2026-10-14T09:00:00", payment_method: "stripe", transaction_id: "txn_1", refunds: [], line_items: [], ...over });
  const v = (body: unknown, allowedGateways?: string[]) => new WooCommerceOrderVerifier({ baseUrl: "https://six2fit.example", consumerKey: "ck", consumerSecret: "cs", ...(allowedGateways ? { allowedGateways } : {}), fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });

  it("'processing' alone is not payment: a paid date, a positive total AND a gateway transaction reference are required", async () => {
    expect((await v(wc()).verify("17563")).paid).toBe(true);
    expect((await v(wc({ transaction_id: "" })).verify("17563")).paid).toBe(false);
    expect((await v(wc({ transaction_id: undefined })).verify("17563")).paid).toBe(false);
    expect((await v(wc({ date_paid: null })).verify("17563")).paid).toBe(false);
    expect((await v(wc({ total: "0" })).verify("17563")).paid).toBe(false);
    expect((await v(wc({ status: "on-hold" })).verify("17563")).paid).toBe(false);
  });

  it("an allowed-gateway list, when configured, rejects any other gateway", async () => {
    expect((await v(wc({ payment_method: "WC_ZPal" }), ["WC_ZPal", "stripe"]).verify("17563")).paid).toBe(true);
    expect((await v(wc({ payment_method: "bacs" }), ["WC_ZPal", "stripe"]).verify("17563")).paid).toBe(false);
    expect((await v(wc({ payment_method: "bacs" })).verify("17563")).paid).toBe(true); // unrestricted when not configured
  });
});

describe("ONB-PAY-01 orchestration", () => {
  it("keeps an auditable payment reference (order, gateway, gateway transaction, paid date, amount) and no customer data", async () => {
    const w = make();
    expect((await w.orchestrator.process("17563")).state).toBe("delivered");
    const paid = await w.facts.get(orderKey("17563"), "paid");
    expect(paid).toMatchObject({ order_id: "17563", gateway: "stripe", transaction_id: "txn_synthetic", date_paid: "2026-10-14T09:00:00", total: "49.00" });
    expect(JSON.stringify(paid)).not.toMatch(/@|\+98/);
  });

  it("only the FIRST period is invited automatically; a later period or an unproven one is not (manual initiation)", async () => {
    for (const first of [false, undefined]) {
      const w = make({ deal: deal({ isFirstRequest: first as boolean | undefined }) });
      expect(await w.orchestrator.process("17563")).toEqual({ state: "not_first_period" });
      expect(w.sent).toHaveLength(0);
      expect(await w.facts.names(orderKey("17563"))).toContain("skipped-not_first_period");
    }
  });

  it("failed, pending, unknown or unreadable payment sends nothing; an ambiguous Deal goes to review", async () => {
    for (const o of [order({ paid: false, status: "pending", datePaid: null }), order({ paid: false, status: "unknown" }), order({ status: "failed", paid: false })]) {
      const w = make({ order: o });
      expect((await w.orchestrator.process("17563")).state).toBe("not_paid");
      expect(w.sent).toHaveLength(0);
    }
    const down = make({ down: true });
    await expect(down.orchestrator.process("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(down.sent).toHaveLength(0);
    const amb = make({ deal: "ambiguous" });
    expect(await amb.orchestrator.process("17563")).toEqual({ state: "needs_review", reason: "deal_ambiguous" });
    expect(amb.sent).toHaveLength(0);
  });

  it("the invitation is registered so the manual issuer REUSES the very same link (no second onboarding for the period)", async () => {
    const w = make();
    await w.orchestrator.process("17563");
    await w.orchestrator.process("17563"); // replay: still one delivery
    expect(w.sent).toHaveLength(1);
    const latest = await w.registry.latestFor(DEAL_ID);
    expect(latest?.jti).toBe(linkIdForOrder("17563"));
    const crm = {
      getDeal: async (): Promise<DealView> => ({ id: DEAL_ID, orgId: "850673613", contactId: "6067417000999999001", productId: PRODUCT, productName: "P", productRelatedTo: "VIP Fitness" }),
      getContact: async (): Promise<ContactView> => ({ id: "6067417000999999001", email: "a@example.invalid", phone: null, mobile: null }),
      hasPriorRequests: async () => false,
    };
    const issuer = createLinkIssuer({ crm, products: new ExplicitProductMap({ [PRODUCT]: { scope: "Combo", entitlements: [] } }), links: w.registry, submissions: { statusFor: async () => "none" }, isRevoked: async () => false, secret: SECRET, baseUrl: BASE.origin, expectedOrgId: "850673613", ttlSeconds: 25 * 24 * 3600, now: () => NOW_MS });
    const reused = await issuer.issue(DEAL_ID);
    expect(reused).toMatchObject({ ok: true, status: "reused", jti: linkIdForOrder("17563") });
    if (reused.ok) expect(reused.urls.fa.split("session=")[1]).toBe(new URL(w.sent[0]!.link).searchParams.get("session"));
  });

  it("a different link already issued for the Deal stops the automatic invitation (review), nothing is sent", async () => {
    const w = make();
    await w.registry.tryRecord({ deal_id: DEAL_ID, jti: "manual-link-0000000001", scope: "Combo", entitlements: [], iat: 1, exp: 9_999_999_999, product_id: PRODUCT, is_first_request: true }, null);
    expect(await w.orchestrator.process("17563")).toEqual({ state: "needs_review", reason: "link_conflict" });
    expect(w.sent).toHaveLength(0);
  });
});

describe("ONB-PAY-01 webhook endpoint", () => {
  const body = '{"id":17563}';
  const sig = (b: string, secret = WH_SECRET) => createHmac("sha256", secret).update(b).digest("base64");
  const req = (b: string, headers: Record<string, string> = {}, path = "/api/payments/woocommerce") => new Request(`https://onboarding-staging.6tofit.com${path}`, { method: "POST", body: b, headers: { "x-wc-webhook-signature": sig(b), ...headers } });

  it("rejects an invalid signature, accepts the signed ping, handles a signed delivery once and short-circuits a replay", async () => {
    const w = make();
    const deps = { orchestrator: w.orchestrator, facts: w.facts, webhookSecret: WH_SECRET };
    expect((await handlePaymentWebhook(req(body, { "x-wc-webhook-signature": sig(body, "other-secret-0123456789") }), deps)).status).toBe(401);
    expect((await handlePaymentWebhook(new Request("https://x.invalid/api/payments/woocommerce", { method: "POST", body }), deps)).status).toBe(401);
    expect(await (await handlePaymentWebhook(req("webhook_id=5"), deps)).json()).toMatchObject({ ping: true });
    expect((await handlePaymentWebhook(req("{}"), deps)).status).toBe(400);
    const first = await handlePaymentWebhook(req(body, { "x-wc-webhook-delivery-id": "d-1" }), deps);
    expect(await first.json()).toEqual({ status: "ok", state: "delivered" });
    const replay = await handlePaymentWebhook(req(body, { "x-wc-webhook-delivery-id": "d-1" }), deps);
    expect(await replay.json()).toMatchObject({ duplicate_delivery: true });
    const another = await handlePaymentWebhook(req(body, { "x-wc-webhook-delivery-id": "d-2" }), deps);
    expect(await another.json()).toEqual({ status: "ok", state: "delivered" });
    expect(w.sent).toHaveLength(1); // one invitation however often the shop calls
  });

  it("answers 503 (the shop retries) when the order cannot be read, and never reveals order content", async () => {
    const w = make({ down: true });
    const res = await handlePaymentWebhook(req(body), { orchestrator: w.orchestrator, facts: w.facts, webhookSecret: WH_SECRET });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/txn_|49\.00/);
  });

  it("the environment entry point fails closed without a delivery channel, secret or resolver; it sends nothing by default", async () => {
    const env = { SIX2FIT_STAGING_STORAGE_DIR: dir, SIX2FIT_WOO_WEBHOOK_SECRET: WH_SECRET };
    expect((await handlePaymentWebhookFromEnv(req(body), {}, env)).status).toBe(503);
    expect(await (await handlePaymentWebhookFromEnv(req(body), {}, env)).json()).toMatchObject({ error_code: "PAYMENT_DELIVERY_NOT_CONFIGURED" });
    const noSecret = await handlePaymentWebhookFromEnv(req(body), { delivery: { send: async () => undefined } }, { SIX2FIT_STAGING_STORAGE_DIR: dir });
    expect(await noSecret.json()).toMatchObject({ error_code: "PAYMENT_NOT_CONFIGURED" });
    const noResolver = await handlePaymentWebhookFromEnv(req(body), { delivery: { send: async () => undefined }, verifier: { verify: async () => order() } }, env);
    expect(await noResolver.json()).toMatchObject({ error_code: "PAYMENT_DEAL_RESOLVER_NOT_CONFIGURED" });
  });

  it("an ambiguous or definite delivery refusal is retried or reviewed by the orchestrator, never double-sent", async () => {
    const sent: string[] = [];
    let mode: "refuse" | "ok" = "refuse";
    const facts = new FactStore(join(dir, "payments"));
    const orch = createPaymentOnboarding({ facts, verifier: { verify: async () => order() }, deals: { findByOrder: async () => deal() }, delivery: { send: async (i) => { if (mode === "refuse") throw new DeliveryError("definite", "REFUSED"); sent.push(i.link); } }, linkSecret: SECRET, onboardingBaseUrl: BASE, retryBackoffMs: 0 });
    expect((await orch.process("17563")).state).toBe("delivery_retry_later");
    mode = "ok";
    expect((await orch.process("17563")).state).toBe("delivered");
    expect((await orch.process("17563")).state).toBe("delivered");
    expect(sent).toHaveLength(1);
  });
});

describe("CrmDealResolver", () => {
  const crmWith = (ids: string[], org = "850673613"): DealOrderLookup => ({
    findDealIdsByOrder: async () => ids,
    getDeal: async (): Promise<DealView> => ({ id: ids[0] ?? "x", orgId: org, contactId: "6223361000127220001", productId: PRODUCT, productName: "P", productRelatedTo: "F" }),
    getContact: async (): Promise<ContactView> => ({ id: "6223361000127220001", email: null, phone: null, mobile: "+989121234567" }),
    hasPriorRequests: async () => false,
  });
  const resolver = (crm: DealOrderLookup, products = new ExplicitProductMap({ [PRODUCT]: { scope: "Combo", entitlements: ["cellulite"] } })) => new CrmDealResolver({ crm, products, expectedOrgId: "850673613" });

  it("zero Deals = not yet there; several = ambiguous; one = resolved with scope, first-period flag and product id", async () => {
    expect(await resolver(crmWith([])).findByOrder(order())).toBeNull();
    expect(await resolver(crmWith(["6223361000127220003", "6223361000127220004"])).findByOrder(order())).toBe("ambiguous");
    expect(await resolver(crmWith(["6223361000127220003"])).findByOrder(order())).toEqual({ dealId: "6223361000127220003", contactId: "6223361000127220001", scope: "Combo", entitlements: ["cellulite"], isFirstRequest: true, productRelatedTo: "F", productId: PRODUCT });
  });

  it("an unmapped product has no scope (review), another organisation is refused, CRM failures are retryable", async () => {
    expect((await resolver(crmWith(["6223361000127220003"]), new ExplicitProductMap()).findByOrder(order())) as ResolvedDeal).toMatchObject({ scope: null });
    await expect(resolver(crmWith(["6223361000127220003"], "111")).findByOrder(order())).rejects.toMatchObject({ code: "CORRUPT" });
    const broken: DealOrderLookup = { ...crmWith(["6223361000127220003"]), findDealIdsByOrder: async () => { throw new Error("down"); } };
    await expect(resolver(broken).findByOrder(order())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
