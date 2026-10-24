import { byIso } from "@/lib/onboarding/countries";
import { LABELS, OPTS, formatValue } from "@/lib/onboarding/data";
import type { AnswerValue } from "../validate";
import { ageOn } from "../validate";
import { KEY_PROPERTY } from "./api";

/**
 * Onboarding answers -> legacy Notion onboarding schema (rules: changes/proposed/NOTION-ONBOARDING-MAPPING-FINAL.md).
 *
 * Principles (approved):
 *  1. A legacy property is written ONLY when the new answer has an exact semantic equivalent there.
 *  2. EVERY other answer is preserved, one line each, in `S2F Supplementary Answers` (nothing is discarded, nothing is guessed).
 *  3. Property names are matched EXACTLY, including the legacy trailing/leading/double spaces; a live test compares them with the
 *     real database schema.
 * Pure: no network, no clock (the caller passes the submission time), no secrets.
 */

/** Exact legacy/new property names (note the intentional whitespace of the legacy ones). */
export const NP = {
  firstName: "نام",
  lastName: "نام خانوادگی", // title property
  age: "سن",
  birth: "تاریخ تولد میلادی",
  country: "محل سکونت - کشور",
  city: "محل سکونت - شهر",
  phone: "شماره موبایل",
  email: "ایمیل",
  height: "قد",
  weight: "وزن فعلی",
  goalWeight: "وزن هدف - دلخواه",
  gender: "جنسیت",
  mainGoal: " هدف اصلی",
  dailyActivity: "میزان فعالیت روزانه",
  terms: "T&C",
  zohoDate: "ZOHO تاریخ تکمیل فرم",
  formType: "نوع فرم",
  trainingPlace: "محل تمرین",
  homeEquipment: "وسایل در خانه",
  trainingDays: "تعداد روز ورزش/ هفته",
  trainingDuration: "مدت زمان ورزش ",
  allergy: "الرژی - حساسیت ",
  breakfast: "روتین صبحانه",
  snack: "روتین میان وعده",
  mainMeals: "روتین وعده اصلی | نهار و شام",
  water: "آب",
  supplementWish: "تمایل به استفاده مکمل",
  alcoholA: "توضیح الکل",
  alcoholB: "توضیح الکل ",
  smoking: "توضیح سیگار و دخانیات",
  pregnancy: "بارداری  و شیردهی ",
  heart: "توضیح مشکلات قلب  ؟",
  liver: "توضیح مشکلات کبدی یا اختلال در آنزیم‌های کبدی",
  lipid: "توضیح چربی خون یا کلسترول بالا",
  gi: "توضیح مشکل گوارش",
  key: KEY_PROPERTY,
  status: "S2F Sync Status",
  link: "WorkDrive Link",
  supplementary: "S2F Supplementary Answers",
} as const;

/** File answer key -> Notion `files` property (the three non-legacy ones are the additive schema). */
export const FILE_PROPERTY: Readonly<Record<string, string>> = {
  "MS-05.front": "عکس از جلو",
  "MS-05.back": "عکس از پشت",
  "MS-05.side": "عکس از پهلو - حالت خنثی",
  "MS-05.side_forward": "عکس از پهلو - دست‌ها رو به جلو",
  "MS-06.photo": "عکس ناحیه سلولیت", // D2: its own new property, NOT the legacy contracted/focused-cellulite one
  "TR-06.other_photo": "عکس وسیله (سایر)",
  "HL-09": "مدارک پزشکی ",
};

export const SYNC_STATUS = { pending: "Pending", partial: "Partial", complete: "Complete" } as const;
const RICH_TEXT_CHUNK = 2000;
const MAX_RICH_TEXT_ELEMENTS = 100;

export type NotionSubmission = {
  uniqueFormKey: string;
  scope: string;
  entitlements: readonly string[];
  answers: Readonly<Record<string, AnswerValue>>;
  submittedAt: string;
  files: ReadonlyArray<{ key: string; name: string; type: string; size: number; sha256: string }>;
  /** Deal id of the subject (used to read Product.Fitness). */
  dealId?: string | undefined;
  /** Product.Fitness from the CRM (Normal | VIP | "VIP - Cellulite"), when resolved (D1: absent = `نوع فرم` stays empty). */
  productFitness?: string | null | undefined;
  /** Private WorkDrive folder permalink (staff-only link; never a public link). */
  workdriveLink?: string | undefined;
};

export type NotionPayload = {
  properties: Record<string, unknown>;
  /** The exact `S2F Supplementary Answers` text (also in `properties`, in chunks). */
  supplementary: string;
  files: Array<{ key: string; property: string; filename: string; type: string; size: number; sha256: string }>;
  /** Answer keys fully represented by a legacy property (all others are in the supplementary text). */
  represented: string[];
};

/** Splits at code-point boundaries into <=2000-character elements; concatenating them gives back the exact text. */
export function richText(text: string): Array<{ type: "text"; text: { content: string } }> {
  const cps = Array.from(text);
  const out: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < cps.length; i += RICH_TEXT_CHUNK) out.push({ type: "text", text: { content: cps.slice(i, i + RICH_TEXT_CHUNK).join("") } });
  if (out.length > MAX_RICH_TEXT_ELEMENTS) throw new Error("NOTION_TEXT_TOO_LONG");
  return out;
}
const rt = (text: string) => ({ rich_text: richText(text) });
const title = (text: string) => ({ title: richText(text) });

const optLabel = (key: string, code: unknown): string => {
  const o = (OPTS[key] ?? []).find((x) => x[0] === code);
  return o ? o[1] : String(code);
};
const labels = (key: string, v: unknown): string => (Array.isArray(v) ? v.map((c) => optLabel(key, c)).join("، ") : optLabel(key, v));
const str = (v: AnswerValue | undefined): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const has = (v: AnswerValue | undefined, code: string): boolean => Array.isArray(v) && v.includes(code);

/**
 * D6: the REAL submission instant as ISO-8601 with milliseconds and an explicit UTC offset (`+00:00`). No historical timezone is
 * assumed; the value parses back to exactly the same instant as the source timestamp.
 */
export function legacyZohoDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error("INVALID_SUBMITTED_AT");
  return new Date(t).toISOString().replace("Z", "+00:00");
}

const labelOf = (key: string): string => {
  if (LABELS[key]) return LABELS[key];
  let m = /^NU-15\.freq\.([a-z]+)$/.exec(key);
  if (m) return `تکرار ${optLabel("NU-15", m[1])}`;
  m = /^HL-04\.([a-z]+)\.(name|dose)$/.exec(key);
  if (m) return `${optLabel("HL-04", m[1])} — ${m[2] === "name" ? "نام" : "دوز"}`;
  return key;
};

const splitName = (full: string): { first: string; last: string } => {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: "", last: parts[0] ?? "" };
  return { first: parts[0] as string, last: parts.slice(1).join(" ") };
};

const FORM_TYPE: Record<string, string> = { Normal: "Normal", VIP: "VIP", "VIP - Cellulite": "VIP Cellulite" };

export function buildNotionPayload(sub: NotionSubmission): NotionPayload {
  const a = sub.answers;
  const props: Record<string, unknown> = {};
  /** Answer keys whose content is fully and exactly represented by a legacy property. */
  const full = new Set<string>();
  const put = (name: string, value: unknown, ...keys: string[]) => {
    props[name] = value;
    for (const k of keys) full.add(k);
  };

  // --- identity (ON)
  const name = str(a["ON-01"]);
  if (name) {
    const { first, last } = splitName(name);
    if (first) props[NP.firstName] = rt(first);
    props[NP.lastName] = title(last); // title is mandatory; a single word is the last name
    full.add("ON-01");
  }
  if (str(a["ON-02"])) {
    put(NP.birth, rt(str(a["ON-02"])), "ON-02");
    const age = ageOn(str(a["ON-02"]), new Date(sub.submittedAt));
    if (Number.isFinite(age)) props[NP.age] = rt(String(age)); // derived from ON-02, which stays complete above
  }
  const country = byIso(str(a["ON-04"]));
  if (country) put(NP.country, rt(country.fa), "ON-04");
  if (str(a["ON-05"])) put(NP.city, rt(str(a["ON-05"])), "ON-05");
  if (str(a["ON-06.cc"]) && str(a["ON-06.n"])) put(NP.phone, { phone_number: `${str(a["ON-06.cc"])}${str(a["ON-06.n"])}` }, "ON-06.cc", "ON-06.n");
  if (str(a["ON-07"])) put(NP.email, { email: str(a["ON-07"]) }, "ON-07");
  if (a["ON-08"] !== undefined) put(NP.height, rt(str(a["ON-08"])), "ON-08");
  if (a["ON-09.kg"] !== undefined) put(NP.weight, rt(str(a["ON-09.kg"])), "ON-09.kg");
  if (typeof a["ON-12.kg"] === "number") put(NP.goalWeight, { number: a["ON-12.kg"] }, "ON-12.kg");
  if (a["ON-03"] === "female" || a["ON-03"] === "male") put(NP.gender, rt(a["ON-03"] === "female" ? "Female" : "Male"), "ON-03");
  if (str(a["ON-11"])) put(NP.mainGoal, rt(optLabel("ON-11", a["ON-11"])), "ON-11");
  if (str(a["ON-13"])) put(NP.dailyActivity, rt(optLabel("ON-13", a["ON-13"])), "ON-13");
  // D5: the new stress question is 0..10, the legacy `استرس` is 1..5 text: not equivalent -> supplementary only (ON-18).
  if (a["CN-03"] === true) put(NP.terms, rt("Agreed"), "CN-03");
  if (str(a["ON-19.detail"])) put(NP.smoking, rt(str(a["ON-19.detail"])), "ON-19.detail");
  if (str(a["ON-20.detail"])) {
    // The legacy database carries the alcohol note in BOTH twin properties with identical values: mirror it.
    put(NP.alcoholA, rt(str(a["ON-20.detail"])), "ON-20.detail");
    props[NP.alcoholB] = rt(str(a["ON-20.detail"]));
  }

  // --- nutrition (NU)
  if (a["NU-03"] !== undefined || a["NU-03.other"] !== undefined) {
    const parts = [a["NU-03"] !== undefined ? labels("NU-03", a["NU-03"]) : "", str(a["NU-03.other"])].filter(Boolean);
    if (parts.length) put(NP.allergy, rt(parts.join(" — ")), "NU-03", "NU-03.other");
  }
  if (str(a["NU-06.breakfast"])) put(NP.breakfast, rt(str(a["NU-06.breakfast"])), "NU-06.breakfast");
  if (str(a["NU-06.snacks"])) put(NP.snack, rt(str(a["NU-06.snacks"])), "NU-06.snacks");
  if (str(a["NU-06.lunch"]) && str(a["NU-06.dinner"])) put(NP.mainMeals, rt(`ناهار: ${str(a["NU-06.lunch"])}\nشام: ${str(a["NU-06.dinner"])}`), "NU-06.lunch", "NU-06.dinner");
  if (str(a["NU-13"])) put(NP.water, rt(optLabel("NU-13", a["NU-13"])), "NU-13");
  if (str(a["NU-21"])) put(NP.supplementWish, rt(optLabel("NU-21", a["NU-21"])), "NU-21");
  // D4: every NU-01 answer stays in the supplementary answers (the legacy diet-type select is never written).

  // --- training (TR)
  if (str(a["TR-05"])) put(NP.trainingPlace, rt(optLabel("TR-05", a["TR-05"])), "TR-05");
  if (str(a["TR-03"])) put(NP.trainingDays, rt(optLabel("TR-03", a["TR-03"])), "TR-03");
  if (str(a["TR-04"])) put(NP.trainingDuration, rt(optLabel("TR-04", a["TR-04"])), "TR-04");
  if (Array.isArray(a["TR-06"])) {
    const parts = [labels("TR-06", a["TR-06"]), str(a["TR-06.other_name"])].filter(Boolean);
    put(NP.homeEquipment, rt(parts.join(" — ")), "TR-06", "TR-06.other_name");
  }

  // --- health (HL): HL-02 is ALWAYS kept in the supplementary text too (it is only partly represented below)
  if (str(a["HL-03a"])) put(NP.pregnancy, rt(optLabel("HL-03a", a["HL-03a"])), "HL-03a");
  const hl02 = a["HL-02"];
  if (Array.isArray(hl02)) {
    if (has(hl02, "heart")) props[NP.heart] = rt("بله");
    if (has(hl02, "liver")) props[NP.liver] = rt("بله");
    if (has(hl02, "lipid")) props[NP.lipid] = rt("بله");
    if (has(hl02, "gi")) props[NP.gi] = rt("بله");
    // D3: thyroid / diabetes / insulin answers stay in HL-02 of the supplementary text; the legacy hormonal property is never written.
  }

  // --- form type (D1): ONLY from the Product.Fitness read from the CRM (Normal | VIP | "VIP - Cellulite"); never inferred from the
  // scope or the entitlements; absent or unknown = left empty (nutrition-only products have no value).
  const formType = sub.productFitness ? FORM_TYPE[sub.productFitness] : undefined;
  if (formType) props[NP.formType] = { select: { name: formType } };

  props[NP.zohoDate] = rt(legacyZohoDate(sub.submittedAt));
  props[NP.key] = rt(sub.uniqueFormKey);
  props[NP.status] = { select: { name: SYNC_STATUS.pending } };
  if (sub.workdriveLink) props[NP.link] = { url: sub.workdriveLink };

  // --- supplementary: every answer that is not fully represented above, in key order, one line each.
  const fileKeys = new Set(Object.keys(FILE_PROPERTY));
  const lines = [`[S2F] form=onboarding scope=${sub.scope} entitlements=${sub.entitlements.join(",") || "-"} submitted_at=${sub.submittedAt}`];
  for (const key of Object.keys(a).sort()) {
    if (full.has(key) || fileKeys.has(key) || key.startsWith("__")) continue;
    const v = a[key] as AnswerValue;
    lines.push(`${key} | ${labelOf(key)}: ${formatValue(key, v)}`);
  }
  // The full name is kept verbatim as well (the first/last split above is a presentation choice, not a loss).
  if (name) lines.splice(1, 0, `ON-01 | ${LABELS["ON-01"]}: ${name}`);
  const supplementary = lines.join("\n");
  props[NP.supplementary] = rt(supplementary);

  const files = sub.files.flatMap((f) => {
    const property = FILE_PROPERTY[f.key];
    if (!property) return [];
    const ext = f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : "jpg";
    return [{ key: f.key, property, filename: `${f.key.replace(/[^A-Za-z0-9_.-]/g, "_")}-${f.sha256.slice(0, 8)}.${ext}`, type: f.type, size: f.size, sha256: f.sha256 }];
  });
  return { properties: props, supplementary, files, represented: [...full].sort() };
}
