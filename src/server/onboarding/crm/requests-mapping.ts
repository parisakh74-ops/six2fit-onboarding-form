import { canonicalJson, fingerprint } from "../canonical";
import { StoreError } from "../errors";
import type { StoredRef, SubmissionRecord } from "../ports";

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

/** Ambiguous or missing targets, kept out of the structured fields on purpose (see the decisions list). */
export const UNMAPPED_CANDIDATES: Record<string, string> = {
  "ON-01": "Name_Form (255): inferred from the Forms mapping label only",
  "ON-02": "no date-of-birth field; Age (integer) is derivable but is a PM decision",
  "ON-06.n": "no phone field on Requests (lives on Contact/Lead)",
  "ON-11=recomp": "no Goal picklist value for body recomposition",
  "ON-18": "Stress is a 255-char text field in Requests, the form collects 0-10",
  "TR-03": "Workouts_week picklist labels overlap (3-4, 4-5) and an actual value differs from its label",
  "TR-04": "Workout_Session actual values do not match the form's options one to one",
  "TR-05=gym_basic": "no Workout_Location value for a basic gym",
  "TR-06": "Home_Equipment_List has no value for loop band, bench, step; 'none' is ambiguous",
  "NU-*": "Requests nutrition fields are 255-char text or differently coded picklists",
  "HL-*": "Requests health fields are boolean/255-char twins (Smoking vs Smoke, Surgery vs Surgery1): wrong-twin risk",
  "MS-05.* photos": "fileupload fields cannot be set in the JSON create call; files go to the sink and are referenced in the raw JSON",
  "CN-*": "no consent fields on Requests; consent is part of the raw JSON",
};

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

export function buildRequestsRecord(
  r: SubmissionRecord,
  opts: { rawField: string; maxRawChars: number; setNewRecordFlag: boolean },
): { record: RequestsRecord; rawChars: number } {
  // Zoho Requests are always Deal-linked in the current process; a Consultation-bound link has no Deal.
  if (r.subject.kind !== "deal") {
    const e = new StoreError("REJECTED", "link type cannot be stored in CRM", "SUBJECT_NOT_ELIGIBLE");
    e.notWritten = true;
    throw e;
  }
  const raw = canonicalJson(rawDocument(r));
  const rawChars = [...raw].length;
  if (rawChars > opts.maxRawChars) {
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
    [opts.rawField]: raw,
  };
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
