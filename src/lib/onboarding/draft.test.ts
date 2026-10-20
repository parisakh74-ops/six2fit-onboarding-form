import { describe, expect, it } from "vitest";
import { DRAFT_PREFIX, DRAFT_TTL_MS, LEGACY_DRAFT_KEY, clearDraft, draftKey, loadDraft, purgeDrafts, saveDraft, type DraftStorage } from "./draft";

class MemoryStorage implements DraftStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  keys() { return [...this.m.keys()]; }
}

const tok = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const A = tok({ v: 2, deal_id: "6067417000000000001", jti: "link_aaaaaaaaaaaaaaaaaaaa" });
const A2 = tok({ v: 2, deal_id: "6067417000000000001", jti: "link_bbbbbbbbbbbbbbbbbbbb" }); // re-issued link, same Deal
const B = tok({ v: 2, deal_id: "6067417000000000002", jti: "link_cccccccccccccccccccc" }); // another customer
const NOW = Date.UTC(2026, 9, 20);
const draft = { a: { "ON-01": "Synthetic Person", "ON-08": 170 }, ver: { "ON-01": "confirmed" }, step: 3 };

describe("scoped drafts", () => {
  it("round-trips a draft for the same journey, including a re-issued link of the same Deal", () => {
    const s = new MemoryStorage();
    expect(saveDraft(s, A, draft, NOW)).toBe(true);
    expect(loadDraft(s, A, NOW + 1000)).toEqual(draft);
    expect(loadDraft(s, A2, NOW + 1000)).toEqual(draft);
  });

  it("never shows one customer's draft to another journey (shared browser)", () => {
    const s = new MemoryStorage();
    saveDraft(s, A, draft, NOW);
    expect(loadDraft(s, B, NOW + 1000)).toBeNull();
    expect(draftKey(A)).not.toBe(draftKey(B));
  });

  it("keys are short hashes: no token, Deal id or answer appears in storage keys", () => {
    const s = new MemoryStorage();
    saveDraft(s, A, draft, NOW);
    const k = s.keys().join(" ");
    expect(k.startsWith(DRAFT_PREFIX)).toBe(true);
    expect(k).not.toMatch(/6067417000000000001|link_|Synthetic/);
  });

  it("a cycle claim, when present, defines the scope (a new cycle of the same Deal does not inherit the old draft)", () => {
    const c1 = tok({ v: 2, deal_id: "6067417000000000001", cycle: "ocy_one" });
    const c2 = tok({ v: 2, deal_id: "6067417000000000001", cycle: "ocy_two" });
    const s = new MemoryStorage();
    saveDraft(s, c1, draft, NOW);
    expect(loadDraft(s, c2, NOW + 1000)).toBeNull();
    expect(loadDraft(s, c1, NOW + 1000)).toEqual(draft);
  });

  it("drafts expire (rolling 25 days) and corrupt or future-dated entries are discarded", () => {
    const s = new MemoryStorage();
    saveDraft(s, A, draft, NOW);
    expect(loadDraft(s, A, NOW + DRAFT_TTL_MS - 1)).toEqual(draft);
    expect(loadDraft(s, A, NOW + DRAFT_TTL_MS + 1)).toBeNull();
    expect(s.keys()).toEqual([]); // removed on read
    s.setItem(draftKey(A), "{not json");
    expect(loadDraft(s, A, NOW)).toBeNull();
    s.setItem(draftKey(A), JSON.stringify({ ...draft, savedAt: NOW + 10 * DRAFT_TTL_MS }));
    expect(loadDraft(s, A, NOW)).toBeNull();
  });

  it("purge removes the legacy global key, other journeys' drafts and stale drafts, and keeps the current one", () => {
    const s = new MemoryStorage();
    s.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ a: { "ON-01": "Someone Else" } }));
    saveDraft(s, B, draft, NOW);
    saveDraft(s, A, draft, NOW);
    s.setItem("unrelated-key", "keep");
    expect(purgeDrafts(s, A, NOW + 1000)).toBe(2);
    expect(s.getItem(LEGACY_DRAFT_KEY)).toBeNull();
    expect(loadDraft(s, B, NOW + 1000)).toBeNull();
    expect(loadDraft(s, A, NOW + 1000)).toEqual(draft);
    expect(s.getItem("unrelated-key")).toBe("keep");
    expect(purgeDrafts(s, A, NOW + DRAFT_TTL_MS + 5)).toBe(1); // the current one is stale now
  });

  it("clearing removes only the current journey's draft; storage failures never throw", () => {
    const s = new MemoryStorage();
    saveDraft(s, A, draft, NOW);
    saveDraft(s, B, draft, NOW);
    clearDraft(s, A);
    expect(loadDraft(s, A, NOW)).toBeNull();
    expect(loadDraft(s, B, NOW)).toEqual(draft);
    const broken: DraftStorage = {
      length: 1,
      key: () => { throw new Error("blocked"); },
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(saveDraft(broken, A, draft, NOW)).toBe(false);
    expect(loadDraft(broken, A, NOW)).toBeNull();
    expect(() => clearDraft(broken, A)).not.toThrow();
    expect(purgeDrafts(broken, A, NOW)).toBe(0);
  });
});
