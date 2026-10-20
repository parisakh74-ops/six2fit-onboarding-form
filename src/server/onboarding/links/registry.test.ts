// @vitest-environment node
// T06: durable link registry + issuer. MOCKS ONLY (fake read-only CRM reader, temp directory).
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLinkIssuer } from "./issuer";
import { ExplicitProductMap } from "./product-map";
import { FileIssuedLinkStore } from "./registry";
import type { ContactView, CrmDealReader, DealView, IssuedLinkRecord, SubmissionStatusReader } from "./types";

const ORG = "850673613";
const DEAL = "6223361000127220003";
const CONTACT = "6223361000127220001";
const PRODUCT = "6223361000999000001";
const SECRET = "issuer-signing-secret-0123456789abcdef0123";
const BASE = "https://onboarding-staging.6tofit.com";
let dir: string;
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "s2f-registry-"))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

const rec = (jti: string, over: Partial<IssuedLinkRecord> = {}): IssuedLinkRecord => ({ deal_id: DEAL, jti, scope: "Combo", entitlements: [], iat: 1_000_000, exp: 2_000_000, product_id: PRODUCT, is_first_request: true, ...over });

describe("T06 FileIssuedLinkStore", () => {
  it("is empty at first, then returns the newest record; compare-and-set refuses a stale expectation", async () => {
    const s = new FileIssuedLinkStore(dir);
    expect(await s.latestFor(DEAL)).toBeNull();
    expect(await s.tryRecord(rec("jti-aaaaaaaa"), null)).toBe(true);
    expect(await s.tryRecord(rec("jti-bbbbbbbb"), null)).toBe(false); // someone issued meanwhile
    expect(await s.tryRecord(rec("jti-bbbbbbbb"), "jti-aaaaaaaa")).toBe(true);
    expect((await s.latestFor(DEAL))?.jti).toBe("jti-bbbbbbbb");
    expect((await s.history(DEAL)).map((r) => r.jti)).toEqual(["jti-bbbbbbbb", "jti-aaaaaaaa"]);
  });

  it("survives a restart (a new instance on the same directory sees the same state)", async () => {
    await new FileIssuedLinkStore(dir).tryRecord(rec("jti-aaaaaaaa"), null);
    expect((await new FileIssuedLinkStore(dir).latestFor(DEAL))?.jti).toBe("jti-aaaaaaaa");
  });

  it("ten simultaneous issuances for one Deal produce exactly one winner, across independent store instances", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => new FileIssuedLinkStore(dir).tryRecord(rec(`jti-racer-${i}x`), null)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readdir(join(dir, `deal_${DEAL}`))).toEqual(["g1.json"]); // no leftover temp files
  });

  it("holds no token, name or contact data, and rejects malformed ids and records", async () => {
    const s = new FileIssuedLinkStore(dir);
    await s.tryRecord(rec("jti-aaaaaaaa", { product_related_to: "Fitness" }), null);
    const raw = await readFile(join(dir, `deal_${DEAL}`, "g1.json"), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["deal_id", "entitlements", "exp", "iat", "is_first_request", "jti", "product_id", "product_related_to", "scope"]);
    await expect(s.latestFor("../etc")).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(s.tryRecord(rec("x"), null)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    await expect(s.tryRecord(rec("jti-aaaaaaaa", { scope: "Evil" as never }), "jti-aaaaaaaa")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("a tampered generation file is reported as corrupt, never silently ignored", async () => {
    const s = new FileIssuedLinkStore(dir);
    await s.tryRecord(rec("jti-aaaaaaaa"), null);
    await writeFile(join(dir, `deal_${DEAL}`, "g1.json"), "{not json");
    await expect(s.latestFor(DEAL)).rejects.toMatchObject({ kind: "CORRUPT" });
  });
});

class Crm implements CrmDealReader {
  async getDeal(): Promise<DealView> {
    return { id: DEAL, orgId: ORG, contactId: CONTACT, productId: PRODUCT, productName: "P", productRelatedTo: "Fitness" };
  }
  async getContact(): Promise<ContactView> {
    return { id: CONTACT, email: "a@example.invalid", phone: null, mobile: null };
  }
  async hasPriorRequests() {
    return false;
  }
}
const issuer = (store: FileIssuedLinkStore, status: SubmissionStatusReader = { statusFor: async () => "none" }, revoked = new Set<string>(), now = () => 1_800_000_000_000) =>
  createLinkIssuer({ crm: new Crm(), products: new ExplicitProductMap({ [PRODUCT]: { scope: "Combo", entitlements: [] } }), links: store, submissions: status, isRevoked: async (j) => revoked.has(j), secret: SECRET, baseUrl: BASE, expectedOrgId: ORG, ttlSeconds: 25 * 24 * 3600, now });

describe("T06 issuer on the durable registry", () => {
  it("repeated issuance returns the same link (also after a restart and from two instances); no raw token is stored", async () => {
    const a = await issuer(new FileIssuedLinkStore(dir)).issue(DEAL);
    expect(a).toMatchObject({ ok: true, status: "issued" });
    const b = await issuer(new FileIssuedLinkStore(dir)).issue(DEAL);
    expect(b).toMatchObject({ ok: true, status: "reused" });
    if (a.ok && b.ok) {
      expect(b.jti).toBe(a.jti);
      expect(b.urls.fa).toBe(a.urls.fa); // deterministic signing: same claims, same link
      const raw = await readFile(join(dir, `deal_${DEAL}`, "g1.json"), "utf8");
      expect(raw).not.toContain(a.urls.fa.split("session=")[1] as string);
    }
  });

  it("simultaneous issuance from independent instances yields one link", async () => {
    const out = await Promise.all(Array.from({ length: 6 }, () => issuer(new FileIssuedLinkStore(dir)).issue(DEAL)));
    const jtis = new Set(out.map((r) => (r.ok ? r.jti : "fail")));
    expect(jtis.size).toBe(1);
    expect(out.every((r) => r.ok)).toBe(true);
    expect((await readdir(join(dir, `deal_${DEAL}`))).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("expiry and revocation issue a new link and keep the history; submitted and unresolved stop issuance", async () => {
    const store = new FileIssuedLinkStore(dir);
    const first = await issuer(store).issue(DEAL);
    if (!first.ok) throw new Error("setup");
    const later = 1_800_000_000_000 + 26 * 24 * 3600 * 1000; // after the 25-day TTL
    const renewed = await issuer(store, undefined, undefined, () => later).issue(DEAL);
    expect(renewed).toMatchObject({ ok: true, status: "issued" });
    if (renewed.ok) expect(renewed.jti).not.toBe(first.jti);
    const revoked = await issuer(store, undefined, new Set([renewed.ok ? renewed.jti : ""]), () => later).issue(DEAL);
    expect(revoked).toMatchObject({ ok: true, status: "issued" });
    expect(await store.history(DEAL)).toHaveLength(3);
    expect(await issuer(store, { statusFor: async () => "submitted" }).issue(DEAL)).toMatchObject({ ok: false, error_code: "ALREADY_SUBMITTED" });
    expect(await issuer(store, { statusFor: async () => "unresolved" }).issue(DEAL)).toMatchObject({ ok: false, error_code: "SUBMISSION_UNRESOLVED" });
  });
});
