// @vitest-environment node
// Consultation -> Onboarding prefill (MVP). MOCKS ONLY: no CRM, no network. Synthetic identities (example.invalid).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileOnboardingStore, LocalFileSink } from "../file-store";
import { DEAL_ID, NOW_MS, SECRET, dealToken, validAnswers } from "../fixtures";
import { createOnboardingService } from "../service";
import { CompositeSubjectDirectory, DealSubjectDirectory } from "./deal-directory";
import { PREFILL_GROUPS, PREFILL_KEYS, normalizeEmail, normalizePhone, parsePrefillJson, selectConsultationPrefill } from "./prefill";
import { ExplicitProductMap } from "./product-map";
import { CrmReadError, type ConsultationCandidate, type ContactView, type CrmDealReader, type DealView } from "./types";

const ORG = "850673613";
const CONTACT = "6067417000000000001";
const OTHER_CONTACT = "6067417000000000002";
const PRODUCT = "6067417000000220306";
const DEAL_CREATED = "2026-10-10T10:00:00+00:00";
const DAY = 24 * 3600 * 1000;
const at = (daysBeforeDeal: number) => new Date(Date.parse(DEAL_CREATED) - daysBeforeDeal * DAY).toISOString();
const EMAIL = "synthetic.person@example.invalid";
const PHONE = "+989120000000";

const block = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    "ON-01": "Synthetic Person", "ON-03": "female", "ON-06.iso": "IR", "ON-06.cc": "+98", "ON-06.n": PHONE, "ON-07": EMAIL, "ON-08": 170, "ON-09.kg": 68,
    timezone: "Asia/Tehran", "HL-01": "never", primary_goal: ["fat_loss"], ...over,
  });
const cand = (over: Partial<ConsultationCandidate> = {}): ConsultationCandidate => ({ id: "c1", createdAt: at(5), email: EMAIL, whatsapp: PHONE, contactId: null, prefillJson: block(), ...over });
const contact = (over: Partial<ContactView> = {}): ContactView => ({ id: CONTACT, email: EMAIL, phone: null, mobile: "09120000000", ...over });
const select = (candidates: ConsultationCandidate[], over: Partial<Parameters<typeof selectConsultationPrefill>[0]> = {}) =>
  selectConsultationPrefill({ dealCreatedAt: DEAL_CREATED, contact: contact(), candidates, phoneOwners: { [PHONE]: [CONTACT] }, windowDays: 90, firstCycle: true, ...over });

describe("normalisation", () => {
  it("accepts only certain phone formats and valid e-mails", () => {
    expect(normalizePhone("+98 912 000 0000")).toBe(PHONE);
    expect(normalizePhone("09120000000")).toBe(PHONE);
    expect(normalizePhone("00989120000000")).toBe(PHONE);
    for (const bad of ["9120000000", "12345", "abc", "", "+0123456789", null, 5]) expect(normalizePhone(bad)).toBeNull();
    expect(normalizeEmail("  Synthetic.Person@Example.Invalid ")).toBe(EMAIL);
    for (const bad of ["x", "a@b", "a b@c.de", null]) expect(normalizeEmail(bad)).toBeNull();
  });
});

describe("prefill block parsing (PF6-PF8)", () => {
  it("returns only the eight allowed keys, never timezone, goal or health data", () => {
    const p = parsePrefillJson(block());
    expect(Object.keys(p).sort()).toEqual([...PREFILL_KEYS].sort());
    expect(p["ON-06.n"]).toBe("9120000000"); // national digits, as Onboarding expects
    expect(JSON.stringify(p)).not.toMatch(/Asia|never|fat_loss/);
  });
  it("drops invalid values individually and survives corrupt input", () => {
    const p = parsePrefillJson(block({ "ON-03": "other", "ON-08": 5, "ON-09.kg": "heavy", "ON-07": "nope" }));
    expect(p).not.toHaveProperty("ON-03");
    expect(p).not.toHaveProperty("ON-08");
    expect(p).not.toHaveProperty("ON-09.kg");
    expect(p).not.toHaveProperty("ON-07");
    expect(p["ON-01"]).toBe("Synthetic Person");
    for (const bad of ["{", "null", "[]", "", "x".repeat(40_000), undefined, null]) expect(parsePrefillJson(bad as string)).toEqual({});
  });
  it("drops the whole contact-number group when country and dial code disagree", () => {
    const p = parsePrefillJson(block({ "ON-06.cc": "+1" }));
    expect(Object.keys(p).some((k) => k.startsWith("ON-06"))).toBe(false);
  });
});

describe("selection rules (PF1-PF5, PF16)", () => {
  it("PF1: e-mail match prefills the eight keys", () => {
    const d = select([cand()]);
    expect([d.outcome, d.matchedBy]).toEqual(["matched", "email"]);
    expect(Object.keys(d.prefill).sort()).toEqual([...PREFILL_KEYS].sort());
  });
  it("Contact relationship is the strongest signal; a different Contact is a conflict", () => {
    expect(select([cand({ email: null, whatsapp: null, contactId: CONTACT })]).matchedBy).toBe("contact");
    expect(select([cand({ contactId: OTHER_CONTACT })]).outcome).toBe("ambiguous");
  });
  it("PF2/PF16: same phone but a different e-mail is a conflict, never another customer's data", () => {
    const d = select([cand({ email: "someone.else@example.invalid" })], { contact: contact({ email: "mine@example.invalid" }) });
    expect(d).toMatchObject({ outcome: "ambiguous", prefill: {} });
  });
  it("PF3: phone-only is accepted only without a candidate e-mail and with a unique owner", () => {
    expect(select([cand({ email: null })], { contact: contact({ email: null }) }).matchedBy).toBe("phone");
    expect(select([cand({ email: null })], { contact: contact({ email: null }), phoneOwners: { [PHONE]: [CONTACT, OTHER_CONTACT] } }).prefill).toEqual({});
    expect(select([cand({ email: null })], { contact: contact({ email: null }), phoneOwners: { [PHONE]: [OTHER_CONTACT] } }).prefill).toEqual({});
    expect(select([cand({ email: null, whatsapp: "12345" })], { contact: contact({ email: null }) }).prefill).toEqual({}); // unknown format
  });
  it("phone-only match is ambiguous when another submission in the window conflicts", () => {
    const d = select([cand({ id: "a", email: null, createdAt: at(4) }), cand({ id: "b", email: "other@example.invalid", createdAt: at(3) })], { contact: contact({ email: null }) });
    expect(d.outcome).toBe("ambiguous");
  });
  it("PF4: the newest accepted submission wins", () => {
    const d = select([cand({ id: "old", createdAt: at(30), prefillJson: block({ "ON-08": 160 }) }), cand({ id: "new", createdAt: at(2), prefillJson: block({ "ON-08": 175 }) })]);
    expect(d.prefill["ON-08"]).toBe(175);
  });
  it("PF5: only submissions BEFORE the purchase and inside the window", () => {
    expect(select([cand({ createdAt: at(95) })]).outcome).toBe("none");
    expect(select([cand({ createdAt: new Date(Date.parse(DEAL_CREATED) + DAY).toISOString() })]).outcome).toBe("none"); // after the purchase
    expect(select([cand({ createdAt: at(89) })]).outcome).toBe("matched");
    expect(select([cand({ createdAt: "garbage" })]).outcome).toBe("none");
    expect(select([cand()], { dealCreatedAt: null }).outcome).toBe("no_purchase_time");
  });
  it("only the first onboarding cycle is prefilled", () => {
    expect(select([cand()], { firstCycle: false })).toMatchObject({ outcome: "not_first_cycle", prefill: {} });
  });
  it("names are never used for matching", () => {
    expect(select([cand({ email: null, whatsapp: null })]).outcome).toBe("none");
  });
});

class Reader implements CrmDealReader {
  deal: DealView | null = { id: DEAL_ID, orgId: ORG, contactId: CONTACT, productId: PRODUCT, productName: "p", productRelatedTo: null, createdAt: DEAL_CREATED };
  contacts = new Map<string, ContactView>([[CONTACT, contact()]]);
  candidates: ConsultationCandidate[] = [];
  owners: Record<string, string[]> = { [PHONE]: [CONTACT] };
  completed = false;
  failWith: CrmReadError | null = null;
  failTimes = 0;
  calls = { candidates: 0 };
  writes = 0; // there is no mutating method; kept to prove it stays 0
  async getDeal() { return this.deal; }
  async getContact(id: string) { return this.contacts.get(id) ?? null; }
  async hasPriorRequests() { return false; }
  async findConsultationCandidates() {
    this.calls.candidates += 1;
    if (this.failWith && (this.failTimes === 0 || this.calls.candidates <= this.failTimes)) throw this.failWith;
    return this.candidates;
  }
  async findContactIdsByPhone(p: string) { return this.owners[p] ?? []; }
  async dealHasCompletedRequest() { return this.completed; }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-prefill-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function world(over: { enabled?: boolean; reader?: Reader } = {}) {
  const reader = over.reader ?? new Reader();
  const logs: string[] = [];
  const reviews: Array<{ dealId: string; reason: string }> = [];
  const deal = new DealSubjectDirectory({
    crm: reader,
    products: new ExplicitProductMap({ [PRODUCT]: { scope: "Combo", entitlements: [] } }),
    expectedOrgId: ORG,
    log: (e, f) => logs.push(JSON.stringify({ e, ...f })),
    prefill: { enabled: over.enabled ?? true, windowDays: 90, limit: 10, onReview: (r) => reviews.push(r) },
  });
  const service = createOnboardingService({ store: new FileOnboardingStore(dir), directory: new CompositeSubjectDirectory(null, deal), sink: new LocalFileSink(dir), secret: SECRET, now: () => NOW_MS });
  return { reader, service, logs, reviews };
}
const submit = (service: ReturnType<typeof world>["service"], verification: Record<string, string>) =>
  service.submit({ token: dealToken(), submissionId: "11111111-2222-4333-8444-555555555555", idempotencyKey: "11111111-2222-4333-8444-555555555555", answers: validAnswers("Combo"), verificationState: JSON.stringify(verification), files: {} });

describe("bootstrap prefill through the real service (PF11-PF18)", () => {
  it("PF11 Journey B: no Consultation -> 200 with an empty prefill", async () => {
    const w = world();
    const r = await w.service.bootstrap(dealToken());
    expect([r.status, (r.body as { prefill: object }).prefill]).toEqual([200, {}]);
  });

  it("Journey A: matching Consultation -> eight keys, editable, no timezone, no health data; headers no-store", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    const r = await w.service.bootstrap(dealToken());
    expect(r.status).toBe(200);
    const body = r.body as { prefill: Record<string, unknown> };
    expect(Object.keys(body.prefill).sort()).toEqual([...PREFILL_KEYS].sort());
    expect(JSON.stringify(body)).not.toMatch(/Asia\/Tehran|never|fat_loss/);
    expect(r.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("PF13: no answers in logs (counts and codes only)", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    await w.service.bootstrap(dealToken());
    const all = w.logs.join("\n");
    expect(all).not.toMatch(/Synthetic|example\.invalid|9120000000|Tehran/);
    expect(all).toContain("deal_directory.prefill");
  });

  it("prefill never grants or denies access: ineligible Deal checks still fail first", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    w.reader.deal = null;
    expect((await w.service.bootstrap(dealToken())).status).toBe(404);
    w.reader.deal = { id: DEAL_ID, orgId: "999", contactId: CONTACT, productId: PRODUCT, productName: "p", productRelatedTo: null, createdAt: DEAL_CREATED };
    expect((await w.service.bootstrap(dealToken())).status).toBe(403);
  });

  it("ambiguous identity -> empty prefill plus a review event (ids and a code only)", async () => {
    const w = world();
    w.reader.candidates = [cand({ email: "someone.else@example.invalid" })];
    w.reader.contacts.set(CONTACT, contact({ email: "mine@example.invalid" }));
    const r = await w.service.bootstrap(dealToken());
    expect([r.status, (r.body as { prefill: object }).prefill]).toEqual([200, {}]);
    expect(w.reviews).toEqual([{ dealId: DEAL_ID, reason: "AMBIGUOUS_IDENTITY" }]);
  });

  it("PF12: CRM query error -> one retry, then an identifiable retryable failure; a transient blip recovers", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    w.reader.failWith = new CrmReadError("UNAVAILABLE");
    const r = await w.service.bootstrap(dealToken());
    expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([503, "PREFILL_UNAVAILABLE"]);
    expect(w.reader.calls.candidates).toBe(2);
    const w2 = world();
    w2.reader.candidates = [cand()];
    w2.reader.failWith = new CrmReadError("UNAVAILABLE");
    w2.reader.failTimes = 1;
    expect((await w2.service.bootstrap(dealToken())).status).toBe(200);
  });

  it("PF18: missing module / permission -> identifiable configuration failure, never a silent empty prefill", async () => {
    for (const code of ["FORBIDDEN", "NOT_CONFIGURED"] as const) {
      const w = world();
      w.reader.failWith = new CrmReadError(code);
      const r = await w.service.bootstrap(dealToken());
      expect([r.status, (r.body as { error_code: string }).error_code]).toEqual([503, "PREFILL_CONFIGURATION"]);
      expect(w.reader.calls.candidates).toBe(1); // no retry for configuration errors
    }
    const w = world();
    delete (w.reader as Partial<Reader>).findConsultationCandidates;
    Object.setPrototypeOf(w.reader, Object.create(null));
    const noMethods = world({ reader: Object.assign(Object.create(null), { getDeal: async () => w.reader.deal, getContact: async () => contact(), hasPriorRequests: async () => false }) as Reader });
    const r = await noMethods.service.bootstrap(dealToken());
    expect((r.body as { error_code: string }).error_code).toBe("PREFILL_CONFIGURATION");
  });

  it("renewal cycles (a completed Request exists) get no Consultation prefill", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    w.reader.completed = true;
    expect(((await w.service.bootstrap(dealToken())).body as { prefill: object }).prefill).toEqual({});
  });

  it("disabled flag = no lookup at all and no verification groups", async () => {
    const w = world({ enabled: false });
    w.reader.candidates = [cand()];
    const r = await w.service.bootstrap(dealToken());
    expect((r.body as { prefill: object }).prefill).toEqual({});
    expect(w.reader.calls.candidates).toBe(0);
  });

  it("PF14: submit uses static groups and repeats NO lookup; unknown groups and states are rejected", async () => {
    const w = world();
    w.reader.candidates = [cand()];
    await w.service.bootstrap(dealToken());
    const callsAfterBootstrap = w.reader.calls.candidates;
    w.reader.failWith = new CrmReadError("UNAVAILABLE"); // even a failing lookup cannot break a legitimate submission
    expect((await submit(w.service, { "ON-01": "confirmed", "ON-08": "edited" })).status).toBe(200);
    expect(w.reader.calls.candidates).toBe(callsAfterBootstrap);
    const w2 = world();
    expect((await submit(w2.service, { "HL-01": "confirmed" })).status).toBe(400);
    expect((await submit(w2.service, { "ON-01": "maybe" })).status).toBe(400);
  });

  it("the verification groups are exactly the eight keys' groups", () => {
    expect([...PREFILL_GROUPS].sort()).toEqual(["ON-01", "ON-03", "ON-06", "ON-07", "ON-08", "ON-09"]);
    expect(new Set(PREFILL_KEYS.map((k) => k.split(".")[0]))).toEqual(PREFILL_GROUPS);
  });

  it("the reader port cannot write (no mutating method on the prefill path)", () => {
    expect(Object.getOwnPropertyNames(Reader.prototype).filter((m) => /^(create|update|delete|set|put|upsert|write)/i.test(m))).toEqual([]);
  });
});
