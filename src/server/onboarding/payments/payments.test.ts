// @vitest-environment node
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOnboardingStore, LocalFileSink, ConsultHandoffDirectory } from "../file-store";
import { DEAL_ID, NOW_MS, SECRET, validAnswers } from "../fixtures";
import { createOnboardingService } from "../service";
import { subjectKey, uniqueFormKey, verifyLinkToken } from "../tokens";
import { FactStore, orderKey, revocationKey } from "./facts";
import { createPaymentOnboarding, linkIdForOrder, type PaymentOnboarding } from "./orchestrator";
import { DeliveryError, PaymentError, type DealResolver, type LinkDelivery, type OrderVerifier, type ResolvedDeal, type VerifiedOrder } from "./types";
import { WooCommerceOrderVerifier, orderIdFromWebhook, verifyWooSignature } from "./verifier";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-pay-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = new URL("https://onboarding-staging.6tofit.com/");
const order = (over: Partial<VerifiedOrder> = {}): VerifiedOrder => ({ orderId: "17563", status: "processing", paid: true, refunded: false, partialRefund: false, total: "49.00", currency: "CAD", datePaid: "2026-10-14T09:00:00", gateway: "stripe", transactionId: "txn_synthetic", productSkus: ["PLAN-VIP-1M"], ...over });

class Verifier implements OrderVerifier {
  calls = 0;
  down = false;
  constructor(public orders: Record<string, VerifiedOrder> = { "17563": order() }) {}
  async verify(id: string) {
    this.calls += 1;
    if (this.down) throw new PaymentError("UNAVAILABLE");
    const o = this.orders[id];
    if (!o) throw new PaymentError("UNAVAILABLE");
    return o;
  }
}
class Deals implements DealResolver {
  calls = 0;
  down = false;
  constructor(public deals: Record<string, ResolvedDeal | null> = { "17563": { dealId: DEAL_ID, contactId: "6067417000999999001", scope: "Combo", entitlements: [], isFirstRequest: true, productRelatedTo: "VIP Fitness" } }) {}
  async findByOrder(o: VerifiedOrder) {
    this.calls += 1;
    if (this.down) throw new PaymentError("UNAVAILABLE");
    return this.deals[o.orderId] ?? null;
  }
}
class Delivery implements LinkDelivery {
  sent: Array<{ dealId: string; contactId: string; orderId: string; link: string; attempt: number }> = [];
  mode: "ok" | "refuse" | "timeout" = "ok";
  async send(input: { dealId: string; contactId: string; orderId: string; link: string; attempt: number }) {
    if (this.mode === "refuse") throw new DeliveryError("definite", "PROVIDER_REFUSED");
    if (this.mode === "timeout") {
      this.sent.push(input); // it may have gone out
      throw new DeliveryError("ambiguous", "TIMEOUT");
    }
    this.sent.push(input);
  }
}

function make(over: { verifier?: Verifier; deals?: Deals; delivery?: Delivery; clock?: { t: number }; logs?: Array<Record<string, unknown>> } = {}) {
  const verifier = over.verifier ?? new Verifier();
  const deals = over.deals ?? new Deals();
  const delivery = over.delivery ?? new Delivery();
  const clock = over.clock ?? { t: NOW_MS };
  const logs = over.logs ?? [];
  const facts = new FactStore(join(dir, "payments"));
  const orch: PaymentOnboarding = createPaymentOnboarding({ facts, verifier, deals, delivery, linkSecret: SECRET, onboardingBaseUrl: BASE, now: () => clock.t, log: (e, f) => logs.push({ event: e, ...f }) });
  return { orch, verifier, deals, delivery, clock, facts, logs };
}

describe("post-payment initiation", () => {
  it("a verified payment with a Deal issues one individual link, bound to that Deal and derived from the order, and delivers it once", async () => {
    const w = make();
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect(w.delivery.sent).toHaveLength(1);
    const sent = w.delivery.sent[0]!;
    expect(sent).toMatchObject({ dealId: DEAL_ID, contactId: "6067417000999999001", orderId: "17563", attempt: 1 });
    const token = new URL(sent.link).searchParams.get("session")!;
    expect(sent.link.startsWith(BASE.toString())).toBe(true);
    const claims = verifyLinkToken(token, SECRET, NOW_MS);
    expect(claims).toMatchObject({ v: 2, subject: { kind: "deal", dealId: DEAL_ID }, scope: "Combo", entitlements: [], isFirstRequest: true, productRelatedTo: "VIP Fitness", jti: linkIdForOrder("17563") });
    expect(claims.exp - Math.floor(NOW_MS / 1000)).toBe(30 * 24 * 3600);
    // the Request key that follows from this link is stable and unique per order
    expect(uniqueFormKey(claims)).toBe(`onb2_${DEAL_ID}_${linkIdForOrder("17563")}`);
  });

  it("duplicate payment events cannot send duplicate links: 12 concurrent + repeated deliveries -> one issuance, one delivery", async () => {
    const w = make();
    const rs = await Promise.all(Array.from({ length: 12 }, () => w.orch.process("17563")));
    expect(rs.some((r) => r.state === "delivered")).toBe(true);
    for (const r of await Promise.all([w.orch.process("17563"), w.orch.process("17563")])) expect(r.state).toBe("delivered");
    expect(w.delivery.sent).toHaveLength(1);
    expect(await readdir(join(dir, "payments", orderKey("17563")))).toEqual(expect.arrayContaining(["issued.json", "paid.json", "deal.json", "delivery-1-sending.json", "delivery-1-result.json"]));
  });

  it("status changes after payment (processing -> completed) and a restarted worker do not re-issue", async () => {
    const w = make();
    await w.orch.process("17563");
    w.verifier.orders["17563"] = order({ status: "completed" });
    await w.orch.process("17563");
    const again = make({ verifier: w.verifier, deals: w.deals, delivery: w.delivery }); // new objects, same storage
    expect((await again.orch.process("17563")).state).toBe("delivered");
    expect(w.delivery.sent).toHaveLength(1);
  });

  it("the link id is a pure function of the order: same order -> same id, different orders -> different ids", () => {
    expect(linkIdForOrder("17563")).toBe(linkIdForOrder("17563"));
    expect(linkIdForOrder("17563")).not.toBe(linkIdForOrder("17564"));
    expect(linkIdForOrder("17563")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(() => orderKey("../1")).toThrow(PaymentError);
  });
});

describe("payment states", () => {
  it.each(["pending", "on-hold", "failed", "cancelled", "trash", "unknown"] as const)("status %s never issues a link", async (status) => {
    const w = make({ verifier: new Verifier({ "17563": order({ status, paid: false, datePaid: null }) }) });
    expect((await w.orch.process("17563")).state).toBe("not_paid");
    expect(w.delivery.sent).toHaveLength(0);
    expect(w.deals.calls).toBe(0);
  });

  it("a payment that completes later issues the link then (pending -> processing)", async () => {
    const w = make({ verifier: new Verifier({ "17563": order({ status: "pending", paid: false, datePaid: null }) }) });
    expect((await w.orch.process("17563")).state).toBe("not_paid");
    w.verifier.orders["17563"] = order();
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect(w.delivery.sent).toHaveLength(1);
  });

  it("a processing order without a paid date is not money received", async () => {
    const w = make({ verifier: new Verifier({ "17563": order({ paid: false, datePaid: null }) }) });
    expect((await w.orch.process("17563")).state).toBe("not_paid");
  });

  it("a refund after the link was issued revokes it; the Onboarding API then refuses the link", async () => {
    const w = make();
    await w.orch.process("17563");
    const token = new URL(w.delivery.sent[0]!.link).searchParams.get("session")!;
    w.verifier.orders["17563"] = order({ status: "refunded", refunded: true });
    expect(await w.orch.process("17563")).toEqual({ state: "revoked", reason: "refunded" });
    expect(await w.orch.process("17563")).toMatchObject({ state: "revoked" }); // sticky, even if the status flips back
    w.verifier.orders["17563"] = order();
    expect((await w.orch.process("17563")).state).toBe("revoked");

    const store = new FileOnboardingStore(dir);
    const service = createOnboardingService({
      store,
      directory: { async resolve() { return { prefill: {} }; } },
      sink: new LocalFileSink(dir),
      secret: SECRET,
      now: () => NOW_MS,
      isRevoked: async (id) => (await w.facts.get(revocationKey(id), "revoked")) !== null,
    });
    expect((await service.bootstrap(token)).status).toBe(403);
    const r = await service.submit({ token, submissionId: "11111111-2222-4333-8444-555555555555", idempotencyKey: "11111111-2222-4333-8444-555555555555", answers: validAnswers("Combo"), verificationState: "{}", files: {} });
    expect(r.status).toBe(403);
    expect(r.body["error_code"]).toBe("LINK_REVOKED");
    expect(await readdir(dir)).not.toContain("onboarding-v2");
    void ConsultHandoffDirectory;
  });

  it("a refund or cancellation before any link was issued stays 'not paid' for onboarding; once paid facts exist it is revoked", async () => {
    const w = make({ verifier: new Verifier({ "17563": order({ status: "cancelled", paid: false, datePaid: null }) }) });
    expect((await w.orch.process("17563")).state).toBe("not_paid");
    const paidThenRefunded = make();
    paidThenRefunded.deals.deals["17563"] = null; // paid, Deal not there yet
    expect((await paidThenRefunded.orch.process("17563")).state).toBe("awaiting_deal");
    paidThenRefunded.verifier.orders["17563"] = order({ status: "refunded", refunded: true });
    expect((await paidThenRefunded.orch.process("17563")).state).toBe("revoked");
    paidThenRefunded.verifier.orders["17563"] = order();
    paidThenRefunded.deals.deals["17563"] = { dealId: DEAL_ID, contactId: "1", scope: "Combo", entitlements: [], isFirstRequest: true };
    expect((await paidThenRefunded.orch.process("17563")).state).toBe("revoked");
    expect(paidThenRefunded.delivery.sent).toHaveLength(0);
  });

  it("a partial refund holds the order for a human decision (no link)", async () => {
    const w = make({ verifier: new Verifier({ "17563": order({ partialRefund: true }) }) });
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "partial_refund" });
    expect(w.delivery.sent).toHaveLength(0);
  });
});

describe("delayed CRM synchronisation (a Deal is never assumed)", () => {
  it("no Deal yet -> awaiting_deal; the sweep delivers once the Deal appears, exactly once", async () => {
    const w = make({ deals: new Deals({ "17563": null }) });
    expect((await w.orch.process("17563")).state).toBe("awaiting_deal");
    expect((await w.orch.reconcile()).map((r) => r.outcome.state)).toEqual(["awaiting_deal"]);
    w.deals.deals["17563"] = { dealId: DEAL_ID, contactId: "6067417000999999001", scope: "Combo", entitlements: [], isFirstRequest: true };
    expect(await w.orch.reconcile()).toEqual([]); // delivered: nothing left to do
    expect(w.delivery.sent).toHaveLength(1);
    await w.orch.reconcile();
    expect(w.delivery.sent).toHaveLength(1);
  });

  it("CRM or payment platform unavailable: the event fails (the platform retries), nothing is issued, nothing is lost", async () => {
    const w = make();
    w.deals.down = true;
    await expect(w.orch.process("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    w.deals.down = false;
    w.verifier.down = true;
    await expect(w.orch.process("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    w.verifier.down = false;
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect(w.delivery.sent).toHaveLength(1);
  });

  it("an order whose product cannot be mapped to a form scope goes to manual review instead of being guessed", async () => {
    const w = make({ deals: new Deals({ "17563": { dealId: DEAL_ID, contactId: "1", scope: null, entitlements: [] } }) });
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "scope_unknown" });
    expect(w.delivery.sent).toHaveLength(0);
  });

  it("a payment platform that answers for another order is refused", async () => {
    const w = make({ verifier: new Verifier({ "17563": order({ orderId: "99999" }) }) });
    await expect(w.orch.process("17563")).rejects.toMatchObject({ code: "CORRUPT" });
  });
});

describe("delivery failures", () => {
  it("a refused delivery is retried after the back-off, up to three attempts, then goes to review", async () => {
    const w = make();
    w.delivery.mode = "refuse";
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later");
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later"); // still inside the back-off: no new attempt
    expect(w.delivery.sent).toHaveLength(0);
    w.clock.t += 16 * 60_000;
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later"); // attempt 2 refused
    w.clock.t += 16 * 60_000;
    w.delivery.mode = "ok";
    expect((await w.orch.process("17563")).state).toBe("delivered"); // attempt 3
    expect(w.delivery.sent).toHaveLength(1);
    expect(w.delivery.sent[0]!.attempt).toBe(3);

    const x = make({ verifier: new Verifier({ "17570": order({ orderId: "17570" }) }), deals: new Deals({ "17570": { dealId: DEAL_ID, contactId: "1", scope: "Combo", entitlements: [], isFirstRequest: true } }) });
    x.delivery.mode = "refuse";
    for (let i = 0; i < 3; i += 1) {
      await x.orch.process("17570");
      x.clock.t += 16 * 60_000;
    }
    expect(await x.orch.process("17570")).toEqual({ state: "needs_review", reason: "delivery_exhausted" });
  });

  it("an ambiguous delivery (timeout) is never resent automatically", async () => {
    const w = make();
    w.delivery.mode = "timeout";
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_unknown" });
    w.delivery.mode = "ok";
    w.clock.t += 7 * 24 * 3600_000;
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_unknown" });
    expect(await w.orch.reconcile()).toEqual([]);
    expect(w.delivery.sent).toHaveLength(1); // only the ambiguous one
  });

  it("a sender that died after its durable marker leaves the delivery unknown, not 'not sent'", async () => {
    const w = make();
    await w.facts.put(orderKey("17563"), "delivery-1-sending", { at: NOW_MS }); // crash between the marker and the result
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_unknown" });
    expect(w.delivery.sent).toHaveLength(0);
  });

  it("two workers racing for the same attempt: only one sends", async () => {
    const a = make();
    const b = make({ verifier: a.verifier, deals: a.deals, delivery: a.delivery });
    const rs = await Promise.all([a.orch.process("17563"), b.orch.process("17563"), a.orch.process("17563"), b.orch.process("17563")]);
    expect(a.delivery.sent).toHaveLength(1);
    expect(rs.some((r) => r.state === "delivered")).toBe(true);
  });
});

describe("privacy", () => {
  it("facts and logs hold ids and states only: no link, token, name, e-mail or phone", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const w = make({ logs });
    await w.orch.process("17563");
    const files = await readdir(join(dir, "payments", orderKey("17563")));
    const text = (await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => readFile(join(dir, "payments", orderKey("17563"), f), "utf8")))).join("");
    expect(text).not.toMatch(/session=|eyJ|@|\.example|synthetic-onboarding/); // no link/token, e-mail, secret (CRM ids are kept: they are needed for retries)
    expect(JSON.stringify(logs)).not.toMatch(/session=|@|17563|6067417/);
  });
});

describe("webhook signature and order reading (contract, mock fetch)", () => {
  const secret = "synthetic-webhook-secret-0123456789";
  const body = JSON.stringify({ id: 17563, status: "processing" });
  const sign = (b: string, s = secret) => createHmac("sha256", s).update(b).digest("base64");

  it("accepts only a correct HMAC of the raw body", () => {
    expect(verifyWooSignature(body, sign(body), secret)).toBe(true);
    expect(verifyWooSignature(body, sign(body, "other-secret-other-secret"), secret)).toBe(false);
    expect(verifyWooSignature(`${body} `, sign(body), secret)).toBe(false);
    expect(verifyWooSignature(body, null, secret)).toBe(false);
    expect(verifyWooSignature(body, "", secret)).toBe(false);
    expect(verifyWooSignature(body, sign(body), "short")).toBe(false);
  });

  it("takes only a valid positive integer order id from a webhook body", () => {
    expect(orderIdFromWebhook(body)).toBe("17563");
    expect(orderIdFromWebhook('{"id":"17563"}')).toBe("17563");
    for (const bad of ["{}", "not json", '{"id":0}', '{"id":-1}', '{"id":"../1"}', '{"id":1.5}', '{"id":"1e3"}', "null"]) expect(() => orderIdFromWebhook(bad)).toThrow(PaymentError);
  });

  const wooFetch = (status: number, json: unknown) => async () => new Response(JSON.stringify(json), { status });
  const verifier = (fetch: ConstructorParameters<typeof WooCommerceOrderVerifier>[0]["fetch"]) => new WooCommerceOrderVerifier({ baseUrl: "https://6tofit.com", consumerKey: "ck_synthetic", consumerSecret: "cs_synthetic", ...(fetch ? { fetch } : {}) });
  const wc = (over: Record<string, unknown> = {}) => ({ id: 17563, status: "processing", total: "49.00", currency: "CAD", date_paid: "2026-10-14T09:00:00", payment_method: "stripe", transaction_id: "txn_1", refunds: [], line_items: [{ sku: "PLAN-VIP-1M" }], ...over });

  it("maps the WooCommerce order: money received only with status processing/completed AND a paid date; refunds are classified", async () => {
    expect(await verifier(wooFetch(200, wc())).verify("17563")).toMatchObject({ paid: true, refunded: false, partialRefund: false, gateway: "stripe", productSkus: ["PLAN-VIP-1M"] });
    expect((await verifier(wooFetch(200, wc({ status: "completed" }))).verify("17563")).paid).toBe(true);
    expect((await verifier(wooFetch(200, wc({ status: "pending", date_paid: null }))).verify("17563")).paid).toBe(false);
    expect((await verifier(wooFetch(200, wc({ date_paid: null }))).verify("17563")).paid).toBe(false);
    expect((await verifier(wooFetch(200, wc({ total: "0.00" }))).verify("17563")).paid).toBe(false);
    expect(await verifier(wooFetch(200, wc({ refunds: [{ total: "-49.00" }] }))).verify("17563")).toMatchObject({ refunded: true, partialRefund: false });
    expect(await verifier(wooFetch(200, wc({ refunds: [{ total: "-10.00" }] }))).verify("17563")).toMatchObject({ refunded: false, partialRefund: true });
    expect((await verifier(wooFetch(200, wc({ status: "refunded" }))).verify("17563")).refunded).toBe(true);
    expect((await verifier(wooFetch(200, wc({ status: "weird" }))).verify("17563")).status).toBe("unknown");
  });

  it("a missing order is 'not paid'; an unreadable, failing or mismatching answer is an error, never a guess", async () => {
    expect(await verifier(wooFetch(404, {})).verify("17563")).toMatchObject({ paid: false, status: "unknown" });
    await expect(verifier(wooFetch(500, {})).verify("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(verifier(wooFetch(401, {})).verify("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(verifier(async () => new Response("<html>", { status: 200 })).verify("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(verifier(async () => { throw new Error("network"); }).verify("17563")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(verifier(wooFetch(200, wc({ id: 99999 }))).verify("17563")).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(verifier(wooFetch(200, wc())).verify("../1")).rejects.toMatchObject({ code: "INVALID_ORDER_ID" });
  });

  it("needs an https shop URL and credentials; credentials are sent only as Basic auth to the configured shop", async () => {
    expect(() => new WooCommerceOrderVerifier({ baseUrl: "http://6tofit.com", consumerKey: "a", consumerSecret: "b" })).toThrow(PaymentError);
    expect(() => new WooCommerceOrderVerifier({ baseUrl: "https://6tofit.com", consumerKey: "", consumerSecret: "b" })).toThrow(PaymentError);
    let seen: { url: string; auth: string } | undefined;
    await verifier(async (url, init) => { seen = { url, auth: init.headers["authorization"] as string }; return new Response(JSON.stringify(wc()), { status: 200 }); }).verify("17563");
    expect(seen!.url).toBe("https://6tofit.com/wp-json/wc/v3/orders/17563");
    expect(seen!.auth).toMatch(/^Basic /);
  });
});

describe("end to end with the Onboarding API", () => {
  it("the link issued for a paid order is accepted by the Onboarding API and its subject/Request key follow from the order", async () => {
    const w = make();
    await w.orch.process("17563");
    const token = new URL(w.delivery.sent[0]!.link).searchParams.get("session")!;
    const claims = verifyLinkToken(token, SECRET, NOW_MS);
    expect(subjectKey(claims)).toMatch(/^onb_[0-9a-f]{40}$/);
    const service = createOnboardingService({ store: new FileOnboardingStore(dir), directory: { async resolve() { return { prefill: {} }; } }, sink: new LocalFileSink(dir), secret: SECRET, now: () => NOW_MS });
    expect((await service.bootstrap(token)).status).toBe(200);
    await writeFile(join(dir, "marker"), "x");
  });
});
