// @vitest-environment node
// LIVE Sandbox test: ONE synthetic Requests create (zero files) + read-back, CRM ONLY (no WorkDrive, no e-mail, no delete).
// PREPARED, NOT EXECUTED. Skipped unless every guard below is satisfied. Credentials come only from the process environment
// (set by the operator, never printed). The WorkDrive identity resolver is a LOCAL STUB: this test proves the CRM write path only.
//
//   S2F_LIVE_CRM_WRITE=1
//   S2F_LIVE_CONFIRM_ISOLATION=REQUESTS-CREATE-RULES-INACTIVE   (operator confirms the Sandbox Requests rules that fire on create are off)
//   S2F_LIVE_SYNTHETIC_DEAL_ID=<id of an existing SYNTHETIC Sandbox Deal>
//   S2F_LIVE_DUP_CHECK=1   (optional: a second identical create must be refused as a duplicate, creating nothing)
//   SIX2FIT_ONBOARDING_CRM_ENABLED=true, SIX2FIT_ZOHO_ENVIRONMENT=sandbox, SIX2FIT_ZOHO_ORG_ZGID=850673613, SIX2FIT_ZOHO_API_DOMAIN,
//   SIX2FIT_ZOHO_ACCOUNTS_DOMAIN, SIX2FIT_ZOHO_MODULE_ID_PREFIX=6223361000, SIX2FIT_ZOHO_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN (writer grant),
//   SIX2FIT_ONBOARDING_CRM_PERSISTENCE=workdrive-key, SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID/_NAME (any well-formed placeholders: not contacted)
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { NOW_MS, validAnswers } from "../fixtures";
import type { SubmissionRecord } from "../ports";
import { loadCrmConfig } from "./config";
import { createRequestsWriter } from "./factory";

const env = process.env as Record<string, string | undefined>;
const DEAL = (env["S2F_LIVE_SYNTHETIC_DEAL_ID"] ?? "").trim();
const LIVE =
  env["S2F_LIVE_CRM_WRITE"] === "1" &&
  env["S2F_LIVE_CONFIRM_ISOLATION"] === "REQUESTS-CREATE-RULES-INACTIVE" &&
  /^6223361000\d{9}$/.test(DEAL) && // Sandbox id prefix only: a Production id can never pass
  env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox" &&
  env["SIX2FIT_ZOHO_ORG_ZGID"] === "850673613" &&
  env["SIX2FIT_ZOHO_MODULE_ID_PREFIX"] === "6223361000" &&
  env["SIX2FIT_ONBOARDING_CRM_PERSISTENCE"] === "workdrive-key" &&
  env["SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS"] !== "true";

describe.skipIf(!LIVE)("LIVE Sandbox: one synthetic Requests create (zero files), CRM only", () => {
  it("creates exactly one Request, reads it back, and (optionally) proves duplicate prevention", async () => {
    const config = loadCrmConfig(env);
    expect(config.triggerAutomations).toBe(false); // the body carries `trigger: []`
    const stamp = Date.now().toString(36);
    const key = `onb2_${DEAL}_sbxtest${stamp}`;
    const fingerprint = sha256Hex(`sbxtest-fp-${key}`);
    const answers = validAnswers("Combo", { "ON-07": `sbxtest.${stamp}@sbxtest.example.invalid`, "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    const record: SubmissionRecord = {
      subject_key: `onb_${sha256Hex(key).slice(0, 40)}`,
      unique_form_key: key,
      fingerprint,
      scope: "Combo",
      subject: { kind: "deal", dealId: DEAL } as SubmissionRecord["subject"],
      link_id: `sbxtest${stamp}`,
      entitlements: [],
      answers: answers as unknown as SubmissionRecord["answers"],
      verification_state: {},
      files: [],
      submitted_at: new Date(NOW_MS).toISOString(),
      is_first_request: true,
    };
    const events: string[] = [];
    // LOCAL STUB: no WorkDrive is contacted; it only returns the fingerprint this test just generated.
    const writer = createRequestsWriter(env, { log: (e) => events.push(e), documentIdentityByKey: async () => ({ fingerprint, submitted_at: record.submitted_at }) });

    const created = await writer.create(record);
    expect(created.status).toBe("created");
    const id = created.record.record_ref as string;
    expect(id).toMatch(/^6223361000\d{9}$/); // a Sandbox record id
    const back = await writer.readRecord(id, key); // GET /Requests/{id}: uniqueformkey must equal the key
    expect(back.record_ref).toBe(id);
    console.log(`LIVE RESULT: created Requests record ${id} (unique key ${key}). Delete it manually in the Sandbox UI when done.`);

    if (env["S2F_LIVE_DUP_CHECK"] === "1") {
      const again = await writer.create(record);
      expect(again.status).toBe("exists");
      expect(again.record.record_ref).toBe(id);
    }
  }, 120_000);
});
