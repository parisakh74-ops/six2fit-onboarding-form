/**
 * What happens to every Onboarding answer key on its way to the CRM `Requests` module.
 *
 * Every answer ALWAYS survives completely in the raw submission snapshot (`rawDocument`). This table only says whether a
 * key is ADDITIONALLY copied into a structured Requests field, and why not when it is not:
 *   direct     value copied unchanged (validated for type and length) into a semantically identical field
 *   derived    recoded, combined or reformatted into a structured field (the rule lives in `buildRequestsRecord`)
 *   snapshot   raw snapshot only; no structured target is needed
 *   attachment file: only its metadata (name, type, size, SHA-256, sink reference) is stored; bytes never go to the CRM here
 *   decision   a candidate field exists but the match is ambiguous (wrong-twin risk, differing codes/units, unclear meaning);
 *              NOT written until the Product Manager approves a target
 * Reviewed against the CA Dev Sandbox Requests metadata (2026-10-17) and the form labels in `steps.tsx`.
 */
export type Disposition = "direct" | "derived" | "snapshot" | "attachment" | "decision";

export const FIELD_DISPOSITION: Record<string, { d: Disposition; target?: string; note?: string }> = {
  // --- identity / profile (ON)
  "ON-01": { d: "decision", target: "Name_Form", note: "label match only inferred from the Forms mapping" },
  "ON-02": { d: "direct", target: "Date_of_Birth" },
  "ON-03": { d: "derived", target: "Sex", note: "female/male -> picklist actual value" },
  "ON-04": { d: "direct", target: "Country_of_Residence", note: "ISO 3166-1 alpha-2 code" },
  "ON-05": { d: "direct", target: "City_of_Residence" },
  "ON-06.cc": { d: "derived", target: "Phone", note: "dial code + national number" },
  "ON-06.iso": { d: "snapshot" },
  "ON-06.n": { d: "derived", target: "Phone" },
  "ON-07": { d: "direct", target: "Email" },
  "ON-08": { d: "direct", target: "Height_cm" },
  "ON-09.kg": { d: "direct", target: "Current_Weight_Kg" },
  "ON-10": { d: "decision", target: "Pre_Pregnancy_Weight_Kg", note: "question wording not confirmed to be the pre-pregnancy weight" },
  "ON-11": { d: "derived", target: "Goal", note: "recomp has no picklist value: omitted, kept in the snapshot" },
  "ON-12.kg": { d: "direct", target: "Goal_Weight" },
  "ON-12.unsure": { d: "snapshot" },
  "ON-13": { d: "derived", target: "Daily_Activities1", note: "picklist ACTUAL values (Option 1..3, Very Active)" },
  "ON-15.sleep": { d: "decision", note: "no Requests field for bed time" },
  "ON-15.wake": { d: "decision", note: "no Requests field for wake time" },
  "ON-17": { d: "derived", target: "Sleep_Quality", note: "form code stored as text" },
  "ON-18": { d: "derived", target: "Stress_Level_0_10", note: "integer 0..10" },
  "ON-19": { d: "derived", target: "Smoke", note: "yes/no -> boolean" },
  "ON-19.detail": { d: "decision", target: "Smoking_Type_Frequency", note: "legacy twin of Smoke/Smoking" },
  "ON-20": { d: "derived", target: "Alcohol1", note: "any use -> true; wrong-twin risk with Alcohol_Type_Frequency avoided" },
  "ON-20.detail": { d: "decision", target: "Alcohol_Type_Frequency", note: "legacy twin" },
  "ON-21": { d: "derived", target: "Menstrual_Status", note: "form code stored as text" },
  "ON-21.note": { d: "decision", target: "PMS_Notes", note: "field meaning not confirmed" },
  "ON-027": { d: "decision", target: "Friends_and_Family", note: "referral answer vs. legacy free-text field" },
  "ON-027.name": { d: "decision", target: "Friends_and_Family" },
  "ON-027.phone": { d: "decision", note: "third-party phone number: minimise, PM decision" },
  // --- consent (CN)
  "CN-01": { d: "derived", target: "Information_Accuracy_Confirmed", note: "+ Information_Accuracy_At" },
  "CN-02": { d: "derived", target: "Health_Data_Consent", note: "+ Health_Consent_At" },
  "CN-03": { d: "derived", target: "Terms_Accepted", note: "+ Terms_Accepted_At" },
  // --- measurements / photos (MS)
  "MS-02": { d: "direct", target: "Abdomen_circumference" },
  "MS-03": { d: "direct", target: "Hip_circumference" },
  "MS-04": { d: "derived", target: "Body_Photo_Declined", note: "the only option is the decline" },
  "MS-04.ack": { d: "derived", target: "Body_Photo_Decline_Acknowledged" },
  "MS-05.front": { d: "attachment" },
  "MS-05.back": { d: "attachment" },
  "MS-05.side": { d: "attachment" },
  "MS-05.side_forward": { d: "attachment" },
  "MS-06.consent": { d: "snapshot", note: "photo consent has no Requests field" },
  "MS-06.photo": { d: "attachment" },
  "MS-07.neck": { d: "direct", target: "Neck_circumference" },
  "MS-07.shoulder": { d: "direct", target: "Shoulder_Width" },
  "MS-07.chest": { d: "direct", target: "Chest_circumference" },
  "MS-07.arm_flexed": { d: "direct", target: "Flexed_Arm_circumference" },
  "MS-07.arm_relaxed": { d: "decision", note: "only a flexed-arm field exists" },
  "MS-07.thigh": { d: "direct", target: "Thigh_circumference" },
  "MS-07.calf": { d: "direct", target: "Calf_circumference" },
  "MS-07.wrist": { d: "direct", target: "Wrist_circumference" },
  // --- health (HL)
  "HL-02": { d: "decision", note: "diagnosed conditions: legacy boolean twins, no single target" },
  "HL-03a": { d: "derived", target: "Pregnancy_Breastfeeding_Status", note: "form code stored as text" },
  "HL-03b": { d: "derived", target: "Breastfeeding_Age_Range", note: "form code stored as text" },
  "HL-04": { d: "decision", target: "Medication", note: "boolean/text twins (Medication, Medication_Type, Hormonal_Medications)" },
  "HL-05": { d: "decision", target: "Current_Supplements", note: "boolean twin of Current_Supplement" },
  "HL-05.dose": { d: "decision" },
  "HL-05.name": { d: "decision" },
  "HL-05.reason": { d: "decision" },
  "HL-05.time": { d: "decision" },
  "HL-06": { d: "derived", target: "Weight_Loss_Medication_Status", note: "form code stored as text" },
  "HL-06.name": { d: "direct", target: "Weight_Loss_Medication_Details" },
  "HL-07": { d: "decision", target: "Cosmetic_Surgery1", note: "boolean/picklist twins" },
  "HL-08": { d: "decision", target: "Surgery1", note: "boolean twin of Surgery_Location" },
  "HL-08.area": { d: "decision" },
  "HL-08.type": { d: "decision" },
  "HL-08.when": { d: "decision" },
  "HL-09": { d: "attachment", note: "medical document: not uploaded" },
  // --- nutrition (NU)
  "NU-01": { d: "derived", target: "Dietary_Pattern", note: "code, or 'other: <text>' when it fits 255 characters" },
  "NU-01.other": { d: "derived", target: "Dietary_Pattern" },
  "NU-02": { d: "derived", target: "Severe_Food_Reaction", note: "yes/no -> boolean" },
  "NU-03": { d: "derived", target: "Food_Allergy_Intolerance", note: "codes joined, plus the free text" },
  "NU-03.other": { d: "derived", target: "Food_Allergy_Intolerance" },
  "NU-04": { d: "direct", target: "Food_Dislikes" },
  "NU-05": { d: "decision", target: "Food_Type_Preferences", note: "picklist values differ from the form codes" },
  "NU-06.breakfast": { d: "direct", target: "Meal_Routine_Breakfast" },
  "NU-06.lunch": { d: "direct", target: "Meal_Routine_Lunch" },
  "NU-06.dinner": { d: "direct", target: "Meal_Routine_Dinner" },
  "NU-06.snacks": { d: "direct", target: "Meal_Routine_Snacks" },
  "NU-06.drinks": { d: "direct", target: "Meal_Routine_Drinks" },
  "NU-08": { d: "derived", target: "Fasting_Status", note: "form code stored as text" },
  "NU-08.start": { d: "derived", target: "Fasting_Eating_Window", note: "HH:MM-HH:MM when both are present" },
  "NU-08.end": { d: "derived", target: "Fasting_Eating_Window" },
  "NU-10": { d: "derived", target: "Restaurant_Frequency", note: "form code stored as text" },
  "NU-11": { d: "derived", target: "Has_Diet_History", note: "yes/no -> boolean" },
  "NU-11.detail": { d: "direct", target: "Diet_History_Results" },
  "NU-13": { d: "derived", target: "Daily_Water_Glasses", note: "form code stored as text" },
  "NU-14": { d: "direct", target: "Caffeine_Details" },
  "NU-15": { d: "derived", target: "GI_Symptoms_JSON", note: "symptoms plus the per-symptom frequency, as JSON" },
  "NU-16": { d: "direct", target: "GI_Food_Triggers" },
  "NU-17": { d: "derived", target: "Appetite_Level", note: "form code stored as text" },
  "NU-18": { d: "derived", target: "Eating_Control", note: "form code stored as text" },
  "NU-19": { d: "derived", target: "Diet_Barriers", note: "codes joined" },
  "NU-21": { d: "derived", target: "Supplement_Preference", note: "form code stored as text" },
  "NU-22": { d: "direct", target: "Nutrition_Notes" },
  // --- training (TR)
  "TR-01": { d: "decision", target: "Training_Capability", note: "meaning of the field name vs. the question not confirmed" },
  "TR-02": { d: "decision" },
  "TR-03": { d: "decision", target: "Workouts_week", note: "overlapping labels, an ACTUAL value differs from its label" },
  "TR-04": { d: "decision", target: "Workout_Session", note: "ACTUAL values do not match the options one to one" },
  "TR-05": { d: "derived", target: "Workout_Location", note: "gym_basic has no value: omitted, kept in the snapshot" },
  "TR-06": { d: "decision", target: "Home_Equipment_List", note: "no value for loop band, bench, step; 'none' is ambiguous" },
  "TR-06.other_name": { d: "decision" },
  "TR-06.other_photo": { d: "attachment" },
  "TR-07": { d: "decision" },
  "TR-07.clinician": { d: "decision" },
  "TR-07.location": { d: "decision" },
  "TR-07.type": { d: "decision" },
  "TR-08": { d: "decision", target: "Pain_Anywhere_in_Body", note: "boolean twin Pain_Anywhere_in_the_body" },
  "TR-08.effect": { d: "decision" },
  "TR-08.location": { d: "decision" },
  "TR-08.onset": { d: "decision" },
  "TR-08.severity": { d: "derived", target: "Pain_Intensity_0_10", note: "integer 0..10" },
  "TR-09": { d: "decision" },
};

/** Disposition of any answer key, including the dynamic families. `undefined` = not part of the form. */
export function dispositionOf(key: string): { d: Disposition; target?: string; note?: string } | undefined {
  if (Object.hasOwn(FIELD_DISPOSITION, key)) return FIELD_DISPOSITION[key];
  if (/^NU-15\.freq\.[a-z]+$/.test(key)) return { d: "derived", target: "GI_Symptoms_JSON" };
  if (/^HL-04\.[a-z]+\.(name|dose)$/.test(key)) return { d: "decision", target: "Medication_Type" };
  return undefined;
}
