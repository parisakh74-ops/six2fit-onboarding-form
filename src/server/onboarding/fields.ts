import { byIso } from "@/lib/onboarding/countries";
import { OPTS } from "@/lib/onboarding/data";

/**
 * Catalogue of every answer key the Onboarding form can send, with its server-side type. Derived from the existing
 * frontend question definitions (`src/lib/onboarding/data.ts`, `src/components/onboarding/steps.tsx`); the server never
 * accepts a key that is not listed here (no mass assignment) and never coerces types implicitly.
 */
export type FieldSpec =
  | { t: "enum"; opts: readonly string[] }
  | { t: "multi"; opts: readonly string[]; max?: number }
  | { t: "text"; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "scale" }
  | { t: "date" }
  | { t: "time" }
  | { t: "email" }
  | { t: "phone" }
  | { t: "country" }
  | { t: "dial" }
  | { t: "true" }
  | { t: "file"; types: readonly string[] };

export const TEXT_MAX = 255;
export const LONGTEXT_MAX = 2000;
export const EMAIL_MAX = 100;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const optValues = (k: string): string[] => (OPTS[k] ?? []).map((o) => o[0]);
const IMG = ["image/jpeg", "image/png"] as const;

export const FILE_KEYS: Record<string, readonly string[]> = {
  "TR-06.other_photo": IMG,
  "HL-09": ["application/pdf", ...IMG],
  "MS-05.front": IMG,
  "MS-05.back": IMG,
  "MS-05.side": IMG,
  "MS-05.side_forward": IMG,
  "MS-06.photo": IMG,
};

const ENUM_KEYS = [
  "ON-03", "ON-11", "ON-027", "ON-13", "ON-17", "ON-19", "ON-20", "ON-21",
  "NU-01", "NU-02", "NU-05", "NU-08", "NU-10", "NU-11", "NU-13", "NU-17", "NU-18", "NU-21",
  "TR-01", "TR-03", "TR-04", "TR-05", "TR-07", "TR-08",
  "HL-03a", "HL-03b", "HL-05", "HL-06", "HL-08", "MS-04",
];
const MULTI_KEYS: Record<string, { max?: number }> = {
  "NU-03": {}, "NU-15": {}, "NU-19": { max: 3 }, "TR-06": {}, "HL-02": {}, "HL-04": {}, "HL-07": {},
};
const NUM_KEYS: Record<string, [number, number]> = {
  "ON-08": [100, 250], "ON-09.kg": [25, 350], "ON-10": [25, 350], "ON-12.kg": [25, 350], "MS-02": [40, 250], "MS-03": [40, 250],
  "MS-07.neck": [5, 200], "MS-07.shoulder": [5, 200], "MS-07.chest": [5, 200], "MS-07.arm_relaxed": [5, 200],
  "MS-07.arm_flexed": [5, 200], "MS-07.thigh": [5, 200], "MS-07.calf": [5, 200], "MS-07.wrist": [5, 200],
};
const TRUE_KEYS = ["ON-12.unsure", "MS-04.ack", "MS-06.consent", "CN-01", "CN-02", "CN-03"];
const TIME_KEYS = ["ON-15.wake", "ON-15.sleep", "NU-08.start", "NU-08.end"];
const LONGTEXT_KEYS = [
  "NU-04", "NU-06.breakfast", "NU-06.lunch", "NU-06.dinner", "NU-06.snacks", "NU-06.drinks", "NU-11.detail", "NU-16", "NU-22",
  "TR-07.clinician", "TR-08.effect", "TR-09", "ON-21.note",
];
const TEXT_KEYS = [
  "ON-01", "ON-05", "ON-027.name", "ON-19.detail", "ON-20.detail", "NU-01.other", "NU-03.other", "NU-14", "TR-02",
  "TR-06.other_name", "TR-07.location", "TR-07.type", "TR-08.location", "TR-08.onset",
  "HL-05.name", "HL-05.dose", "HL-05.time", "HL-05.reason", "HL-06.name", "HL-08.type", "HL-08.area", "HL-08.when",
];

const FIXED: Record<string, FieldSpec> = (() => {
  const m: Record<string, FieldSpec> = {};
  for (const k of ENUM_KEYS) m[k] = { t: "enum", opts: optValues(k) };
  for (const [k, v] of Object.entries(MULTI_KEYS)) m[k] = { t: "multi", opts: optValues(k), ...(v.max ? { max: v.max } : {}) };
  for (const [k, [min, max]] of Object.entries(NUM_KEYS)) m[k] = { t: "num", min, max };
  for (const k of TRUE_KEYS) m[k] = { t: "true" };
  for (const k of TIME_KEYS) m[k] = { t: "time" };
  for (const k of LONGTEXT_KEYS) m[k] = { t: "text", max: LONGTEXT_MAX };
  for (const k of TEXT_KEYS) m[k] = { t: "text", max: TEXT_MAX };
  for (const [k, types] of Object.entries(FILE_KEYS)) m[k] = { t: "file", types };
  m["ON-02"] = { t: "date" };
  m["ON-04"] = { t: "country" };
  m["ON-06.iso"] = { t: "country" };
  m["ON-06.cc"] = { t: "dial" };
  m["ON-06.n"] = { t: "phone" };
  m["ON-027.phone"] = { t: "phone" };
  m["ON-07"] = { t: "email" };
  m["ON-18"] = { t: "scale" };
  m["TR-08.severity"] = { t: "scale" };
  return m;
})();

/** Specification of an answer key, or `undefined` when the key is not part of the form (reject). */
export function specFor(key: string): FieldSpec | undefined {
  const fixed = FIXED[key];
  if (fixed) return fixed;
  let m = /^NU-15\.freq\.([a-z]+)$/.exec(key);
  if (m && m[1] !== "none" && optValues("NU-15").includes(m[1] as string)) return { t: "enum", opts: optValues("NU-15.freq") };
  m = /^HL-04\.([a-z]+)\.(name|dose)$/.exec(key);
  if (m && m[1] !== "none" && optValues("HL-04").includes(m[1] as string)) return { t: "text", max: TEXT_MAX };
  return undefined;
}

export const isFileKey = (key: string): boolean => key in FILE_KEYS;

/** ISO country -> dial prefix as sent by the form (`+98`). */
export const dialOf = (iso: string): string | undefined => {
  const c = byIso(iso);
  return c ? `+${c.dial}` : undefined;
};
