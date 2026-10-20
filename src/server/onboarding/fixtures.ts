import { signLinkToken } from "./tokens";
import type { Scope } from "./tokens";
import type { FileInput } from "./validate";

/** Synthetic test data only: no real person, phone, e-mail or health value. */
export const SECRET = "synthetic-onboarding-secret-0123456789abcdef-xyz";
export const DEAL_ID = "6067417000123456789";
export const CONSULT_ID = "cns_12345678-1234-4234-8234-123456789012";
export const NOW_MS = Date.UTC(2026, 9, 13, 12, 0, 0);

type V = string | number | boolean | string[];

const BASE: Record<string, V> = {
  "ON-01": "Ali Rezaei",
  "ON-02": "1990-05-17",
  "ON-03": "male",
  "ON-04": "IR",
  "ON-05": "Tehran",
  "ON-06.iso": "IR",
  "ON-06.cc": "+98",
  "ON-06.n": "9121234567",
  "ON-07": "ali.rezaei@example.test",
  "ON-08": "178",
  "ON-09.kg": "82",
  "ON-11": "lose",
  "ON-12.kg": "75",
  "ON-027": "no",
  "ON-13": "moderate",
  "ON-15.wake": "06:30",
  "ON-15.sleep": "23:00",
  "ON-17": "good",
  "ON-18": 4,
  "ON-19": "no",
  "ON-20": "none",
  "NU-01": "omni",
  "NU-02": "no",
  "NU-05": "any",
  "NU-06.breakfast": "املت، تخم‌مرغ آب‌پز، نان و پنیر",
  "NU-06.lunch": "زرشک‌پلو با مرغ، آبگوشت",
  "NU-06.dinner": "املت گوجه، کتلت، سالاد",
  "NU-06.snacks": "میوه، آجیل",
  "NU-06.drinks": "چای، آب",
  "NU-08": "no",
  "NU-10": "rare",
  "NU-11": "no",
  "NU-13": "4-8",
  "NU-14": "۳ لیوان چای",
  "NU-15": ["none"],
  "NU-17": "normal",
  "NU-18": "good",
  "NU-19": ["time"],
  "NU-21": "open",
  "TR-01": "basic",
  "TR-02": "می‌توانم ۱۰ اسکوات انجام بدهم",
  "TR-03": "4",
  "TR-04": "1",
  "TR-05": "gym_full",
  "TR-07": "no",
  "TR-08": "no",
  "HL-02": ["none"],
  "HL-04": ["none"],
  "HL-05": "no",
  "HL-06": "no",
  "HL-07": ["none"],
  "HL-08": "no",
  "MS-02": "88",
  "MS-03": "98",
  "MS-04": "no",
  "MS-04.ack": true,
  "MS-07.neck": "38",
  "MS-07.shoulder": "118",
  "MS-07.chest": "100",
  "MS-07.arm_relaxed": "32",
  "MS-07.arm_flexed": "35",
  "MS-07.thigh": "58",
  "MS-07.calf": "38",
  "MS-07.wrist": "17",
  "CN-01": true,
  "CN-03": true,
};

export const raw = (v: V): string => (Array.isArray(v) ? JSON.stringify(v) : String(v));

/** A complete, valid submission (raw strings as the browser sends them) for a scope, with optional overrides (`undefined` removes a key). */
export function validAnswers(scope: Scope = "Combo", overrides: Record<string, V | undefined> = {}): Record<string, string> {
  const out: Record<string, V> = { ...BASE };
  if (scope === "Diet") for (const k of Object.keys(out)) if (k.startsWith("TR-")) delete out[k];
  if (scope === "Training") for (const k of Object.keys(out)) if (k.startsWith("NU-")) delete out[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, raw(v)]));
}

export const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
export const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 10, 0]);

export const jpegFile = (name = "front.jpg", size = 2048): FileInput & { bytes: Uint8Array } => {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_HEAD);
  return { name, type: "image/jpeg", size, head: bytes.slice(0, 16), bytes };
};

export function dealToken(over: Record<string, unknown> = {}, secret = SECRET): string {
  return signLinkToken(
    { v: 2, deal_id: DEAL_ID, jti: "link_0123456789abcdef0123", scope: "Combo", entitlements: [], exp: Math.floor(NOW_MS / 1000) + 3600, is_first_request: true, product_related_to: "Fitness and Nutrition", ...over },
    secret,
  );
}

export function consultToken(over: Record<string, unknown> = {}, secret = SECRET): string {
  return signLinkToken({ v: 1, consult_submission_id: CONSULT_ID, scope: "Combo", entitlements: [], exp: Math.floor(NOW_MS / 1000) + 3600, ...over }, secret);
}
