// @vitest-environment node
// Link Issuer (Create Form -> signed onboarding link). MOCKS ONLY: no CRM, no network, no messaging, no WorkDrive.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreError } from "../errors";
import { SECRET } from "../fixtures";
import { IdempotencyLedger } from "../ledger";
import type { OnboardingStore, SubjectDirectory } from "../ports";
import { createOnboardingService } from "../service";
import { TokenError, verifyLinkToken } from "../tokens";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signIssuerRequest } from "./auth";
import { ISSUE_LINK_PATH, handleIssueLink } from "./http";
import { createLinkIssuer, claimsOf, linkClaimsOf, type IssuerDeps } from "./issuer";
import { ExplicitProductMap, productMapFromEnv } from "./product-map";
import { InMemoryIssuedLinkStore, LedgerSubmissionStatusReader } from "./status";
import { CrmReadError, type ContactView, type CrmDealReader, type DealView, type LinkSubmissionStatus, type SubmissionStatusReader } from "./types";
import { buildFormUrls, matchesFrontendContract, sessionFromUrl } from "./urls";

const BASE = "https://onboarding-staging.6tofit.com";
const ORG = "850673613";
const DEAL = "6223361000127220003";
const CONTACT = "6223361000127220001";
const PRODUCT = "6223361000999000001";
const ISSUER_SECRET = "issuer-caller-secret-0123456789abcdef0123";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const TTL = 14 * 24 * 3600;
// synthetic PII that must never appear in any URL, token or response
const PII = { email: "ali.synthetic@example.invalid", phone: "+98 21 0000 0000", mobile: "+98 912 000 0000", name: "Ali Synthetic" };

class MockCrm implements CrmDealReader {
  deals = new Map<string, DealView | null>([[DEAL, { id: DEAL, orgId: ORG, contactId: CONTACT, productId: PRODUCT, productName: "Synthetic Plan, 1 Month", productRelatedTo: "Synthetic Related" }]]);
  contacts = new Map<string, ContactView | null>([[CONTACT, { id: CONTACT, email: PII.email, phone: PII.phone, mobile: PII.mobile }]]);
  prior = false;
  fail: CrmReadError | null = null;
  calls: string[] = [];
  async getDeal(id: string) {
    this.calls.push("getDeal");
    if (this.fail) throw this.fail;
    return this.deals.get(id) ?? null;
  }
  async getContact(id: string) {
    this.calls.push("getContact");
    return this.contacts.get(id) ?? null;
  }
  async hasPriorRequests() {
    this.calls.push("hasPriorRequests");
    return this.prior;
  }
}

class StatusStub implements SubmissionStatusReader {
  state: LinkSubmissionStatus = "none";
  async statusFor() {
    return this.state;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-links-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function world(over: Partial<IssuerDeps> = {}) {
  const crm = new MockCrm();
  const links = new InMemoryIssuedLinkStore();
  const status = new StatusStub();
  const revoked = new Set<string>();
  const clock = { t: NOW };
  let n = 0;
  const issuer = createLinkIssuer({
    crm,
    products: new ExplicitProductMap({ [PRODUCT]: { scope: "Combo", entitlements: ["cellulite"] } }),
    links,
    submissions: status,
    isRevoked: async (j) => revoked.has(j),
    secret: SECRET,
    baseUrl: BASE,
    expectedOrgId: ORG,
    ttlSeconds: TTL,
    now: () => clock.t,
    newJti: () => `jti_${String((n += 1)).padStart(12, "0")}_abcd`,
    ...over,
  });
  return { crm, links, status, revoked, clock, issuer };
}

/** The real bootstrap path (service.bootstrap), fed with the token exactly as the frontend would extract it from the URL. */
function bootstrapService(secret = SECRET, now = () => NOW) {
  const store: OnboardingStore = { get: async () => { throw new Error("store must not be used by bootstrap"); }, create: async () => { throw new Error("store must not be used by bootstrap"); } };
  const directory: SubjectDirectory = { resolve: async () => ({ prefill: {} }) };
  return createOnboardingService({ store, directory, sink: { put: async () => { throw new Error("no files in bootstrap"); } }, secret, now });
}

describe("issuing a link (valid Deal and Contact)", () => {
  it("returns Persian and English URLs that match the frontend contract and open through the real bootstrap", async () => {
    const w = world();
    const r = await w.issuer.issue(DEAL);
    expect(r).toMatchObject({ ok: true, status: "issued", deal_id: DEAL, scope: "Combo", entitlements: ["cellulite"], is_first_request: true, language_support: { fa: true, en: false } });
    if (!r.ok) throw new Error("unreachable");
    expect(matchesFrontendContract(r.urls.fa, BASE)).toBe(true);
    expect(r.urls.en).toBeNull(); // the frontend does not render English: no English link is offered
    expect(new URL(r.urls.fa).pathname).toBe("/");
    expect([...new URL(r.urls.fa).searchParams.keys()]).toEqual(["session"]);
    expect(r.expires_at).toBe(new Date(NOW + TTL * 1000).toISOString());

    // the token is read from `session` exactly like the frontend, and the REAL bootstrap accepts it
    const token = sessionFromUrl(r.urls.fa) as string;
    const claims = verifyLinkToken(token, SECRET, NOW);
    expect(claims).toMatchObject({ v: 2, subject: { kind: "deal", dealId: DEAL }, scope: "Combo", entitlements: ["cellulite"], jti: r.jti });
    const boot = await bootstrapService().bootstrap(token);
    expect(boot.status).toBe(200);
    expect(boot.body).toMatchObject({ scope: "Combo", entitlements: ["cellulite"], form_session_token: token });
  });

  it("puts no customer data in the URL, the token or the response", async () => {
    const w = world();
    const r = await w.issuer.issue(DEAL);
    if (!r.ok) throw new Error("unreachable");
    const everything = JSON.stringify(r) + decodeURIComponent(r.urls.fa) + Buffer.from((sessionFromUrl(r.urls.fa) as string).split(".")[0] as string, "base64url").toString("utf8");
    for (const v of [...Object.values(PII), CONTACT, "ali", "synthetic@"]) expect(everything.toLowerCase()).not.toContain(String(v).toLowerCase());
    expect(new URL(r.urls.fa).search).not.toMatch(/dealId|email|phone|name|productName/i);
  });

  it("marks a Contact with earlier Requests as not first-time", async () => {
    const w = world();
    w.crm.prior = true;
    const r = await w.issuer.issue(DEAL);
    expect(r).toMatchObject({ ok: true, is_first_request: false });
  });
});

describe("refusals (no link, no CRM change)", () => {
  const expectError = (r: Awaited<ReturnType<ReturnType<typeof world>["issuer"]["issue"]>>, status: number, code: string) => {
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(status);
      expect(r.error_code).toBe(code);
      expect(JSON.stringify(r)).not.toContain("session=");
    }
  };

  it("malformed Deal ids are refused before any CRM read", async () => {
    const w = world();
    for (const bad of [undefined, null, 42, "", "abc", "123", "6223361000127220003 ", "../1234567", "1".repeat(40)]) expectError(await w.issuer.issue(bad), 400, "INVALID_DEAL_ID");
    expect(w.crm.calls).toEqual([]);
  });

  it("missing Deal, missing Contact, Contact without any channel, missing Product", async () => {
    const w = world();
    expectError(await w.issuer.issue("6223361000127229999"), 404, "DEAL_NOT_FOUND");
    w.crm.deals.set(DEAL, { ...(w.crm.deals.get(DEAL) as DealView), contactId: null });
    expectError(await w.issuer.issue(DEAL), 422, "NO_CONTACT");
    w.crm.deals.set(DEAL, { ...(w.crm.deals.get(DEAL) as DealView), contactId: CONTACT });
    w.crm.contacts.set(CONTACT, null);
    expectError(await w.issuer.issue(DEAL), 422, "NO_CONTACT");
    w.crm.contacts.set(CONTACT, { id: CONTACT, email: null, phone: null, mobile: null });
    expectError(await w.issuer.issue(DEAL), 422, "NO_CONTACT_CHANNEL");
    w.crm.contacts.set(CONTACT, { id: CONTACT, email: PII.email, phone: null, mobile: null });
    w.crm.deals.set(DEAL, { ...(w.crm.deals.get(DEAL) as DealView), productId: null, productName: null });
    expectError(await w.issuer.issue(DEAL), 422, "PRODUCT_MISSING");
    expect(w.links.count(DEAL)).toBe(0);
  });

  it("a product without an approved mapping is refused, never guessed from its name", async () => {
    const empty = world({ products: new ExplicitProductMap() });
    expectError(await empty.issuer.issue(DEAL), 422, "PRODUCT_UNMAPPED");
    const other = world({ products: new ExplicitProductMap({ "6223361000999000002": { scope: "Diet", entitlements: [] } }) });
    other.crm.deals.set(DEAL, { ...(other.crm.deals.get(DEAL) as DealView), productName: "Fitness And Nutrition Plan, VIP Cellulite, 1 Month" });
    expectError(await other.issuer.issue(DEAL), 422, "PRODUCT_UNMAPPED");
    expect(empty.links.count(DEAL)).toBe(0);
  });

  it("an invalid mapping table is rejected at configuration time", () => {
    expect(() => new ExplicitProductMap({ "6223361000999000001": { scope: "Gold" as never, entitlements: [] } })).toThrow("PRODUCT_MAP_INVALID");
    expect(() => new ExplicitProductMap({ "6223361000999000001": { scope: "Combo", entitlements: ["free-stuff"] } })).toThrow("PRODUCT_MAP_INVALID");
    expect(() => new ExplicitProductMap({ "not-an-id": { scope: "Combo", entitlements: [] } })).toThrow("PRODUCT_MAP_INVALID");
    expect(() => productMapFromEnv("{not json")).toThrow("PRODUCT_MAP_INVALID");
    expect(productMapFromEnv(undefined).map({ id: PRODUCT })).toBeNull();
    expect(productMapFromEnv(JSON.stringify({ [PRODUCT]: { scope: "Training", entitlements: [] } })).map({ id: PRODUCT })).toEqual({ scope: "Training", entitlements: [] });
  });

  it("wrong environment: a Deal from another organisation is refused", async () => {
    const w = world();
    w.crm.deals.set(DEAL, { ...(w.crm.deals.get(DEAL) as DealView), orgId: "999999999" });
    expectError(await w.issuer.issue(DEAL), 403, "WRONG_ENVIRONMENT");
    const noOrg = world({ expectedOrgId: "111111111" });
    expectError(await noOrg.issuer.issue(DEAL), 403, "WRONG_ENVIRONMENT");
  });

  it("a CRM or registry failure is a clean 503 without any link", async () => {
    const w = world();
    w.crm.fail = new CrmReadError("UNAVAILABLE");
    expectError(await w.issuer.issue(DEAL), 503, "CRM_UNAVAILABLE");
    const broken = world({ links: { latestFor: async () => { throw new Error("disk"); }, tryRecord: async () => false } });
    expectError(await broken.issuer.issue(DEAL), 503, "ISSUER_UNAVAILABLE");
    const lost = world({ links: { latestFor: async () => null, tryRecord: async () => false } });
    expectError(await lost.issuer.issue(DEAL), 503, "ISSUER_UNAVAILABLE");
  });
});

describe("token validation through the existing bootstrap", () => {
  it("a tampered token, an expired token and a token of another environment are rejected", async () => {
    const w = world();
    const r = await w.issuer.issue(DEAL);
    if (!r.ok) throw new Error("unreachable");
    const token = sessionFromUrl(r.urls.fa) as string;
    const svc = bootstrapService();
    expect((await svc.bootstrap(token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA"))).status).toBe(401); // signature
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), scope: "Training" })).toString("base64url");
    expect((await svc.bootstrap(`${forged}.${sig}`)).status).toBe(401); // payload edited, signature kept
    expect((await bootstrapService(SECRET, () => NOW + TTL * 1000 + 1000).bootstrap(token)).status).toBe(401); // expired
    expect((await bootstrapService("another-environment-secret-0123456789abcdef").bootstrap(token)).status).toBe(401); // other environment's secret
    expect(() => verifyLinkToken(token, SECRET, NOW + TTL * 1000 + 1000)).toThrow(TokenError);
    expect((await svc.bootstrap(token)).status).toBe(200);
  });

  it("a bare Deal id is never an acceptable session", async () => {
    const svc = bootstrapService();
    for (const bad of [DEAL, `v2.${DEAL}`, "", "x.y"]) expect((await svc.bootstrap(bad)).status).toBe(401);
  });
});

describe("link reuse and lifecycle (provisional rule)", () => {
  it("repeated clicks return the same link while it is valid and unused", async () => {
    const w = world();
    const a = await w.issuer.issue(DEAL);
    const b = await w.issuer.issue(DEAL);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect([a.status, b.status]).toEqual(["issued", "reused"]);
    expect(b.jti).toBe(a.jti);
    expect(b.urls).toEqual(a.urls); // byte-identical token: the registry stores claims, never the token
    expect(w.links.count(DEAL)).toBe(1);
  });

  it("two simultaneous clicks issue ONE link (compare-and-set)", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.issuer.issue(DEAL), w.issuer.issue(DEAL)]);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.jti).toBe(b.jti);
    expect(w.links.count(DEAL)).toBe(1);
    expect([a.status, b.status].sort()).toEqual(["issued", "reused"]);
  });

  it("an expired link is replaced by a new one; a revoked link is replaced too", async () => {
    const w = world();
    const a = await w.issuer.issue(DEAL);
    if (!a.ok) throw new Error("unreachable");
    w.clock.t += (TTL - 30) * 1000; // inside the 60 s safety margin of the expiry
    const b = await w.issuer.issue(DEAL);
    if (!b.ok) throw new Error("unreachable");
    expect([b.status, b.jti === a.jti]).toEqual(["issued", false]);
    w.revoked.add(b.jti);
    const c = await w.issuer.issue(DEAL);
    if (!c.ok) throw new Error("unreachable");
    expect([c.status, c.jti === b.jti]).toEqual(["issued", false]);
    expect(w.links.count(DEAL)).toBe(3);
  });

  it("a previously submitted or unresolved link stops issuance with an explicit status", async () => {
    const w = world();
    const a = await w.issuer.issue(DEAL);
    if (!a.ok) throw new Error("unreachable");
    w.status.state = "submitted";
    expect(await w.issuer.issue(DEAL)).toMatchObject({ ok: false, httpStatus: 409, error_code: "ALREADY_SUBMITTED", jti: a.jti });
    w.status.state = "unresolved";
    expect(await w.issuer.issue(DEAL)).toMatchObject({ ok: false, httpStatus: 409, error_code: "SUBMISSION_UNRESOLVED", jti: a.jti });
    expect(w.links.count(DEAL)).toBe(1);
  });

  it("a changed product mapping issues a new link instead of reusing a stale scope", async () => {
    const w = world();
    const a = await w.issuer.issue(DEAL);
    const b = await createLinkIssuer({ ...{ crm: w.crm, links: w.links, submissions: w.status, isRevoked: async () => false, secret: SECRET, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: TTL, now: () => w.clock.t }, products: new ExplicitProductMap({ [PRODUCT]: { scope: "Training", entitlements: [] } }) }).issue(DEAL);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect([b.status, b.scope, b.jti === a.jti]).toEqual(["issued", "Training", false]);
  });

  it("the ledger-backed status reader maps real onboarding states", async () => {
    const w = world();
    const r = await w.issuer.issue(DEAL);
    if (!r.ok) throw new Error("unreachable");
    const record = (await w.links.latestFor(DEAL)) as NonNullable<Awaited<ReturnType<typeof w.links.latestFor>>>;
    const ledger = new IdempotencyLedger(join(dir, "ledger"));
    const reader = new LedgerSubmissionStatusReader(ledger);
    expect(await reader.statusFor(record)).toBe("none");
    const { subjectKey } = await import("../tokens");
    const id = subjectKey(linkClaimsOf(record));
    const base = { v: 1 as const, id, gen: 1, fp: "f".repeat(64), uk: `onb2_${DEAL}_${record.jti}`, attempts: 1, started: NOW, updated: NOW };
    expect(await ledger.claim({ ...base, state: "in_progress", phase: "claimed" })).toBe(true);
    expect(await reader.statusFor(record)).toBe("unresolved");
    await ledger.update({ ...base, state: "unknown" });
    expect(await reader.statusFor(record)).toBe("unresolved");
    await ledger.update({ ...base, state: "created", crm_id: "100000001" });
    expect(await reader.statusFor(record)).toBe("submitted");
    await ledger.update({ ...base, state: "released" });
    expect(await reader.statusFor(record)).toBe("none");
  });
});

describe("the internal endpoint", () => {
  const body = JSON.stringify({ deal_id: DEAL });
  const request = (over: { method?: string; body?: string; ts?: number; sig?: string | null; secret?: string; path?: string } = {}) => {
    const ts = over.ts ?? Math.floor(NOW / 1000);
    const b = over.body ?? body;
    const path = over.path ?? ISSUE_LINK_PATH;
    const sig = over.sig === undefined ? signIssuerRequest(over.secret ?? ISSUER_SECRET, ts, over.method ?? "POST", path, b) : over.sig;
    const headers: Record<string, string> = { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts) };
    if (sig) headers[SIGNATURE_HEADER] = sig;
    return new Request(`${BASE}${path}`, { method: over.method ?? "POST", headers, ...((over.method ?? "POST") === "POST" ? { body: b } : {}) });
  };
  const deps = () => {
    const w = world();
    return { w, deps: { issuer: w.issuer, callerSecret: ISSUER_SECRET, now: () => NOW } };
  };

  it("serves a signed request and returns only ids, scope, expiry and URLs", async () => {
    const { deps: d } = deps();
    const res = await handleIssueLink(request(), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const j = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["deal_id", "entitlements", "expires_at", "is_first_request", "jti", "language_support", "scope", "status", "urls"]);
    for (const v of Object.values(PII)) expect(JSON.stringify(j)).not.toContain(v);
  });

  it("rejects unsigned, wrongly signed, stale, replayed-on-another-body and wrong-path calls", async () => {
    const { deps: d } = deps();
    expect((await handleIssueLink(request({ sig: null }), d)).status).toBe(401);
    expect((await handleIssueLink(request({ secret: "a-different-caller-secret-0123456789abcdefg" }), d)).status).toBe(401);
    expect((await handleIssueLink(request({ ts: Math.floor(NOW / 1000) - 3600 }), d)).status).toBe(401);
    const good = request();
    const swapped = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ deal_id: "6223361000127220009" }) });
    expect((await handleIssueLink(swapped, d)).status).toBe(401);
    expect((await handleIssueLink(request({ path: "/api/internal/other" }), d)).status).toBe(401);
  });

  it("validates the method, the size and the shape of the body", async () => {
    const { deps: d } = deps();
    expect((await handleIssueLink(request({ method: "GET" }), d)).status).toBe(405);
    expect((await handleIssueLink(request({ body: "x".repeat(2000) }), d)).status).toBe(413);
    expect((await handleIssueLink(request({ body: "not json" }), d)).status).toBe(400);
    expect((await handleIssueLink(request({ body: JSON.stringify({ deal_id: DEAL, email: PII.email }) }), d)).status).toBe(400);
    expect((await handleIssueLink(request({ body: JSON.stringify({ deal_id: "abc" }) }), d)).status).toBe(400);
  });

  it("maps issuer errors to the staff-facing status codes", async () => {
    const { w, deps: d } = deps();
    w.crm.deals.set(DEAL, { ...(w.crm.deals.get(DEAL) as DealView), productId: null });
    const res = await handleIssueLink(request(), d);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "PRODUCT_MISSING" });
  });
});

describe("isolation: reading only, no side effects", () => {
  it("never writes to the CRM, sends a message, creates a Request or touches WorkDrive", async () => {
    const w = world();
    await w.issuer.issue(DEAL);
    await w.issuer.issue(DEAL);
    expect(new Set(w.crm.calls)).toEqual(new Set(["getDeal", "getContact", "hasPriorRequests"])); // reads only
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // static guard: the module imports nothing that could write or send
    for (const f of ["types.ts", "issuer.ts", "urls.ts", "auth.ts", "http.ts", "product-map.ts", "status.ts"]) {
      const code = (await readFile(join(__dirname, f), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/workdrive|sendmail|nodemailer|fetch\(|updateRecord|createRecord|requests-store|crm\/client/i);
    }
    // the reader port itself exposes no mutating method
    expect(Object.getOwnPropertyNames(MockCrm.prototype).filter((m) => m !== "constructor").sort()).toEqual(["getContact", "getDeal", "hasPriorRequests"]);
  });

  it("builds claims deterministically and refuses malformed base URLs or tokens", () => {
    const rec = { deal_id: DEAL, jti: "jti_000000000001_abcd", scope: "Combo" as const, entitlements: ["cellulite"], iat: 1, exp: 2_000_000_000, product_id: PRODUCT, is_first_request: true };
    expect(JSON.stringify(claimsOf(rec))).toBe(JSON.stringify(claimsOf({ ...rec })));
    for (const bad of ["http://x.test", "https://x.test/path", "https://x.test/?a=1", "https://user:pw@x.test", "nope"]) expect(() => buildFormUrls(bad, "aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb")).toThrow();
    expect(() => buildFormUrls(BASE, "no-dot-token")).toThrow("TOKEN_SHAPE");
    expect(matchesFrontendContract(`${BASE}/?session=aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb&dealId=${DEAL}`, BASE)).toBe(false);
    expect(matchesFrontendContract(`${BASE}/x?session=aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb`, BASE)).toBe(false);
    expect(matchesFrontendContract(`https://evil.test/?session=aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb`, BASE)).toBe(false);
    expect(StoreError).toBeDefined();
  });

  it("refuses unsafe issuer configuration", () => {
    const common = { crm: new MockCrm(), products: new ExplicitProductMap(), links: new InMemoryIssuedLinkStore(), submissions: new StatusStub(), isRevoked: async () => false, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: TTL };
    expect(() => createLinkIssuer({ ...common, secret: "short" })).toThrow("ISSUER_SECRET_TOO_SHORT");
    expect(() => createLinkIssuer({ ...common, secret: SECRET, ttlSeconds: 10 })).toThrow("ISSUER_TTL_INVALID");
    expect(() => createLinkIssuer({ ...common, secret: SECRET, ttlSeconds: 365 * 24 * 3600 })).toThrow("ISSUER_TTL_INVALID");
    expect(() => createLinkIssuer({ ...common, secret: SECRET, baseUrl: "http://insecure.test" })).toThrow("BASE_URL_INVALID");
  });
});
