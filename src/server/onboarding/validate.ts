import { isActive, toEn, hasNutrition, hasTraining, healthAnswered, type Answers, type Scope } from "@/lib/onboarding/data";
import { byIso } from "@/lib/onboarding/countries";
import { FILE_KEYS, MAX_FILE_BYTES, EMAIL_MAX, dialOf, isFileKey, specFor, type FieldSpec } from "./fields";

/**
 * Server-side validation of an Onboarding submission. The browser is never trusted: every key must be catalogued,
 * typed, active under the conditional-question rules of the form (`isActive`, shared with the frontend), complete for
 * the scope the signed link grants, and its files must really be JPEG/PNG/PDF within the size limit.
 * Issues carry the field path and a code only; answers are never echoed.
 */
export type Issue = { path: string; code: string };
export type AnswerValue = string | number | boolean | string[];
export type FileInput = { name: string; type: string; size: number; head: Uint8Array };
export type AcceptedFile = { key: string; name: string; type: string; size: number };
export type Validated = { ok: true; answers: Record<string, AnswerValue>; files: AcceptedFile[] } | { ok: false; issues: Issue[] };

const MAX_KEYS = 400;

const fold = (s: string): string => s.normalize("NFC");
const cpLen = (s: string): number => [...s].length;
// eslint-disable-next-line no-control-regex
const BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function ageOn(iso: string, now: Date): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > dim) return NaN;
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age -= 1;
  return age;
}

export const normalizePhoneDigits = (v: string): string => toEn(v).replace(/[\s-]/g, "").replace(/^0/, "");

/** Magic-byte check: the declared type must match the real content. */
export function sniffMime(head: Uint8Array): "image/jpeg" | "image/png" | "application/pdf" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) return "application/pdf";
  return null;
}

function parseValue(key: string, raw: string, spec: FieldSpec, now: Date): { value?: AnswerValue; issue?: string } {
  switch (spec.t) {
    case "enum":
      return spec.opts.includes(raw) ? { value: raw } : { issue: "INVALID_OPTION" };
    case "multi": {
      let arr: unknown;
      try {
        arr = JSON.parse(raw);
      } catch {
        return { issue: "INVALID_TYPE" };
      }
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) return { issue: "INVALID_TYPE" };
      const list = arr as string[];
      if (list.length === 0) return { issue: "EMPTY" };
      if (new Set(list).size !== list.length || list.some((x) => !spec.opts.includes(x))) return { issue: "INVALID_OPTION" };
      if (list.includes("none") && list.length > 1) return { issue: "INVALID_OPTION" };
      if (spec.max && list.length > spec.max) return { issue: "TOO_MANY" };
      return { value: list };
    }
    case "text": {
      const s = fold(raw).trim();
      if (BAD_CONTROL.test(s)) return { issue: "INVALID_CHARACTERS" };
      if (s === "") return { issue: "EMPTY" };
      if (cpLen(s) > spec.max) return { issue: "TOO_LONG" };
      return { value: s };
    }
    case "num": {
      const s = toEn(raw);
      if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return { issue: "INVALID_NUMBER" };
      const n = Number(s);
      return n >= spec.min && n <= spec.max ? { value: n } : { issue: "OUT_OF_RANGE" };
    }
    case "scale": {
      const s = toEn(raw);
      if (!/^\d{1,2}$/.test(s)) return { issue: "INVALID_NUMBER" };
      const n = Number(s);
      return n >= 0 && n <= 10 ? { value: n } : { issue: "OUT_OF_RANGE" };
    }
    case "date": {
      const s = toEn(raw);
      const age = ageOn(s, now);
      if (Number.isNaN(age)) return { issue: "INVALID_DATE" };
      return age >= 14 && age <= 100 ? { value: s } : { issue: "OUT_OF_RANGE" };
    }
    case "time": {
      const s = toEn(raw);
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? { value: s } : { issue: "INVALID_TIME" };
    }
    case "email": {
      const s = toEn(raw);
      if (s.length > EMAIL_MAX) return { issue: "TOO_LONG" };
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? { value: s } : { issue: "INVALID_EMAIL" };
    }
    case "phone": {
      const s = normalizePhoneDigits(raw);
      return /^\d{7,13}$/.test(s) ? { value: s } : { issue: "INVALID_PHONE" };
    }
    case "country":
      return byIso(raw) ? { value: raw } : { issue: "INVALID_OPTION" };
    case "dial":
      return /^\+\d{1,4}$/.test(raw) ? { value: raw } : { issue: "INVALID_OPTION" };
    case "true":
      return raw === "true" ? { value: true } : { issue: "INVALID_TYPE" };
    case "file":
      return { issue: "FILE_AS_ANSWER" };
  }
  void key;
}

type Check = { k: string; req?: boolean };

/** Required answers per step, mirroring `STEPS[*].checks` of the frontend (type checks are done by `specFor`). */
function requiredChecks(a: Answers, scope: Scope): Check[] {
  const c: Check[] = [];
  const need = (...keys: string[]) => keys.forEach((k) => c.push({ k, req: true }));
  // personal
  need("ON-01", "ON-02", "ON-03", "ON-04", "ON-06.n", "ON-06.cc", "ON-07", "ON-08", "ON-09.kg", "ON-11", "ON-027");
  if (!a["ON-12.unsure"]) need("ON-12.kg");
  // lifestyle
  need("ON-13", "ON-15.wake", "ON-15.sleep", "ON-17", "ON-18", "ON-19.detail", "ON-20.detail");
  if (hasNutrition(scope)) {
    need("NU-01", "NU-01.other", "NU-02", "NU-03", "NU-03.other", "NU-05", "NU-06.breakfast", "NU-06.lunch", "NU-06.dinner", "NU-06.snacks", "NU-06.drinks");
    need("NU-08", "NU-08.start", "NU-08.end", "NU-10", "NU-11", "NU-11.detail", "NU-13", "NU-14", "NU-15");
    for (const s of ((a["NU-15"] ?? []) as string[]).filter((x) => x !== "none")) need(`NU-15.freq.${s}`);
    need("NU-17", "NU-18", "NU-19", "NU-21");
  }
  if (hasTraining(scope)) {
    need("TR-01", "TR-02", "TR-03", "TR-04", "TR-05", "TR-06", "TR-07", "TR-07.location", "TR-07.type", "TR-07.clinician");
    need("TR-08", "TR-08.location", "TR-08.severity", "TR-08.onset", "TR-08.effect");
  }
  // health
  need("HL-02", "HL-03a", "ON-10", "HL-03b", "HL-04");
  for (const m of ((a["HL-04"] ?? []) as string[]).filter((x) => x !== "none")) need(`HL-04.${m}.name`, `HL-04.${m}.dose`);
  need("HL-05", "HL-05.name", "HL-05.dose", "HL-05.time", "HL-05.reason", "HL-06", "HL-07", "HL-08", "HL-08.type", "HL-08.area", "HL-08.when");
  // measures
  need("MS-02", "MS-03");
  const photoKeys = ["MS-05.front", "MS-05.back", "MS-05.side", "MS-05.side_forward"];
  if (!photoKeys.some((k) => a[k])) need("MS-04");
  need("MS-04.ack", "MS-07.neck", "MS-07.shoulder", "MS-07.chest", "MS-07.arm_relaxed", "MS-07.arm_flexed", "MS-07.thigh", "MS-07.calf", "MS-07.wrist");
  // consent
  need("CN-01", "CN-02", "CN-03");
  return c;
}

export function validateSubmission(
  rawAnswers: Record<string, string>,
  files: Record<string, FileInput>,
  ctx: { scope: Scope; entitlements: readonly string[]; now?: Date },
): Validated {
  const now = ctx.now ?? new Date();
  const issues: Issue[] = [];
  const typed = Object.create(null) as Record<string, AnswerValue>;

  const keys = Object.keys(rawAnswers);
  if (keys.length + Object.keys(files).length > MAX_KEYS) return { ok: false, issues: [{ path: "", code: "TOO_MANY_FIELDS" }] };

  for (const key of keys) {
    if (key.startsWith("__")) {
      issues.push({ path: key, code: "UNKNOWN_FIELD" });
      continue;
    }
    if (isFileKey(key)) {
      issues.push({ path: key, code: "FILE_AS_ANSWER" });
      continue;
    }
    const spec = specFor(key);
    if (!spec) {
      issues.push({ path: key.slice(0, 60), code: "UNKNOWN_FIELD" });
      continue;
    }
    const raw = rawAnswers[key];
    if (typeof raw !== "string") {
      issues.push({ path: key, code: "INVALID_TYPE" });
      continue;
    }
    const r = parseValue(key, raw, spec, now);
    if (r.issue) issues.push({ path: key, code: r.issue });
    else if (r.value !== undefined) typed[key] = r.value;
  }

  const accepted: AcceptedFile[] = [];
  for (const [key, f] of Object.entries(files)) {
    const allowed = Object.hasOwn(FILE_KEYS, key) ? FILE_KEYS[key] : undefined;
    if (!allowed) {
      issues.push({ path: key.slice(0, 60), code: "UNKNOWN_FIELD" });
      continue;
    }
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_FILE_BYTES) {
      issues.push({ path: key, code: "FILE_TOO_LARGE" });
      continue;
    }
    const real = sniffMime(f.head);
    if (!real || !allowed.includes(real) || f.type !== real) {
      issues.push({ path: key, code: "FILE_TYPE" });
      continue;
    }
    accepted.push({ key, name: fold(f.name).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file", type: real, size: f.size });
  }

  // Cross-field consistency of the phone country.
  if (typed["ON-06.iso"] && typed["ON-06.cc"] && dialOf(typed["ON-06.iso"] as string) !== typed["ON-06.cc"]) {
    issues.push({ path: "ON-06.cc", code: "INCONSISTENT" });
  }

  // Conditional-field integrity: a present key must be active for this scope and these answers.
  const ctxAnswers: Answers = { ...typed, __entitlements: [...ctx.entitlements] };
  for (const f of accepted) ctxAnswers[f.key] = true;
  for (const key of [...Object.keys(typed), ...accepted.map((f) => f.key)]) {
    if (!isActive(key, ctxAnswers, ctx.scope)) issues.push({ path: key, code: "INACTIVE_FIELD" });
  }
  if (typed["ON-12.kg"] !== undefined && typed["ON-12.unsure"] === true) issues.push({ path: "ON-12.kg", code: "INCONSISTENT" });

  // Completeness for the granted scope.
  const seen = new Set(issues.map((i) => i.path));
  for (const c of requiredChecks(ctxAnswers, ctx.scope)) {
    if (!isActive(c.k, ctxAnswers, ctx.scope)) continue;
    if (c.req && ctxAnswers[c.k] === undefined && !seen.has(c.k)) {
      issues.push({ path: c.k, code: "REQUIRED" });
      seen.add(c.k);
    }
  }
  // Consent that the form requires only when health answers exist: CN-02 follows `healthAnswered`.
  void healthAnswered;

  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 100) };
  return { ok: true, answers: typed, files: accepted };
}
