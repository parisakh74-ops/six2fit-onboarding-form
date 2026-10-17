// @vitest-environment node
import { describe, expect, it } from "vitest";
import { StoreError } from "../errors";
import { STATIC_KEYS, specFor } from "../fields";
import type { SubmissionRecord } from "../ports";
import { FIELD_DISPOSITION, dispositionOf } from "./field-disposition";
import { INITIAL_REQUEST_STATUS, ONBOARDING_FORM_VERSION, UNMAPPED_CANDIDATES, buildRequestsRecord, rawDocument } from "./requests-mapping";
import snapshot from "./requests-schema.snapshot.json";

const fields = snapshot.fields as Record<string, { type: string; length: number | null; read_only: boolean; formula: boolean; picklist_actual_values?: string[] }>;
const OPTS = { rawField: "Onboarding_Raw_JSON", maxRawChars: 31_000, setNewRecordFlag: false };

const record = (answers: SubmissionRecord["answers"], over: Partial<SubmissionRecord> = {}): SubmissionRecord => ({
  subject_key: "onb_synthetic_subject_key_0001",
  unique_form_key: "onb2_6223361000127220003_qa-test-0001",
  fingerprint: "f".repeat(64),
  scope: "Combo",
  subject: { kind: "deal", dealId: "6223361000127220003" },
  link_id: "qa-test-0001",
  entitlements: [],
  answers,
  verification_state: {},
  files: [],
  submitted_at: "2026-10-17T05:00:00.000Z",
  is_first_request: true,
  product_related_to: "Normal Fitness",
  ...over,
});

const RICH: SubmissionRecord["answers"] = {
  "ON-02": "1990-05-17", "ON-03": "female", "ON-04": "IR", "ON-05": "Tehran", "ON-06.cc": "+98", "ON-06.n": "9120000000", "ON-06.iso": "IR",
  "ON-07": "qa-parisa-onboarding@example.invalid", "ON-08": 170, "ON-09.kg": 70, "ON-11": "lose", "ON-12.kg": 62, "ON-13": "moderate",
  "ON-17": "fair", "ON-18": 6, "ON-19": "no", "ON-20": "none", "ON-21": "regular",
  "CN-01": true, "CN-02": true, "CN-03": true, "MS-04": "no", "MS-04.ack": true,
  "HL-03a": "no", "HL-06": "now", "HL-06.name": "synthetic medication",
  "NU-01": "other", "NU-01.other": "synthetic pattern", "NU-02": "no", "NU-03": ["lactose", "other"], "NU-03.other": "synthetic",
  "NU-04": "synthetic dislikes", "NU-06.breakfast": "b", "NU-06.lunch": "l", "NU-06.dinner": "d", "NU-06.snacks": "s", "NU-06.drinks": "k",
  "NU-08": "yes_choice", "NU-08.start": "12:00", "NU-08.end": "20:00", "NU-10": "rare", "NU-11": "yes", "NU-11.detail": "synthetic history",
  "NU-13": "4-8", "NU-14": "tea", "NU-15": ["bloat", "reflux"], "NU-15.freq.bloat": "weekly", "NU-15.freq.reflux": "daily",
  "NU-16": "synthetic triggers", "NU-17": "normal", "NU-18": "good", "NU-19": ["time", "cost"], "NU-21": "open", "NU-22": "synthetic notes",
  "TR-05": "gym_full", "TR-08": "yes", "TR-08.severity": 4,
};

describe("answer key classification (no answer is silently unclassified)", () => {
  it("the disposition table covers exactly the catalogue's static keys", () => {
    const table = Object.keys(FIELD_DISPOSITION).sort();
    expect(table).toEqual([...STATIC_KEYS].sort());
    expect(STATIC_KEYS.length).toBeGreaterThanOrEqual(110);
  });

  it("dynamic key families are classified, unknown keys are not", () => {
    expect(dispositionOf("NU-15.freq.bloat")?.d).toBe("derived");
    expect(dispositionOf("HL-04.hormonal.dose")?.d).toBe("decision");
    expect(dispositionOf("XX-99")).toBeUndefined();
    expect(specFor("NU-15.freq.bloat")).toBeDefined();
  });

  it("every direct/derived target exists in the verified Requests metadata and is writable", () => {
    for (const [key, v] of Object.entries(FIELD_DISPOSITION)) {
      if (v.d === "direct" || v.d === "derived") {
        expect(v.target, `${key} needs a target`).toBeDefined();
        const f = fields[v.target as string];
        expect(f, `${key} -> ${v.target} must exist in the Sandbox metadata`).toBeDefined();
        expect(f!.read_only || f!.formula, `${v.target} must be writable`).toBe(false);
      }
      if (v.d === "attachment") expect(specFor(key)?.t).toBe("file");
    }
  });

  it("the undecided answers are exactly the ones listed as unmapped, never written", () => {
    const decided = Object.entries(FIELD_DISPOSITION).filter(([, v]) => v.d === "decision").map(([k]) => k).sort();
    expect(Object.keys(UNMAPPED_CANDIDATES).sort()).toEqual(decided);
    const rec = buildRequestsRecord(record(RICH), OPTS).record;
    const decisionTargets = new Set(Object.values(FIELD_DISPOSITION).filter((v) => v.d === "decision" && v.target).map((v) => v.target as string));
    const direct = new Set(Object.values(FIELD_DISPOSITION).filter((v) => v.d !== "decision" && v.target).map((v) => v.target as string));
    for (const t of decisionTargets) if (!direct.has(t)) expect(Object.keys(rec), `${t} must not be written`).not.toContain(t);
  });
});

describe("Requests record: structured copies", () => {
  it("sets the initial status, the stable identifiers and the form version", () => {
    const { record: rec } = buildRequestsRecord(record(RICH), OPTS);
    expect(INITIAL_REQUEST_STATUS).toBe("Prospecting");
    expect(fields["Request_Status"]!.picklist_actual_values).toContain(rec["Request_Status"]);
    expect(rec).toMatchObject({
      Request_Status: "Prospecting",
      uniqueformkey: "onb2_6223361000127220003_qa-test-0001",
      Submission_Id: "onb_synthetic_subject_key_0001",
      Form_Version: ONBOARDING_FORM_VERSION,
      Onboarding_Scope: "Combo",
      Deal: { id: "6223361000127220003" },
      Submitted_At: "2026-10-17T05:00:00+00:00",
      Is_First_Request: "True",
      Product_Related_To: "Normal Fitness",
    });
    expect(rec["Is_New_Record_Created"]).toBeUndefined();
  });

  it("copies the verified answers and derives the documented values", () => {
    const rec = buildRequestsRecord(record(RICH), OPTS).record;
    expect(rec).toMatchObject({
      Date_of_Birth: "1990-05-17", Country_of_Residence: "IR", City_of_Residence: "Tehran", Phone: "+989120000000",
      Sex: "Female", Goal: "Weight Reduction", Daily_Activities1: "Option 3", Smoke: false, Alcohol1: false, Workout_Location: "Full Gym",
      Sleep_Quality: "fair", Stress_Level_0_10: 6, Menstrual_Status: "regular",
      Information_Accuracy_Confirmed: true, Information_Accuracy_At: "2026-10-17T05:00:00+00:00",
      Health_Data_Consent: true, Health_Consent_At: "2026-10-17T05:00:00+00:00", Terms_Accepted: true, Terms_Accepted_At: "2026-10-17T05:00:00+00:00",
      Body_Photo_Declined: true, Body_Photo_Decline_Acknowledged: true,
      Pregnancy_Breastfeeding_Status: "no", Weight_Loss_Medication_Status: "now", Weight_Loss_Medication_Details: "synthetic medication",
      Dietary_Pattern: "other: synthetic pattern", Severe_Food_Reaction: false, Food_Allergy_Intolerance: "lactose, other, other: synthetic",
      Food_Dislikes: "synthetic dislikes", Meal_Routine_Breakfast: "b", Meal_Routine_Drinks: "k",
      Fasting_Status: "yes_choice", Fasting_Eating_Window: "12:00-20:00", Restaurant_Frequency: "rare", Has_Diet_History: true,
      Diet_History_Results: "synthetic history", Daily_Water_Glasses: "4-8", Caffeine_Details: "tea",
      GI_Food_Triggers: "synthetic triggers", Appetite_Level: "normal", Eating_Control: "good", Diet_Barriers: "time, cost",
      Supplement_Preference: "open", Nutrition_Notes: "synthetic notes", Pain_Intensity_0_10: 4,
    });
    expect(JSON.parse(rec["GI_Symptoms_JSON"] as string)).toEqual({ symptoms: ["bloat", "reflux"], frequency: { bloat: "weekly", reflux: "daily" } });
  });

  it("every written structured value matches the Sandbox type, length and picklist", () => {
    const rec = buildRequestsRecord(record(RICH), OPTS).record;
    for (const [k, v] of Object.entries(rec)) {
      if (k === OPTS.rawField) continue;
      const f = fields[k];
      expect(f, `${k} must exist in the verified metadata`).toBeDefined();
      expect(f!.read_only || f!.formula, `${k} must be writable`).toBe(false);
      if (f!.type === "picklist") expect(f!.picklist_actual_values, `${k}=${String(v)}`).toContain(v);
      if (f!.type === "integer" || f!.type === "double") expect(typeof v).toBe("number");
      if (f!.type === "boolean") expect(typeof v).toBe("boolean");
      if (f!.type === "text" || f!.type === "textarea" || f!.type === "email") expect([...String(v)].length).toBeLessThanOrEqual(f!.length ?? 255);
    }
  });

  it("the raw snapshot keeps EVERY answer, including those with no structured target", () => {
    const answers = { ...RICH, "TR-09": "synthetic training note", "HL-02": ["none"], "ON-027": "no" };
    const { record: rec } = buildRequestsRecord(record(answers), OPTS);
    const doc = JSON.parse(rec[OPTS.rawField] as string) as { answers: Record<string, unknown> };
    expect(doc.answers).toEqual(answers);
    expect(rawDocument(record(answers))["answers"]).toEqual(answers);
  });
});

describe("deterministic handling of invalid or unsupported values", () => {
  it("omits what does not fit its target and never throws or truncates; the raw snapshot still has it", () => {
    const answers: SubmissionRecord["answers"] = {
      "ON-02": "17/05/1990", // not an ISO date
      "ON-04": "x".repeat(300), // longer than the 255-character field
      "ON-06.cc": "98", "ON-06.n": "12ab", // not a dial code / not digits
      "ON-18": 11, "TR-08.severity": 2.5, // outside 0..10 / not an integer
      "NU-01": "other", "NU-01.other": "y".repeat(300), // 'other: ...' would exceed 255
      "NU-08.start": "25:00", "NU-08.end": "20:00", // invalid time
      "NU-02": "maybe", "NU-11": "perhaps", // neither yes nor no
      "ON-11": "recomp", "TR-05": "gym_basic", // no picklist value
      "NU-15": ["none"], "CN-01": false, "MS-04": "yes",
    };
    const { record: rec } = buildRequestsRecord(record(answers), OPTS);
    for (const k of ["Date_of_Birth", "Country_of_Residence", "Phone", "Stress_Level_0_10", "Pain_Intensity_0_10", "Dietary_Pattern", "Fasting_Eating_Window", "Severe_Food_Reaction", "Has_Diet_History", "Goal", "Workout_Location", "GI_Symptoms_JSON", "Information_Accuracy_Confirmed", "Body_Photo_Declined"]) {
      expect(Object.keys(rec), `${k} must be omitted`).not.toContain(k);
    }
    const doc = JSON.parse(rec[OPTS.rawField] as string) as { answers: Record<string, unknown> };
    expect(doc.answers["ON-02"]).toBe("17/05/1990");
    expect(doc.answers["ON-11"]).toBe("recomp");
  });

  it("a record with no optional answers is still complete and valid", () => {
    const { record: rec } = buildRequestsRecord(record({}), OPTS);
    expect(Object.keys(rec).sort()).toEqual(["Deal", "Form_Complete", "Form_Completion_Date", "Form_Version", "Is_First_Request", "Onboarding_Raw_JSON", "Onboarding_Scope", "Product_Related_To", "Request_Status", "Submission_Id", "Submitted_At", "uniqueformkey"].sort());
  });

  it("answers that exceed the raw field capacity are refused before any CRM call, deterministically", () => {
    const big = record({ "NU-04": "ی".repeat(2000), "NU-06.breakfast": "ی".repeat(2000) });
    let err: unknown;
    try {
      buildRequestsRecord(big, { ...OPTS, maxRawChars: 1000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError & { notWritten?: boolean }).notWritten).toBe(true);
    expect((err as StoreError).code).toBe("RAW_TOO_LARGE");
  });

  it("a Consultation hand-off subject is never written to the CRM", () => {
    const consult = record({}, { subject: { kind: "consult", consultSubmissionId: "cns_x" } as SubmissionRecord["subject"] });
    expect(() => buildRequestsRecord(consult, OPTS)).toThrow(StoreError);
  });

  it("enabling the new-record flag stays an explicit option", () => {
    expect(buildRequestsRecord(record({}), { ...OPTS, setNewRecordFlag: true }).record["Is_New_Record_Created"]).toBe(true);
  });
});
