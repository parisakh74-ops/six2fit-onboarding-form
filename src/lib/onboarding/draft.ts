/**
 * Browser draft storage for the Onboarding form.
 *
 * Drafts contain customer answers (including prefilled and health data), so they are:
 *  - scoped to ONE customer journey: the signed link's cycle (or Deal) identity, never a shared global key;
 *  - kept only for a limited time (rolling, `DRAFT_TTL_MS`);
 *  - purged when another journey is opened, when they are stale, and the old global key is always removed;
 *  - cleared after a successful submission or on demand.
 * The key is a short hash, never the token, the Deal id or any answer. Storage access may throw (private mode): always guarded.
 */
export const LEGACY_DRAFT_KEY = "six2fit-onboarding-v5";
export const DRAFT_PREFIX = "six2fit-onboarding-draft:";
export const DRAFT_TTL_MS = 25 * 24 * 60 * 60 * 1000;

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type Draft = { a: Record<string, unknown>; ver: Record<string, string>; step: number };
type Stored = Draft & { savedAt: number };

/** Non-cryptographic 53-bit hash (cyrb53): only used to avoid readable identifiers in storage keys. */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[0] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")) : Buffer.from(b64, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Identity of the journey a draft belongs to. The payload of a signed link is readable (it is signed, not secret) and holds
 * only ids: the cycle id when present, else the Deal id, else the whole token. A re-issued link of the same cycle/Deal
 * therefore finds the draft, while a different customer's link can never see it.
 */
export function draftScope(token: string): string {
  const p = decodePayload(token);
  const cycle = p && typeof p["cycle"] === "string" ? p["cycle"] : null;
  const deal = p && typeof p["deal_id"] === "string" ? `deal:${p["deal_id"]}` : null;
  return hash(cycle ? `cycle:${cycle}` : (deal ?? `token:${token}`));
}

export const draftKey = (token: string): string => `${DRAFT_PREFIX}${draftScope(token)}`;

const isDraft = (v: unknown): v is Stored => {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return d["a"] !== null && typeof d["a"] === "object" && typeof d["step"] === "number" && typeof d["savedAt"] === "number" && d["ver"] !== null && typeof d["ver"] === "object";
};

export function loadDraft(storage: DraftStorage, token: string, nowMs: number): Draft | null {
  try {
    const raw = storage.getItem(draftKey(token));
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!isDraft(v) || nowMs - v.savedAt > DRAFT_TTL_MS || v.savedAt > nowMs + 60_000) {
      storage.removeItem(draftKey(token));
      return null;
    }
    return { a: v.a, ver: v.ver, step: v.step };
  } catch {
    return null;
  }
}

export function saveDraft(storage: DraftStorage, token: string, draft: Draft, nowMs: number): boolean {
  try {
    storage.setItem(draftKey(token), JSON.stringify({ ...draft, savedAt: nowMs } satisfies Stored));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage, token: string): void {
  try {
    storage.removeItem(draftKey(token));
  } catch {
    /* ignore */
  }
}

/** Removes the legacy global draft, expired drafts and every draft that belongs to a DIFFERENT journey. Returns how many were removed. */
export function purgeDrafts(storage: DraftStorage, currentToken: string, nowMs: number): number {
  let removed = 0;
  try {
    const current = draftKey(currentToken);
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (!k) continue;
      if (k === LEGACY_DRAFT_KEY) doomed.push(k);
      else if (k.startsWith(DRAFT_PREFIX) && k !== current) doomed.push(k);
      else if (k === current) {
        try {
          const v: unknown = JSON.parse(storage.getItem(k) ?? "null");
          if (!isDraft(v) || nowMs - v.savedAt > DRAFT_TTL_MS) doomed.push(k);
        } catch {
          doomed.push(k);
        }
      }
    }
    for (const k of doomed) {
      storage.removeItem(k);
      removed += 1;
    }
  } catch {
    /* storage unavailable: nothing to purge */
  }
  return removed;
}
