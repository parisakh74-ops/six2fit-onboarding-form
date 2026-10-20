import { canonicalJson, fingerprint } from "../canonical";
import { StoreError } from "../errors";
import type { StoredRef, SubmissionRecord } from "../ports";
import { docRefFieldProblem } from "./config";
import { FIELD_DISPOSITION } from "./field-disposition";

/**
 * Mapping of a validated Onboarding submission to a Zoho CRM `Requests` record.
 *
 * Source of truth for completeness: the COMPLETE answers are written as canonical JSON to the configured large-text
 * field (the Requests module has no such field today: schema decision, section 41 of the change plan). The mapped
 * structured fields are derived, reportable copies of answers whose Requests field is an UNAMBIGUOUS match
 * (verified API names, types and picklist ACTUAL values in `requests-schema.snapshot.json`). Everything else
 * (date of birth, city, WhatsApp number, consents, nutrition and health detail, photos) lives only in the raw JSON until the PM
 * approves per-field targets. Candidate-but-ambiguous mappings are listed in `UNMAPPED_CANDIDATES` and are NOT written.
 *
 * Zoho picklists take the ACTUAL value, which can differ from the label (e.g. label "Sedentary" is `Option 1`): never use labels.
 */
export type RequestsRecord = Record<string, unknown>;

const SEX: Record<string, string> = { male: "Male", female: "Female" };
const ACTIVITY: Record<string, string> = { sedentary: "Option 1", light: "Option 2", moderate: "Option 3", high: "Very Active" };
const GOAL: Record<string, string> = { lose: "Weight Reduction", muscle: "Muscle Gain" };
const LOCATION: Record<string, string> = { home: "Home or Home Gym", homegym: "Home or Home Gym", gym_full: "Full Gym" };
const MEASURES: Record<string, string> = {
  "MS-02": "Abdomen_circumference",
  "MS-03": "Hip_circumference",
  "MS-07.neck": "Neck_circumference",
  "MS-07.shoulder": "Shoulder_Width",
  "MS-07.chest": "Chest_circumference",
  "MS-07.arm_flexed": "Flexed_Arm_circumference",
  "MS-07.thigh": "Thigh_circumference",
  "MS-07.calf": "Calf_circumference",
  "MS-07.wrist": "Wrist_circumference",
};

/**
 * Answers whose structured target is undecided (ambiguous, wrong-twin risk, differing codes). They are NOT written to a
 * structured field; they stay complete in the raw snapshot. Derived from `FIELD_DISPOSITION` (single source of truth).
 */
export const UNMAPPED_CANDIDATES: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_DISPOSITION)
    .filter(([, v]) => v.d === "decision")
    .map(([k, v]) => [k, `${v.target ?? "no target"}${v.note ? `: ${v.note}` : ""}`]),
);

export const REQUEST_FIELD_LENGTH = { Email: 100, Product_Related_To: 255, uniqueformkey: 255 } as const;

const iso = (s: string): string => s.replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");

/** The complete, canonical answers document (what is stored in the raw field and what the fingerprint covers). */
export function rawDocument(r: SubmissionRecord): Record<string, unknown> {
  return {
    v: 1,
    form: "onboarding",
    subject: r.subject,
    link_id: r.link_id,
    scope: r.scope,
    entitlements: r.entitlements,
    answers: r.answers,
    verification_state: r.verification_state,
    files: r.files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: f.sha256, ...(f.ref ? { ref: f.ref } : {}) })),
    submitted_at: r.submitted_at,
    fingerprint: r.fingerprint,
  };
}

/** Initial status of every Request created by this integration (picklist ACTUAL value; present in Sandbox and Production). */
export const INITIAL_REQUEST_STATUS = "Prospecting";
/** Version of the answer catalogue / raw document layout (raw document field `v`). */
export const ONBOARDING_FORM_VERSION = "onboarding-1";

// Deterministic value guards: a value that does not fit its target is OMITTED from the structured field (it always
// remains in the raw snapshot); the adapter never truncates, coerces or throws for a structured copy.
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const fit = (max: number) => (v: unknown): string | undefined => {
  const t = str(v);
  return t !== undefined && [...t].length <= max ? t : undefined;
};
const t255 = fit(255);
const tLong = fit(32_000);
const yn = (v: unknown): boolean | undefined => (v === "yes" ? true : v === "no" ? false : undefined);
const scale010 = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10 ? v : undefined);
const isoDay = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const hhmm = (v: unknown): string | undefined => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);
const codes = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

const WD_FILE_ID = /^[A-Za-z0-9]{20,64}$/;
const refError = (code: "DOCUMENT_REF_MISSING" | "DOCUMENT_REF_INVALID" | "DOC_REF_FIELD_CONFLICT" | "DOC_REF_FIELD_INVALID", message: string): never => {
  const e = new StoreError("REJECTED", message, code);
  e.notWritten = true; // nothing was sent to the CRM
  throw e;
};

/**
 * The private WorkDrive permalink of the canonical document: exactly `https://workdrive.zoho.com/file/<resource_id>`.
 * Accepts the internal reference `wd:<resource_id>` or the permalink itself. Anything else is refused BEFORE a CRM payload
 * exists: no query string (sharing keys, tokens), no fragment (fingerprints), no credentials, no other host, no port.
 * The permalink alone grants no access (WorkDrive requires sign-in and folder membership).
 */
export function documentPermalink(ref: unknown): string {
  if (typeof ref !== "string" || ref.trim() === "") return refError("DOCUMENT_REF_MISSING", "document reference is missing");
  const wd = /^wd:([A-Za-z0-9]+)$/.exec(ref);
  if (wd) return WD_FILE_ID.test(wd[1] as string) ? `https://workdrive.zoho.com/file/${wd[1] as string}` : refError("DOCUMENT_REF_INVALID", "document reference is not valid");
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return refError("DOCUMENT_REF_INVALID", "document reference is not valid");
  }
  const m = /^\/file\/([A-Za-z0-9]+)$/.exec(u.pathname);
  const clean = u.protocol === "https:" && u.hostname === "workdrive.zoho.com" && u.port === "" && u.username === "" && u.password === "" && u.search === "" && u.hash === "";
  if (!clean || !m || !WD_FILE_ID.test(m[1] as string) || ref !== `https://workdrive.zoho.com/file/${m[1] as string}`) return refError("DOCUMENT_REF_INVALID", "document reference is not valid");
  return ref;
}

/** Structured targets this adapter writes: the reference field must never collide with one. */
const MAPPED_TARGETS: ReadonlySet<string> = new Set([
  ...Object.values(FIELD_DISPOSITION).map((v) => v.target).filter((t): t is string => typeof t === "string"),
  ...Object.values(MEASURES),
  "Email", "Sex", "Height_cm", "Current_Weight_Kg", "Goal_Weight", "Goal", "Daily_Activities1", "Smoke", "Alcohol1", "Workout_Location",
]);

export function buildRequestsRecord(
  r: SubmissionRecord,
  opts: { persistence?: "raw-field" | "workdrive-ref" | "workdrive-key"; rawField?: string | undefined; docRefField?: string | undefined; maxRawChars: number; setNewRecordFlag: boolean },
): { record: RequestsRecord; rawChars: number } {
  const persistence = opts.persistence ?? "raw-field";
  // Validated BEFORE any payload is built: a bad configuration or reference can never reach the CRM.
  let permalink: string | undefined;
  if (persistence === "workdrive-ref") {
    const f = opts.docRefField;
    if (typeof f !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(f)) return refError("DOC_REF_FIELD_INVALID", "document reference field is not configured");
    if (docRefFieldProblem(f) !== null || MAPPED_TARGETS.has(f)) return refError("DOC_REF_FIELD_CONFLICT", "document reference field collides with a mapped or reserved field");
    permalink = documentPermalink(r.document_ref);
  }
  // Zoho Requests are always Deal-linked in the current process; a Consultation-bound link has no Deal.
  if (r.subject.kind !== "deal") {
    const e = new StoreError("REJECTED", "link type cannot be stored in CRM", "SUBJECT_NOT_ELIGIBLE");
    e.notWritten = true;
    throw e;
  }
  const raw = persistence === "raw-field" ? canonicalJson(rawDocument(r)) : "";
  const rawChars = [...raw].length;
  if (persistence === "raw-field" && rawChars > opts.maxRawChars) {
    const e = new StoreError("TOO_LARGE", "complete answers exceed the CRM field capacity", "RAW_TOO_LARGE");
    e.notWritten = true;
    throw e;
  }
  const a = r.answers;
  const rec: RequestsRecord = {
    uniqueformkey: r.unique_form_key,
    Deal: { id: r.subject.dealId },
    Form_Complete: true,
    Form_Completion_Date: iso(r.submitted_at),
    Request_Status: INITIAL_REQUEST_STATUS,
    Submission_Id: r.subject_key,
    Form_Version: ONBOARDING_FORM_VERSION,
    Submitted_At: iso(r.submitted_at),
    Onboarding_Scope: r.scope,
  };
  if (persistence === "raw-field") {
    if (typeof opts.rawField !== "string") return refError("DOC_REF_FIELD_INVALID", "complete-answers field is not configured");
    rec[opts.rawField] = raw;
  } else if (permalink !== undefined && typeof opts.docRefField === "string") {
    if (opts.docRefField in rec) return refError("DOC_REF_FIELD_CONFLICT", "document reference field collides with a mapped or reserved field");
    rec[opts.docRefField] = permalink; // the ONLY reference to the document: no answers, no fingerprint, no file names
  }
  if (opts.setNewRecordFlag) rec["Is_New_Record_Created"] = true;
  if (r.is_first_request !== undefined) rec["Is_First_Request"] = r.is_first_request ? "True" : "False";
  if (r.product_related_to) rec["Product_Related_To"] = r.product_related_to;

  const set = (field: string, v: unknown) => {
    if (v !== undefined) rec[field] = v;
  };
  set("Email", a["ON-07"]);
  set("Sex", SEX[a["ON-03"] as string]);
  set("Height_cm", a["ON-08"]);
  set("Current_Weight_Kg", a["ON-09.kg"]);
  set("Goal_Weight", a["ON-12.kg"]);
  set("Goal", GOAL[a["ON-11"] as string]);
  set("Daily_Activities1", ACTIVITY[a["ON-13"] as string]);
  if (a["ON-19"] === "yes" || a["ON-19"] === "no") rec["Smoke"] = a["ON-19"] === "yes";
  if (typeof a["ON-20"] === "string") rec["Alcohol1"] = a["ON-20"] !== "none";
  set("Workout_Location", LOCATION[a["TR-05"] as string]);
  for (const [k, field] of Object.entries(MEASURES)) set(field, a[k]);

  // --- Sandbox-verified structured copies (types, lengths and meaning checked against the CA Dev Requests metadata).
  set("Date_of_Birth", isoDay(a["ON-02"]));
  set("Country_of_Residence", t255(a["ON-04"]));
  set("City_of_Residence", t255(a["ON-05"]));
  const cc = a["ON-06.cc"];
  const nn = a["ON-06.n"];
  if (typeof cc === "string" && /^\+\d{1,4}$/.test(cc) && typeof nn === "string" && /^\d{4,15}$/.test(nn)) set("Phone", t255(cc + nn));
  set("Sleep_Quality", t255(a["ON-17"]));
  set("Stress_Level_0_10", scale010(a["ON-18"]));
  set("Menstrual_Status", t255(a["ON-21"]));
  set("Pregnancy_Breastfeeding_Status", t255(a["HL-03a"]));
  set("Breastfeeding_Age_Range", t255(a["HL-03b"]));
  set("Weight_Loss_Medication_Status", t255(a["HL-06"]));
  set("Weight_Loss_Medication_Details", t255(a["HL-06.name"]));
  set("Pain_Intensity_0_10", scale010(a["TR-08.severity"]));
  // consent: only an explicit TRUE answer is recorded, with the submission time (no consent is ever inferred)
  const stamp = iso(r.submitted_at);
  if (a["CN-01"] === true) { rec["Information_Accuracy_Confirmed"] = true; rec["Information_Accuracy_At"] = stamp; }
  if (a["CN-02"] === true) { rec["Health_Data_Consent"] = true; rec["Health_Consent_At"] = stamp; }
  if (a["CN-03"] === true) { rec["Terms_Accepted"] = true; rec["Terms_Accepted_At"] = stamp; }
  if (a["MS-04"] === "no") rec["Body_Photo_Declined"] = true;
  if (a["MS-04.ack"] === true) rec["Body_Photo_Decline_Acknowledged"] = true;
  // nutrition
  const diet = str(a["NU-01"]);
  if (diet !== undefined) set("Dietary_Pattern", t255(diet === "other" && str(a["NU-01.other"]) ? `other: ${a["NU-01.other"] as string}` : diet));
  set("Severe_Food_Reaction", yn(a["NU-02"]));
  const allergies = codes(a["NU-03"]);
  if (allergies) set("Food_Allergy_Intolerance", tLong([...allergies, ...(str(a["NU-03.other"]) ? [`other: ${a["NU-03.other"] as string}`] : [])].join(", ")));
  set("Food_Dislikes", tLong(a["NU-04"]));
  set("Meal_Routine_Breakfast", tLong(a["NU-06.breakfast"]));
  set("Meal_Routine_Lunch", tLong(a["NU-06.lunch"]));
  set("Meal_Routine_Dinner", tLong(a["NU-06.dinner"]));
  set("Meal_Routine_Snacks", tLong(a["NU-06.snacks"]));
  set("Meal_Routine_Drinks", tLong(a["NU-06.drinks"]));
  set("Fasting_Status", t255(a["NU-08"]));
  const eatFrom = hhmm(a["NU-08.start"]);
  const eatTo = hhmm(a["NU-08.end"]);
  if (eatFrom && eatTo) set("Fasting_Eating_Window", `${eatFrom}-${eatTo}`);
  set("Restaurant_Frequency", t255(a["NU-10"]));
  set("Has_Diet_History", yn(a["NU-11"]));
  set("Diet_History_Results", tLong(a["NU-11.detail"]));
  set("Daily_Water_Glasses", t255(a["NU-13"]));
  set("Caffeine_Details", tLong(a["NU-14"]));
  const symptoms = codes(a["NU-15"])?.filter((x) => x !== "none");
  if (symptoms && symptoms.length > 0) {
    const frequency: Record<string, unknown> = {};
    for (const sym of symptoms) if (typeof a[`NU-15.freq.${sym}`] === "string") frequency[sym] = a[`NU-15.freq.${sym}`];
    set("GI_Symptoms_JSON", tLong(canonicalJson({ symptoms, frequency })));
  }
  set("GI_Food_Triggers", tLong(a["NU-16"]));
  set("Appetite_Level", t255(a["NU-17"]));
  set("Eating_Control", t255(a["NU-18"]));
  const barriers = codes(a["NU-19"]);
  if (barriers) set("Diet_Barriers", tLong(barriers.join(", ")));
  set("Supplement_Preference", t255(a["NU-21"]));
  set("Nutrition_Notes", tLong(a["NU-22"]));
  return { record: rec, rawChars };
}

/** Parses the stored raw document of an existing Request and verifies its integrity (fingerprint over the answers). */
export function parseStoredRequest(item: unknown, rawField: string): StoredRef {
  const corrupt = (code: string): never => {
    throw new StoreError("CORRUPT", "stored request is not readable", code);
  };
  if (item === null || typeof item !== "object") return corrupt("INVALID_RESPONSE");
  const rec = item as Record<string, unknown>;
  const rawText = rec[rawField];
  if (typeof rawText !== "string") return corrupt("RAW_MISSING");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return corrupt("RAW_INVALID");
  }
  const fp = doc["fingerprint"];
  const subject = doc["subject"];
  if (typeof fp !== "string" || !subject) return corrupt("RAW_INVALID");
  // The fingerprint is over {subject, scope, entitlements, answers, verification_state, files(key,sha256,size,type)}.
  const files = (Array.isArray(doc["files"]) ? doc["files"] : []) as Array<Record<string, unknown>>;
  const recomputed = fingerprint({
    subject,
    scope: doc["scope"],
    entitlements: doc["entitlements"],
    answers: doc["answers"],
    verification_state: doc["verification_state"],
    files: files.map((f) => ({ key: f["key"], sha256: f["sha256"], size: f["size"], type: f["type"] })),
  });
  if (recomputed !== fp) return corrupt("RAW_TAMPERED");
  const id = typeof rec["id"] === "string" ? rec["id"] : undefined;
  return { fingerprint: fp, submitted_at: String(doc["submitted_at"] ?? ""), ...(id ? { record_ref: id } : {}) };
}

/** Reads the private permalink back from a stored Request (WorkDrive-reference mode). It is validated again: a hand-edited value is CORRUPT. */
export function parseDocumentReference(item: unknown, docRefField: string): string {
  const corrupt = (code: string): never => {
    throw new StoreError("CORRUPT", "stored request is not readable", code);
  };
  if (item === null || typeof item !== "object") return corrupt("INVALID_RESPONSE");
  const v = (item as Record<string, unknown>)[docRefField];
  if (typeof v !== "string" || v.trim() === "") return corrupt("DOCUMENT_REF_MISSING");
  try {
    return documentPermalink(v);
  } catch {
    return corrupt("DOCUMENT_REF_INVALID");
  }
}
