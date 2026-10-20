// @vitest-environment node
// Deal-aware bootstrap: issued link -> `session` -> real service.bootstrap -> DealSubjectDirectory. MOCKS ONLY:
// no CRM, no network, no WorkDrive, no messages. The CRM reader port has no mutating method (asserted below).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsultHandoffDirectory } from "../file-store";
import { CONSULT_ID, SECRET, consultToken } from "../fixtures";
import { handleBootstrap } from "../http";
import type { OnboardingStore } from "../ports";
import { createOnboardingService } from "../service";
import { signLinkToken } from "../tokens";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signIssuerRequest } from "./auth";
import { CompositeSubjectDirectory, DealSubjectDirectory } from "./deal-directory";
import { ISSUE_LINK_ACTION, ISSUE_LINK_PATH, handleIssueLink, isIssueLinkRequest } from "./http";
import { createLinkIssuer } from "./issuer";
import { ExplicitProductMap, productMapFromEnv } from "./product-map";
import { handleIssueLinkFromEnv } from "./runtime";
import { InMemoryIssuedLinkStore } from "./status";
import { CrmReadError, type ContactView, type CrmDealReader, type DealView, type ScopeMapping } from "./types";
import { sessionFromUrl } from "./urls";

const BASE = "https://onboarding-staging.6tofit.com";
const ORG = "850673613";
const DEAL = "6223361000127220003"; // synthetic QA Deal
const CONTACT = "6223361000127220001"; // synthetic QA Contact
const PRODUCT = "6223361000999000001";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const TTL = 14 * 24 * 3600;
const ISSUER_SECRET = "issuer-caller-secret-0123456789abcdef0123";

class MockCrm implements CrmDealReader {
  deal: DealView | null = { id: DEAL, orgId: ORG, contactId: CONTACT, productId: PRODUCT, productName: "Synthetic Plan", productRelatedTo: "Synthetic Related" };
  contacts = new Map<string, ContactView | null>([[CONTACT, { id: CONTACT, email: "ali.synthetic@example.invalid", phone: null, mobile: null }]]);
  fail: CrmReadError | Error | null = null;
  calls: string[] = [];
  async getDeal() {
    this.calls.push("getDeal");
    if (this.fail) throw this.fail;
    return this.deal;
  }
  async getContact(id: string) {
    this.calls.push("getContact");
    return this.contacts.get(id) ?? null;
  }
  async hasPriorRequests() {
    this.calls.push("hasPriorRequests");
    return false;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-dealdir-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const COMBO: ScopeMapping = { scope: "Combo", entitlements: ["cellulite"] };
const storeSpy = () => {
  const calls: string[] = [];
  const store: OnboardingStore = { get: async () => { calls.push("get"); return null; }, create: async () => { calls.push("create"); throw new Error("bootstrap must not write"); } };
  return { store, calls };
};

function world(mapping: Record<string, ScopeMapping> = { [PRODUCT]: COMBO }, handoff = false) {
  const crm = new MockCrm();
  const products = new ExplicitProductMap(mapping);
  const { store, calls } = storeSpy();
  const directory = new CompositeSubjectDirectory(handoff ? new ConsultHandoffDirectory(dir) : null, new DealSubjectDirectory({ crm, products, expectedOrgId: ORG }));
  const service = createOnboardingService({ store, directory, sink: { put: async () => { throw new Error("no files"); } }, secret: SECRET, acceptConsultHandoff: handoff, now: () => NOW });
  const issuer = createLinkIssuer({ crm, products, links: new InMemoryIssuedLinkStore(), submissions: { statusFor: async () => "none" }, isRevoked: async () => false, secret: SECRET, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: TTL, now: () => NOW });
  return { crm, products, service, issuer, storeCalls: calls };
}

async function issuedToken(w: ReturnType<typeof world>): Promise<string> {
  const r = await w.issuer.issue(DEAL);
  if (!r.ok) throw new Error(`issue failed: ${r.error_code}`);
  return sessionFromUrl(r.urls.fa) as string;
}

describe("Deal link opens the real bootstrap", () => {
  it("issued Deal token -> 200 with the scope/entitlements of the signed claims and NO customer data", async () => {
    const w = world();
    const token = await issuedToken(w);
    const boot = await w.service.bootstrap(token);
    expect(boot.status).toBe(200);
    expect(boot.body).toMatchObject({ scope: "Combo", entitlements: ["cellulite"], form_session_token: token, prefill: {} });
    expect(JSON.stringify(boot.body)).not.toMatch(/ali|synthetic@|6223361000127220001/i);
    expect(w.storeCalls).toEqual([]); // nothing persisted, no CRM Request, no WorkDrive file
  });

  it("opening the link repeatedly has no side effects (same answer, reads only)", async () => {
    const w = world();
    const token = await issuedToken(w);
    const first = await w.service.bootstrap(token);
    const second = await w.service.bootstrap(token);
    const third = await w.service.bootstrap(token);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(w.storeCalls).toEqual([]);
    expect(new Set(w.crm.calls)).toEqual(new Set(["getDeal", "getContact", "hasPriorRequests"])); // only the three read methods exist
  });

  it("the CRM reader port exposes read methods only", () => {
    const methods = Object.getOwnPropertyNames(MockCrm.prototype).filter((m) => m !== "constructor").sort();
    expect(methods).toEqual(["getContact", "getDeal", "hasPriorRequests"]);
  });

  it("works through the real HTTP handler for the Persian URL (`/?six2fit_api=bootstrap&session=`) and the GET path", async () => {
    const w = world();
    const token = await issuedToken(w);
    const runtime = () => ({ service: w.service, maxBodyBytes: 1024 });
    const viaPost = await handleBootstrap(new Request(`${BASE}/?six2fit_api=bootstrap&session=${encodeURIComponent(token)}`, { method: "POST" }), { runtime });
    const viaGet = await handleBootstrap(new Request(`${BASE}/api/onboarding/bootstrap?session=${encodeURIComponent(token)}`), { runtime });
    for (const res of [viaPost, viaGet]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ scope: "Combo", entitlements: ["cellulite"] });
    }
  });

  it("a raw `dealId` query parameter is not an input: without a signed `session` nothing opens", async () => {
    const w = world();
    const res = await handleBootstrap(new Request(`${BASE}/?six2fit_api=bootstrap&dealId=${DEAL}&scope=Combo`, { method: "POST" }), { runtime: () => ({ service: w.service, maxBodyBytes: 1024 }) });
    expect(res.status).toBe(401);
    expect(w.crm.calls).toEqual([]);
  });
});

describe("Deal link is validated against trusted CRM data (fail closed)", () => {
  it("unknown Deal -> 404 SESSION_NOT_FOUND", async () => {
    const w = world();
    const token = await issuedToken(w);
    w.crm.deal = null;
    const r = await w.service.bootstrap(token);
    expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([404, "SESSION_NOT_FOUND"]);
  });

  it("Deal returned for another id -> 403 NOT_ELIGIBLE", async () => {
    const w = world();
    const token = await issuedToken(w);
    (w.crm.deal as DealView).id = "6223361000127229999";
    expect((await w.service.bootstrap(token)).status).toBe(403);
  });

  it("Deal without a Contact, or a Contact that does not match the Deal's relation -> 403", async () => {
    const w = world();
    const token = await issuedToken(w);
    (w.crm.deal as DealView).contactId = null;
    expect((await w.service.bootstrap(token)).status).toBe(403);
    (w.crm.deal as DealView).contactId = "6223361000127220777"; // Deal now points at a Contact that does not exist
    expect((await w.service.bootstrap(token)).status).toBe(403);
    (w.crm.deal as DealView).contactId = CONTACT;
    w.crm.contacts.set(CONTACT, { id: "6223361000127220555", email: "x@example.invalid", phone: null, mobile: null }); // relation returns another Contact
    expect((await w.service.bootstrap(token)).status).toBe(403);
  });

  it("wrong organisation/environment -> 403 and no data", async () => {
    const w = world();
    const token = await issuedToken(w);
    (w.crm.deal as DealView).orgId = "999999999";
    const r = await w.service.bootstrap(token);
    expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([403, "NOT_ELIGIBLE"]);
  });

  it("Product scope changed, removed or removed from the table after issuance -> 403", async () => {
    const w = world();
    const token = await issuedToken(w);
    (w.crm.deal as DealView).productId = "6223361000999000002"; // product without an approved mapping
    expect((await w.service.bootstrap(token)).status).toBe(403);
    (w.crm.deal as DealView).productId = null;
    expect((await w.service.bootstrap(token)).status).toBe(403);
    // product now maps to a different scope than the token claims
    const other = world({ [PRODUCT]: { scope: "Diet", entitlements: [] } });
    expect((await other.service.bootstrap(token)).status).toBe(403);
    // entitlement mismatch with the same scope
    const noEnt = world({ [PRODUCT]: { scope: "Combo", entitlements: [] } });
    expect((await noEnt.service.bootstrap(token)).status).toBe(403);
  });

  it("a validly signed token whose claims do not match the Deal's mapping is refused (forged scope needs the secret, so test the mapping path)", async () => {
    const w = world();
    const forged = signLinkToken({ v: 2, deal_id: DEAL, jti: "link_0123456789abcdef0123", scope: "Training", entitlements: [], exp: Math.floor(NOW / 1000) + 3600 }, SECRET);
    expect((await w.service.bootstrap(forged)).status).toBe(403);
  });

  it("expired and tampered tokens are rejected before any CRM read", async () => {
    const w = world();
    const token = await issuedToken(w);
    const expired = signLinkToken({ v: 2, deal_id: DEAL, jti: "link_0123456789abcdef0123", scope: "Combo", entitlements: ["cellulite"], exp: Math.floor(NOW / 1000) - 5 }, SECRET);
    const [payload, sig] = token.split(".") as [string, string];
    const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), scope: "Training" })).toString("base64url")}.${sig}`;
    const otherSecret = signLinkToken({ v: 2, deal_id: DEAL, jti: "link_0123456789abcdef0123", scope: "Combo", entitlements: ["cellulite"], exp: Math.floor(NOW / 1000) + 3600 }, "another-secret-0123456789abcdef0123456789");
    w.crm.calls = []; // issuance itself reads the CRM
    for (const t of [expired, tampered, otherSecret, "", "abc", `${payload}.`]) expect((await w.service.bootstrap(t)).status).toBe(401);
    expect(w.crm.calls).toEqual([]);
  });

  it("CRM unavailable (reader error or unexpected exception) -> 503 IDENTITY_UNAVAILABLE, never a success", async () => {
    const w = world();
    const token = await issuedToken(w);
    for (const failure of [new CrmReadError("UNAVAILABLE"), new CrmReadError("FORBIDDEN"), new Error("boom")]) {
      w.crm.fail = failure;
      const r = await w.service.bootstrap(token);
      expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([503, "IDENTITY_UNAVAILABLE"]);
    }
  });

  it("no Deal resolver configured (today's runtime) -> Deal links still fail closed", async () => {
    const w = world();
    const token = await issuedToken(w);
    const { store } = storeSpy();
    const closed = createOnboardingService({ store, directory: new CompositeSubjectDirectory(new ConsultHandoffDirectory(dir), null), sink: { put: async () => "" }, secret: SECRET, now: () => NOW });
    const r = await closed.bootstrap(token);
    expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([503, "IDENTITY_UNAVAILABLE"]);
  });
});

describe("Consultation flow regression", () => {
  it("a Consultation token still resolves its prefill through the unchanged file hand-off ONLY when the hand-off is explicitly enabled (development/staging)", async () => {
    const w = world(undefined, true);
    await mkdir(join(dir, "consult"), { recursive: true });
    await writeFile(join(dir, "consult", `${CONSULT_ID}.json`), JSON.stringify({ payload: { onboarding_prefill: { "ON-01": "Synthetic", timezone: "Asia/Tehran", secret_field: "ignored" } } }));
    const r = await w.service.bootstrap(consultToken({ exp: Math.floor(NOW / 1000) + 3600 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: "Combo", prefill: { "ON-01": "Synthetic", timezone: "Asia/Tehran" } });
    expect((r.body as { prefill: Record<string, unknown> }).prefill).not.toHaveProperty("secret_field");
    expect(w.crm.calls).toEqual([]);
  });

  it("an unknown Consultation record is still 404 when the hand-off is enabled", async () => {
    const w = world(undefined, true);
    expect((await w.service.bootstrap(consultToken({ exp: Math.floor(NOW / 1000) + 3600 }))).status).toBe(404);
  });
});

describe("product mapping configuration", () => {
  it("covers Diet, Training, Combo and CIP scopes from explicit synthetic ids; commercial attributes stay out of the token", async () => {
    const ids = { Diet: "6223361000999100001", Training: "6223361000999100002", Combo: "6223361000999100003", CIP: "6223361000999100004" } as const;
    const map = productMapFromEnv(JSON.stringify({
      [ids.Diet]: { scope: "Diet", entitlements: [], commercial: { level: "Core", duration_months: 1 } },
      [ids.Training]: { scope: "Training", entitlements: [], commercial: { level: "VIP", duration_months: 3 } },
      [ids.Combo]: { scope: "Combo", entitlements: ["cellulite"], commercial: { level: "VIP", duration_months: 6 } },
      [ids.CIP]: { scope: "CIP", entitlements: [] },
    }));
    for (const [scope, id] of Object.entries(ids)) {
      const w = world();
      const issuer = createLinkIssuer({ crm: w.crm, products: map, links: new InMemoryIssuedLinkStore(), submissions: { statusFor: async () => "none" }, isRevoked: async () => false, secret: SECRET, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: TTL, now: () => NOW });
      (w.crm.deal as DealView).productId = id;
      (w.crm.deal as DealView).productName = `Synthetic ${scope}`;
      const r = await issuer.issue(DEAL);
      if (!r.ok) throw new Error(r.error_code);
      expect(r.scope).toBe(scope);
      const payload = Buffer.from((sessionFromUrl(r.urls.fa) as string).split(".")[0] as string, "base64url").toString();
      expect(payload).not.toMatch(/level|duration|VIP|Core/);
    }
  });

  it("never infers a scope from the product NAME: a Product named 'Combo' without a table entry is unmapped", async () => {
    const w = world({});
    (w.crm.deal as DealView).productName = "Combo Plan VIP 6 months";
    const r = await w.issuer.issue(DEAL);
    expect(r).toMatchObject({ ok: false, error_code: "PRODUCT_UNMAPPED", httpStatus: 422 });
  });

  it("rejects an invalid table at startup (bad scope, bad entitlement, bad commercial value, non-numeric id)", () => {
    expect(() => productMapFromEnv(JSON.stringify({ [PRODUCT]: { scope: "VIP", entitlements: [] } }))).toThrow("PRODUCT_MAP_INVALID");
    expect(() => productMapFromEnv(JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: ["nope"] } }))).toThrow("PRODUCT_MAP_INVALID");
    expect(() => productMapFromEnv(JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [], commercial: { duration_months: 0 } } }))).toThrow("PRODUCT_MAP_INVALID");
    expect(() => productMapFromEnv(JSON.stringify({ "Combo-1": { scope: "Combo", entitlements: [] } }))).toThrow("PRODUCT_MAP_INVALID");
    expect(productMapFromEnv("").map({ id: PRODUCT })).toBeNull();
  });
});

describe("language and routing contract", () => {
  it("offers no English link while the frontend does not render English; Persian is the only supported language", async () => {
    const w = world();
    const r = await w.issuer.issue(DEAL);
    if (!r.ok) throw new Error("unreachable");
    expect(r.urls.en).toBeNull();
    expect(r.language_support).toEqual({ fa: true, en: false });
    expect(new URL(r.urls.fa).search).toMatch(/^\?session=/);
    expect(new URL(r.urls.fa).searchParams.has("lang")).toBe(false);
  });

  it("an English link is produced only when explicitly enabled (frontend work still required)", async () => {
    const w = world();
    const issuer = createLinkIssuer({ crm: w.crm, products: w.products, links: new InMemoryIssuedLinkStore(), submissions: { statusFor: async () => "none" }, isRevoked: async () => false, secret: SECRET, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: TTL, now: () => NOW, englishUi: true });
    const r = await issuer.issue(DEAL);
    if (!r.ok) throw new Error("unreachable");
    expect(new URL(r.urls.en as string).searchParams.get("lang")).toBe("en");
  });

  it("concurrent clicks on the same Deal issue exactly one link", async () => {
    const w = world();
    const results = await Promise.all([w.issuer.issue(DEAL), w.issuer.issue(DEAL), w.issuer.issue(DEAL)]);
    const jtis = new Set(results.map((r) => (r.ok ? r.jti : "fail")));
    expect(jtis.size).toBe(1);
    expect(results.filter((r) => r.ok && r.status === "issued")).toHaveLength(1);
  });

  it("the issuer is reachable at the canonical path and at the sub-path-safe alias, signed over the canonical path", async () => {
    const w = world();
    const body = JSON.stringify({ deal_id: DEAL });
    const ts = Math.floor(NOW / 1000);
    const sig = signIssuerRequest(ISSUER_SECRET, ts, "POST", ISSUE_LINK_PATH, body);
    const mk = (url: string) => new Request(url, { method: "POST", body, headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sig, "content-type": "application/json" } });
    expect(isIssueLinkRequest(mk(`${BASE}${ISSUE_LINK_PATH}`))).toBe(true);
    expect(isIssueLinkRequest(mk(`${BASE}/?six2fit_api=${ISSUE_LINK_ACTION}`))).toBe(true);
    expect(isIssueLinkRequest(mk(`${BASE}/?six2fit_api=bootstrap`))).toBe(false);
    for (const url of [`${BASE}${ISSUE_LINK_PATH}`, `${BASE}/?six2fit_api=${ISSUE_LINK_ACTION}`]) {
      const res = await handleIssueLink(mk(url), { issuer: w.issuer, callerSecret: ISSUER_SECRET, now: () => NOW });
      expect(res.status).toBe(200);
    }
    const wrong = await handleIssueLink(mk(`${BASE}/other-path`), { issuer: w.issuer, callerSecret: ISSUER_SECRET, now: () => NOW });
    expect(wrong.status).toBe(401);
  });

  it("the registered route answers 503 until the read-only reader and registry are configured (nothing can be issued by accident)", async () => {
    const res = await handleIssueLinkFromEnv(new Request(`${BASE}${ISSUE_LINK_PATH}`, { method: "POST", body: "{}" }), {}, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error_code: "ISSUER_NOT_CONFIGURED" });
  });
});
