// @vitest-environment node
// ONB-DELIVERY-01: e-mail delivery adapter + Zoho CRM Send Mail provider (CANDIDATE). MOCKS ONLY: no network, no e-mail is sent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZohoClient } from "../crm/client";
import { loadCrmConfig } from "../crm/config";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "../crm/mock-zoho";
import { DEAL_ID, NOW_MS, SECRET } from "../fixtures";
import { FileIssuedLinkStore } from "../links/registry";
import type { ContactView, CrmDealReader } from "../links/types";
import { ZohoCrmSendMail } from "./crm-send-mail";
import { EmailDelivery, RecipientAllowlist, type MailProvider } from "./email-delivery";
import { buildEmailDelivery } from "./email-runtime";
import { FactStore, orderKey } from "./facts";
import { renderInvitation } from "./invitation-email";
import { createPaymentOnboarding } from "./orchestrator";
import { handlePaymentWebhookFromEnv, resetPaymentRuntimeCache } from "./runtime";
import { DeliveryError, type DealResolver, type OrderVerifier, type ResolvedDeal, type VerifiedOrder } from "./types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-email-"));
  resetPaymentRuntimeCache();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const ORIGIN = "https://onboarding-staging.6tofit.com";
const LINK = `${ORIGIN}/?session=eyJ.synthetic.token`;
const CONTACT = "6223361000127220001";
const TESTBOX = "qa-inbox@example.invalid";

const sendEnv = (): Record<string, string> => ({
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "c",
  SIX2FIT_ZOHO_CLIENT_SECRET: "s",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON",
  SIX2FIT_ZOHO_TIMEOUT_MS: "200",
});

/** Provider under test: a ZohoClient on the fixture Zoho; `handler` answers the send_mail call. */
function provider(handler: (body: any, path: string) => Response | Promise<Response>) {
  const zoho = new MockZoho();
  const sent: Array<{ path: string; body: any; method: string }> = [];
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/actions/send_mail")) {
      const body = JSON.parse(init.body ?? "{}");
      sent.push({ path: u.pathname, body, method: init.method });
      return handler(body, u.pathname);
    }
    return zoho.fetch(url, init as never);
  }) as never;
  const client = new ZohoClient(loadCrmConfig(sendEnv()), { fetch, now: () => Date.now(), sleep: async () => undefined });
  return { p: new ZohoCrmSendMail(client, { name: "6toFit", email: "noreply@example.invalid" }), sent };
}
const J = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OK = J(200, { data: [{ code: "SUCCESS", details: { message_id: "msg-abc123" }, message: "ok", status: "success" }] });
const msg = { dealId: DEAL_ID.slice(0, 19), toEmail: TESTBOX, subject: "s", html: "<p>x</p>" };
const failure = async (p: ZohoCrmSendMail) => (await p.send(msg).catch((e: unknown) => e)) as DeliveryError;

describe("ZohoCrmSendMail (documented Send Mail API contract)", () => {
  it("sends one POST with exactly the documented body and returns the provider message id", async () => {
    const { p, sent } = provider(() => OK.clone());
    expect(await p.send(msg)).toEqual({ reference: "msg-abc123" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: `/crm/v8/Deals/${msg.dealId}/actions/send_mail` });
    expect(sent[0]?.body).toEqual({ data: [{ from: { user_name: "6toFit", email: "noreply@example.invalid" }, to: [{ email: TESTBOX }], subject: "s", content: "<p>x</p>", mail_format: "html", org_email: false }] });
  });

  it("documented permanent refusals need a human; documented temporary ones can be retried", async () => {
    for (const code of ["MANDATORY_NOT_FOUND", "NOT_ALLOWED", "INVALID_DATA", "FEATURE_NOT_SUPPORTED", "FILE_SIZE_EXCEEDS"]) {
      const e = await failure(provider(() => J(400, { data: [{ code, status: "error", message: "m" }] })).p);
      expect([e.kind, e.code]).toEqual(["permanent", code]);
    }
    const noPerm = await failure(provider(() => J(403, { data: [{ code: "NO_PERMISSION", status: "error" }] })).p);
    expect([noPerm.kind, noPerm.code]).toEqual(["permanent", "NO_PERMISSION"]);
    for (const code of ["LIMIT_EXCEEDED", "CUSTOM_ERROR", "RECORD_LOCKED"]) {
      const e = await failure(provider(() => J(400, { data: [{ code, status: "error" }] })).p);
      expect([e.kind, e.code]).toEqual(["definite", code]);
    }
    expect((await failure(provider(() => J(429, {})).p)).kind).toBe("definite");
    const unknown = await failure(provider(() => J(400, { data: [{ code: "SOMETHING_NEW" }] })).p);
    expect([unknown.kind, unknown.code]).toEqual(["permanent", "UNKNOWN_SOMETHING_NEW"]);
  });

  it("anything that may have been accepted is AMBIGUOUS: 5xx, timeout, network error, unreadable or non-documented success shape", async () => {
    expect((await failure(provider(() => J(500, {})).p)).kind).toBe("ambiguous");
    expect((await failure(provider(() => J(502, "x")).p)).kind).toBe("ambiguous");
    expect((await failure(provider(() => new Response("<html>", { status: 200 })).p)).kind).toBe("ambiguous");
    expect((await failure(provider(() => J(200, { data: [{ code: "SUCCESS" }] })).p)).kind).toBe("ambiguous"); // success without a message id
    expect((await failure(provider(() => J(200, { data: [] })).p)).kind).toBe("ambiguous");
    const net = await failure(provider(() => { throw new TypeError("fetch failed"); }).p);
    expect([net.kind, net.code]).toEqual(["ambiguous", "NETWORK"]);
    const slow = await failure(provider(() => new Promise<Response>(() => undefined)).p);
    expect([slow.kind, slow.code]).toEqual(["ambiguous", "TIMEOUT"]);
  });

  it("auth failures are definite; a wrong organisation is refused before anything is sent", async () => {
    expect((await failure(provider(() => J(401, { code: "INVALID_TOKEN" })).p)).kind).toBe("definite");
    expect((await failure(provider(() => J(403, { data: [{ code: "OTHER" }] })).p)).code).toBe("FORBIDDEN");
    const zoho = new MockZoho();
    let sends = 0;
    const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/actions/send_mail")) { sends += 1; return OK.clone(); }
      if (u.pathname === "/crm/v8/org") return J(200, { org: [{ id: "6223361000000000999", zgid: "999999999", type: "sandbox" }] });
      return zoho.fetch(url, init as never);
    }) as never;
    const p = new ZohoCrmSendMail(new ZohoClient(loadCrmConfig(sendEnv()), { fetch, now: () => Date.now(), sleep: async () => undefined }), { name: "n", email: "noreply@example.invalid" });
    const e = (await p.send(msg).catch((x: unknown) => x)) as DeliveryError;
    expect([e.kind, e.code]).toEqual(["definite", "ENV_MISMATCH"]);
    expect(sends).toBe(0);
  });

  it("errors never contain the recipient, the content or any credential", async () => {
    const e = await failure(provider(() => J(400, { data: [{ code: "NOT_ALLOWED", message: `blocked ${TESTBOX}` }] })).p);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toMatch(/qa-inbox|synthetic-refresh|<p>/);
  });
});

describe("EmailDelivery guards", () => {
  const ok: MailProvider = { send: vi.fn(async () => ({ reference: "r1" })) };
  const mk = (over: Partial<ConstructorParameters<typeof EmailDelivery>[0]> = {}) =>
    new EmailDelivery({ provider: ok, recipient: async () => TESTBOX, render: renderInvitation, linkOrigin: ORIGIN, allowlist: new RecipientAllowlist([TESTBOX]), ...over });
  const input = { dealId: DEAL_ID, contactId: CONTACT, orderId: "1", link: LINK, attempt: 1 };
  const kindOf = async (d: EmailDelivery, i = input) => ((await d.send(i).catch((e: unknown) => e)) as DeliveryError);
  beforeEach(() => vi.mocked(ok.send).mockClear());

  it("sends the rendered message to an allowed recipient and returns the provider reference", async () => {
    expect(await mk().send(input)).toEqual({ reference: "r1" });
    const arg = vi.mocked(ok.send).mock.calls[0]![0];
    expect(arg.toEmail).toBe(TESTBOX);
    expect(arg.html).toContain('dir="rtl"');
    expect(arg.html).toContain("eyJ.synthetic.token");
  });

  it("missing, invalid or non-allowlisted recipients and foreign links are PERMANENT and never reach the provider", async () => {
    for (const [name, d, i] of [
      ["NO_RECIPIENT", mk({ recipient: async () => null }), input],
      ["NO_RECIPIENT", mk({ recipient: async () => "  " }), input],
      ["INVALID_RECIPIENT", mk({ recipient: async () => "not-an-email" }), input],
      ["RECIPIENT_NOT_ALLOWED", mk({ recipient: async () => "real.customer@example.com" }), input],
      ["LINK_INVALID", mk(), { ...input, link: "https://evil.example/?session=x" }],
      ["LINK_INVALID", mk(), { ...input, link: "http://onboarding-staging.6tofit.com/?session=x" }],
      ["LINK_INVALID", mk(), { ...input, link: "not a url" }],
    ] as const) {
      const e = await kindOf(d, i);
      expect([e.kind, e.code]).toEqual(["permanent", name]);
    }
    expect(ok.send).not.toHaveBeenCalled();
  });

  it("a CRM read failure while looking up the recipient is definite (nothing was sent)", async () => {
    const e = await kindOf(mk({ recipient: async () => { throw new Error("down"); } }));
    expect([e.kind, e.code]).toEqual(["definite", "RECIPIENT_LOOKUP_UNAVAILABLE"]);
  });

  it("an empty allowlist allows nobody; entries are validated; domains match exactly", () => {
    expect(new RecipientAllowlist([]).allows(TESTBOX)).toBe(false);
    expect(new RecipientAllowlist(["@example.invalid"]).allows("A@Example.Invalid")).toBe(true);
    expect(new RecipientAllowlist(["@example.invalid"]).allows("a@sub.example.invalid")).toBe(false);
    expect(() => new RecipientAllowlist(["*"])).toThrow();
  });

  it("the invitation HTML escapes the link and carries no personal data", () => {
    const { html } = renderInvitation('https://x.example/?a="b"&c=<d>');
    expect(html).not.toContain('"b"');
    expect(html).not.toContain("<d>");
    expect(html).toContain("&amp;c=&lt;d&gt;");
  });
});

describe("e-mail runtime switch (OFF by default)", () => {
  const full = (): Record<string, string> => ({
    ...sendEnv(),
    SIX2FIT_EMAIL_DELIVERY_MODE: "crm-send-mail",
    SIX2FIT_EMAIL_FROM: "noreply@example.invalid",
    SIX2FIT_EMAIL_FROM_NAME: "6toFit",
    SIX2FIT_EMAIL_ALLOWED_RECIPIENTS: TESTBOX,
    SIX2FIT_ZOHO_MAILER_CLIENT_ID: "mc",
    SIX2FIT_ZOHO_MAILER_CLIENT_SECRET: "ms",
    SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN: "synthetic-mailer-refresh",
    SIX2FIT_FORM_BASE_URL: ORIGIN,
  });
  const reader = { getContact: async (): Promise<ContactView> => ({ id: CONTACT, email: TESTBOX, phone: null, mobile: null }) } as unknown as CrmDealReader;

  it("disabled or unset builds nothing; a full configuration builds; every missing piece fails closed", () => {
    expect(buildEmailDelivery({ ...full(), SIX2FIT_EMAIL_DELIVERY_MODE: "" })).toBeNull();
    expect(buildEmailDelivery({ ...full(), SIX2FIT_EMAIL_DELIVERY_MODE: "disabled" })).toBeNull();
    expect(buildEmailDelivery(full(), { reader })).toBeInstanceOf(EmailDelivery);
    const bad = (over: Record<string, string | undefined>) => expect(() => buildEmailDelivery({ ...full(), ...over }, { reader })).toThrowError(expect.objectContaining({ kind: "NOT_CONFIGURED" }));
    bad({ SIX2FIT_EMAIL_DELIVERY_MODE: "smtp" });
    bad({ SIX2FIT_EMAIL_FROM: "nope" });
    bad({ SIX2FIT_EMAIL_FROM_NAME: "" });
    bad({ SIX2FIT_EMAIL_ALLOWED_RECIPIENTS: "" });
    bad({ SIX2FIT_EMAIL_ALLOWED_RECIPIENTS: "*" });
    bad({ SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN: "" });
    bad({ SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN: "synthetic-refresh" }); // must differ from the writer grant
    bad({ SIX2FIT_FORM_BASE_URL: "http://insecure.example" });
  });

  it("the payment webhook still answers 503 PAYMENT_DELIVERY_NOT_CONFIGURED while e-mail is off", async () => {
    const res = await handlePaymentWebhookFromEnv(new Request("https://x.invalid/api/payments/woocommerce", { method: "POST", body: "{}" }), {}, { SIX2FIT_STAGING_STORAGE_DIR: dir, SIX2FIT_WOO_WEBHOOK_SECRET: "x".repeat(20) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error_code: "PAYMENT_DELIVERY_NOT_CONFIGURED" });
  });
});

describe("orchestrator with the e-mail delivery semantics", () => {
  const order: VerifiedOrder = { orderId: "17563", status: "processing", paid: true, refunded: false, partialRefund: false, total: "49.00", currency: "CAD", datePaid: "2026-10-14T09:00:00", gateway: "stripe", transactionId: "txn_synthetic", productSkus: [] };
  const deal: ResolvedDeal = { dealId: DEAL_ID, contactId: CONTACT, scope: "Combo", entitlements: [], isFirstRequest: true, productRelatedTo: "F", productId: "6223361000999000001" };
  function make(script: Array<() => { reference?: string } | void>, o: { clock?: { t: number }; ttl?: number } = {}) {
    const clock = o.clock ?? { t: NOW_MS };
    const facts = new FactStore(join(dir, "payments"));
    const calls: string[] = [];
    const verifier: OrderVerifier = { verify: async () => order };
    const deals: DealResolver = { findByOrder: async () => deal };
    const delivery = { send: async (i: { link: string }) => { calls.push(i.link); const step = script.shift(); if (!step) return; return step(); } };
    const orch = createPaymentOnboarding({ facts, verifier, deals, delivery, registry: new FileIssuedLinkStore(join(dir, "issued-links")), linkSecret: SECRET, onboardingBaseUrl: new URL(ORIGIN), now: () => clock.t, retryBackoffMs: 1000, ...(o.ttl ? { linkTtlSeconds: o.ttl } : {}) });
    return { orch, facts, calls, clock };
  }
  const refuse = (kind: "definite" | "permanent" | "ambiguous", code: string) => () => { throw new DeliveryError(kind, code); };

  it("stores the provider reference as 'accepted', not as proof of delivery", async () => {
    const w = make([() => ({ reference: "msg-1" })]);
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect(await w.facts.get(orderKey("17563"), "delivery-1-result")).toMatchObject({ status: "sent", proof: "provider_accepted", reference: "msg-1" });
  });

  it("a permanent refusal (no recipient, opted out) goes to review once and is never retried by a later event", async () => {
    const w = make([refuse("permanent", "NO_RECIPIENT")]);
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_rejected" });
    w.clock.t += 3_600_000;
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_rejected" });
    expect(w.calls).toHaveLength(1);
  });

  it("a definite refusal (daily limit) is retried after the back-off and then delivered, once", async () => {
    const w = make([refuse("definite", "LIMIT_EXCEEDED"), () => ({ reference: "msg-2" })]);
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later");
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later"); // inside the back-off: no send
    expect(w.calls).toHaveLength(1);
    w.clock.t += 2000;
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect((await w.orch.process("17563")).state).toBe("delivered");
    expect(w.calls).toHaveLength(2);
  });

  it("an ambiguous outcome is never resent, however often the event repeats or time passes", async () => {
    const w = make([refuse("ambiguous", "TIMEOUT"), () => ({ reference: "must-not-happen" })]);
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "delivery_unknown" });
    w.clock.t += 7 * 24 * 3600_000;
    expect((await w.orch.process("17563")).state).toBe("needs_review");
    expect(w.calls).toHaveLength(1);
  });

  it("an expired link is never sent on a late retry", async () => {
    const w = make([refuse("definite", "LIMIT_EXCEEDED")], { ttl: 3600 });
    expect((await w.orch.process("17563")).state).toBe("delivery_retry_later");
    w.clock.t += 2 * 3600_000; // retry after the link's expiry
    expect(await w.orch.process("17563")).toEqual({ state: "needs_review", reason: "link_expired" });
    expect(w.calls).toHaveLength(1);
  });

  it("a link revoked before the send is not sent", async () => {
    const w = make([() => ({ reference: "x" })]);
    await w.facts.put(orderKey("17563"), "revoked", { reason: "refunded", at: NOW_MS });
    expect((await w.orch.process("17563")).state).toBe("revoked");
    expect(w.calls).toHaveLength(0);
  });
});
