import { byIso } from "@/lib/onboarding/countries";
import { dialOf } from "../fields";
import type { ConsultationCandidate, ContactView } from "./types";

/**
 * Consultation -> Onboarding prefill (MVP). Data transfer only: it never grants or denies access.
 * Eight keys, the minimal block the Consultation backend already stores as `Onboarding_Prefill_JSON`.
 * NOT prefilled: timezone, goal, health data, consents, age, budget, service interest.
 */
export const PREFILL_KEYS = ["ON-01", "ON-03", "ON-06.iso", "ON-06.cc", "ON-06.n", "ON-07", "ON-08", "ON-09.kg"] as const;
/** Verification groups the client may confirm/edit (the part before the dot). Static: submit never repeats the lookup. */
export const PREFILL_GROUPS: ReadonlySet<string> = new Set(["ON-01", "ON-03", "ON-06", "ON-07", "ON-08", "ON-09"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const JSON_MAX = 32_000;

export type PrefillValues = Record<string, string | number>;
export type PrefillOutcome = "matched" | "none" | "ambiguous" | "not_first_cycle" | "no_purchase_time";
export type PrefillDecision = { prefill: PrefillValues; outcome: PrefillOutcome; matchedBy?: "contact" | "email" | "phone" };

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/.test(s) ? s : null;
}

/** Conservative international form `+<digits>`; `null` whenever the format is not certain (then there is no phone match). */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const d = raw.trim().replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  if (/^00[1-9]\d{7,14}$/.test(d)) return `+${d.slice(2)}`;
  if (/^09\d{9}$/.test(d)) return `+98${d.slice(1)}`;
  if (/^989\d{9}$/.test(d)) return `+${d}`;
  return null;
}

/** Validates the stored block key by key; invalid values are dropped individually. Never throws. */
export function parsePrefillJson(json: string | null | undefined): PrefillValues {
  if (typeof json !== "string" || json.length === 0 || json.length > JSON_MAX) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: PrefillValues = {};
  const name = typeof r["ON-01"] === "string" ? r["ON-01"].trim() : "";
  if (name.length > 0 && [...name].length <= 255 && !/[\u0000-\u001f]/.test(name)) out["ON-01"] = name;
  if (r["ON-03"] === "female" || r["ON-03"] === "male") out["ON-03"] = r["ON-03"];
  const email = normalizeEmail(r["ON-07"]);
  if (email) out["ON-07"] = email;
  const h = r["ON-08"];
  if (typeof h === "number" && Number.isFinite(h) && h >= 100 && h <= 250) out["ON-08"] = h;
  const w = r["ON-09.kg"];
  if (typeof w === "number" && Number.isFinite(w) && w >= 25 && w <= 350) out["ON-09.kg"] = w;
  // Contact number: the Consultation stores "+<cc><national>"; Onboarding wants the dial code and national digits separately.
  const iso = typeof r["ON-06.iso"] === "string" ? r["ON-06.iso"] : "";
  const ccRaw = typeof r["ON-06.cc"] === "string" ? r["ON-06.cc"].trim() : "";
  const cc = ccRaw === "" ? "" : ccRaw.startsWith("+") ? ccRaw : `+${ccRaw}`;
  const nRaw = typeof r["ON-06.n"] === "string" ? r["ON-06.n"].replace(/[\s\-().]/g, "") : "";
  if (byIso(iso) && /^\+\d{1,4}$/.test(cc) && dialOf(iso) === cc && /^\+?\d{7,16}$/.test(nRaw)) {
    let national = nRaw.startsWith("+") ? nRaw.slice(1) : nRaw;
    if (nRaw.startsWith("+") && national.startsWith(cc.slice(1))) national = national.slice(cc.length - 1);
    national = national.replace(/^0/, "");
    if (/^\d{7,13}$/.test(national)) {
      out["ON-06.iso"] = iso;
      out["ON-06.cc"] = cc;
      out["ON-06.n"] = national;
    }
  }
  return out;
}

export type SelectInput = {
  dealCreatedAt: string | null | undefined;
  contact: ContactView;
  candidates: readonly ConsultationCandidate[];
  /** Normalised phone -> ids of ALL Contacts that carry it (read-only lookups done by the caller). */
  phoneOwners: Readonly<Record<string, readonly string[]>>;
  windowDays: number;
  firstCycle: boolean;
};

/**
 * Pure selection rules (no I/O, no clock):
 *  - only the Deal's first onboarding cycle; only submissions created BEFORE the Deal and at most `windowDays` before it;
 *  - accept by the Contact relationship, else by e-mail without conflict, else by phone only under strict conditions;
 *  - a conflict (shared phone, different Contact, different e-mail) is never a match; names are never used;
 *  - newest accepted wins; ambiguity -> empty prefill.
 */
export function selectConsultationPrefill(i: SelectInput): PrefillDecision {
  if (!i.firstCycle) return { prefill: {}, outcome: "not_first_cycle" };
  const dealMs = Date.parse(i.dealCreatedAt ?? "");
  if (!Number.isFinite(dealMs)) return { prefill: {}, outcome: "no_purchase_time" };
  const cEmail = normalizeEmail(i.contact.email);
  const cPhones = new Set([i.contact.mobile, i.contact.phone].map(normalizePhone).filter((p): p is string => p !== null));
  const eligible = i.candidates.filter((c) => {
    const t = Date.parse(c.createdAt);
    return Number.isFinite(t) && t < dealMs && t >= dealMs - i.windowDays * DAY_MS;
  });
  let conflicts = 0;
  const accepted: { c: ConsultationCandidate; by: "contact" | "email" | "phone"; t: number }[] = [];
  for (const c of eligible) {
    const t = Date.parse(c.createdAt);
    const email = normalizeEmail(c.email);
    const phone = normalizePhone(c.whatsapp);
    const owners = phone ? (i.phoneOwners[phone] ?? []) : [];
    const phoneBelongsElsewhere = owners.length > 0 && !(owners.length === 1 && owners[0] === i.contact.id);
    if (c.contactId) {
      if (c.contactId === i.contact.id) accepted.push({ c, by: "contact", t });
      else conflicts += 1;
      continue;
    }
    if (email && cEmail && email === cEmail) {
      if (phoneBelongsElsewhere && owners.every((id) => id !== i.contact.id)) conflicts += 1;
      else accepted.push({ c, by: "email", t });
      continue;
    }
    if (!email && phone && cPhones.has(phone) && owners.length === 1 && owners[0] === i.contact.id) {
      accepted.push({ c, by: "phone", t });
      continue;
    }
    if (email && (!cEmail || email !== cEmail) && phone && cPhones.has(phone)) conflicts += 1; // shared phone, different or unverifiable e-mail
  }
  if (accepted.length === 0) return { prefill: {}, outcome: conflicts > 0 ? "ambiguous" : "none" };
  accepted.sort((a, b) => b.t - a.t);
  const best = accepted[0]!;
  if (best.by === "phone" && conflicts > 0) return { prefill: {}, outcome: "ambiguous" };
  const prefill = parsePrefillJson(best.c.prefillJson);
  return Object.keys(prefill).length === 0 ? { prefill: {}, outcome: "none" } : { prefill, outcome: "matched", matchedBy: best.by };
}
