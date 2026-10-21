// @vitest-environment node
// LIVE Sandbox test (CA Dev, org 850673613): synthetic Product + Contact + Deal (only if absent), then ONE zero-file Requests create
// and read-back through the real Requests writer. CRM ONLY: no WorkDrive (local stub), no e-mail, no delete. EXECUTED ONLY BY THE
// OPERATOR through tools/s2f-sandbox-first-write.ps1 (hidden prompts; credentials live in the process environment, never printed).
//
// Guards (all required, otherwise the test is skipped): S2F_LIVE_CRM_WRITE=1, S2F_LIVE_CONFIRM=S2F-TEST-ONBOARDING-20261021,
// sandbox environment, org zgid 850673613, Sandbox module-id prefix 6223361000, persistence workdrive-key, automations NOT enabled.
// Setup records are created with `trigger: []` too. Everything carries the marker S2F-TEST-ONBOARDING-20261021 and a non-routable e-mail.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { NOW_MS, validAnswers } from "../fixtures";
import type { SubmissionRecord } from "../ports";
import { ZohoClient, type ZohoResponse } from "./client";
import { loadCrmConfig } from "./config";
import { createRequestsWriter } from "./factory";

const env = process.env as Record<string, string | undefined>;
const MARK = "S2F-TEST-ONBOARDING-20261021";
const EMAIL = "s2f-test-onboarding-20261021@s2f-test.example.invalid";
const LIVE =
  env["S2F_LIVE_CRM_WRITE"] === "1" &&
  env["S2F_LIVE_CONFIRM"] === MARK &&
  env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox" &&
  env["SIX2FIT_ZOHO_ORG_ZGID"] === "850673613" &&
  env["SIX2FIT_ZOHO_MODULE_ID_PREFIX"] === "6223361000" &&
  env["SIX2FIT_ONBOARDING_CRM_PERSISTENCE"] === "workdrive-key" &&
  env["SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS"] !== "true";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)("LIVE Sandbox: first zero-file synthetic Requests create (CRM only)", () => {
  it("creates the synthetic records if absent, creates one Request, reads it back and reports workflow side effects", async () => {
    const config = loadCrmConfig(env);
    expect(config.triggerAutomations).toBe(false);
    const result: Record<string, unknown> = { marker: MARK, org: config.orgZgid, steps: [] as string[] };
    const step = (s: string) => (result["steps"] as string[]).push(s);
    const save = () => writeFileSync(join(process.env["TEMP"] ?? ".", "s2f_first_write_result.json"), JSON.stringify(result, null, 2));

    // Recording fetch: proves what is really sent (the trigger value of every write) without logging bodies of other calls.
    const sentWrites: Array<{ method: string; path: string; trigger: unknown }> = [];
    const recFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
      if (init.method === "POST" && /\/crm\/v8\/(Requests|Contacts|Deals|Products)$/.test(new URL(url).pathname)) {
        const b = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        sentWrites.push({ method: init.method, path: new URL(url).pathname, trigger: b["trigger"] });
      }
      return (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init);
    }) as never;
    const client = new ZohoClient(config, { fetch: recFetch, now: () => Date.now(), sleep });
    await client.verifyEnvironment(); // organisation zgid + sandbox type + module id prefix: nothing is written if this fails
    step("environment verified (org + sandbox + module id prefix)");

    const body = (r: ZohoResponse): Record<string, unknown> => (isObj(r.json) ? r.json : {});
    const first = (r: ZohoResponse): Record<string, unknown> => {
      const d = body(r)["data"];
      return Array.isArray(d) && isObj(d[0]) ? (d[0] as Record<string, unknown>) : {};
    };
    const fail = (what: string, r: ZohoResponse) => {
      const f = first(r);
      const details = isObj(f["details"]) ? (f["details"] as Record<string, unknown>) : {};
      result["failed"] = { what, http: r.status, code: f["code"], field: details["api_name"] };
      save();
      throw new Error(`${what} failed: HTTP ${r.status} ${String(f["code"])} ${String(details["api_name"] ?? "")}`);
    };
    const findId = async (module: string, criteria: string): Promise<string | null> => {
      const r = await client.request("GET", `/${module}/search`, { query: { criteria, fields: "id", per_page: "2" } });
      if (r.status === 204) return null;
      const d = body(r)["data"];
      if (r.status !== 200 || !Array.isArray(d)) return fail(`search ${module}`, r);
      if (d.length > 1) throw new Error(`more than one ${module} record carries the test marker: stop`);
      return d.length === 1 && isObj(d[0]) && typeof d[0]["id"] === "string" ? (d[0]["id"] as string) : null;
    };
    const create = async (module: string, rec: Record<string, unknown>): Promise<string> => {
      const r = await client.request("POST", `/${module}`, { body: { data: [rec], trigger: [] } });
      const f = first(r);
      const d = isObj(f["details"]) ? (f["details"] as Record<string, unknown>) : {};
      if (r.status >= 200 && r.status < 300 && f["code"] === "SUCCESS" && typeof d["id"] === "string") return d["id"] as string;
      return fail(`create ${module}`, r);
    };

    // 1. synthetic Product, Contact, Deal (reuse when the marker already exists)
    let productId = await findId("Products", `(Product_Name:equals:${MARK})`);
    if (!productId) productId = await create("Products", { Product_Name: MARK, Product_Active: true });
    let contactId = await findId("Contacts", `(Email:equals:${EMAIL})`);
    if (!contactId) contactId = await create("Contacts", { First_Name: "S2F-TEST", Last_Name: "ONBOARDING-20261021", Email: EMAIL, Workdrive_Folder_Id: "S2F-TEST-NO-FOLDER" });
    let dealId = await findId("Deals", `(Deal_Name:equals:${MARK})`);
    if (!dealId) {
      const fieldsRes = await client.request("GET", "/settings/fields", { query: { module: "Deals", type: "all" } });
      const stageField = (Array.isArray(body(fieldsRes)["fields"]) ? (body(fieldsRes)["fields"] as unknown[]) : []).find((f) => isObj(f) && f["api_name"] === "Stage") as Record<string, unknown> | undefined;
      const values = (Array.isArray(stageField?.["pick_list_values"]) ? (stageField?.["pick_list_values"] as unknown[]) : []).filter(isObj).map((v) => String(v["actual_value"]));
      const stage = values.includes("Form Submission") ? "Form Submission" : (values.find((v) => v !== "-None-") ?? "");
      dealId = await create("Deals", { Deal_Name: MARK, Contact_Name: { id: contactId }, Product: { id: productId }, Stage: stage, Closing_Date: "2026-12-31", Amount: 1 });
    }
    expect([productId, contactId, dealId].every((i) => /^6223361000\d{9}$/.test(i))).toBe(true); // all Sandbox ids
    result["records"] = { product: productId, contact: contactId, deal: dealId };
    step("synthetic Product, Contact and Deal ready");
    save();

    // 2. state of the linked synthetic records BEFORE the Request (for workflow evidence)
    const snapshot = async () => {
      const d = await client.request("GET", `/Deals/${dealId}`, { query: { fields: "Stage,Package_Completed,Remaining_Pacakge,Support_Owner,Last_Request_Created_At,Modified_Time" } });
      const c = await client.request("GET", `/Contacts/${contactId}`, { query: { fields: "Total_Number_of_Requests,Workdrive_Folder_Id,Modified_Time" } });
      return { deal: first(d), contact: first(c) };
    };
    const before = await snapshot();

    // 3. ONE zero-file Request create through the real writer (CRM only; WorkDrive identity is a local stub)
    const stamp = Date.now().toString(36);
    const key = `onb2_${dealId}_s2ftest${stamp}`;
    const fingerprint = sha256Hex(`s2f-test-fp-${key}`);
    const answers = validAnswers("Combo", { "ON-07": EMAIL, "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    const record: SubmissionRecord = {
      subject_key: `onb_${sha256Hex(key).slice(0, 40)}`,
      unique_form_key: key,
      fingerprint,
      scope: "Combo",
      subject: { kind: "deal", dealId } as SubmissionRecord["subject"],
      link_id: `s2ftest${stamp}`,
      entitlements: [],
      answers: answers as unknown as SubmissionRecord["answers"],
      verification_state: {},
      files: [],
      submitted_at: new Date(NOW_MS).toISOString(),
      is_first_request: true,
    };
    const writer = createRequestsWriter(env, { fetch: recFetch, documentIdentityByKey: async () => ({ fingerprint, submitted_at: record.submitted_at }) });
    let created;
    try {
      created = await writer.create(record);
    } catch (e) {
      // Ambiguous or failed: never POST again blindly. Look the key up first (the search index can lag ~20 s).
      result["create_error"] = String((e as { code?: string }).code ?? "error");
      await sleep(25_000);
      result["lookup_after_error"] = await writer.lookupId(key).catch(() => "lookup_failed");
      save();
      throw e;
    }
    expect(created.status).toBe("created");
    const requestId = created.record.record_ref as string;
    expect(requestId).toMatch(/^6223361000\d{9}$/);
    const requestWrites = sentWrites.filter((w) => w.path.endsWith("/Requests"));
    result["request"] = { id: requestId, key, posts_to_requests: requestWrites.length, trigger_sent: requestWrites[0]?.trigger };
    expect(requestWrites).toHaveLength(1);
    expect(requestWrites[0]?.trigger).toEqual([]); // `trigger: []` really left this process
    step("Request created (one POST, trigger: [])");
    save();

    // 4. read-back and field validation
    const back = await writer.readRecord(requestId, key);
    expect(back.record_ref).toBe(requestId);
    const got = first(await client.request("GET", `/Requests/${requestId}`, { query: { fields: "uniqueformkey,Deal,Contact,Email,Request_Status,Form_Complete,Form_Completion_Date,Submission_Id,Form_Version,Onboarding_Scope,Is_First_Request,Is_New_Record_Created,Owner,Modified_Time" } }));
    result["request_readback"] = got;
    expect(got["uniqueformkey"]).toBe(key);
    expect(isObj(got["Deal"]) && (got["Deal"] as Record<string, unknown>)["id"]).toBe(dealId);
    expect(got["Email"]).toBe(EMAIL);
    expect(got["Form_Complete"]).toBe(true);
    expect(got["Onboarding_Scope"]).toBe("Combo");
    step("read-back validated (key, Deal lookup, Email, Form_Complete, scope)");

    // 5. workflow evidence: did anything touch the synthetic Deal/Contact/Request after the create? (functions run within seconds)
    await sleep(30_000);
    const after = await snapshot();
    const request2 = first(await client.request("GET", `/Requests/${requestId}`, { query: { fields: "Owner,Modified_Time,Assign_to_Head_of_Fitness,Assign_to_Head_of_Nutrition,Is_New_Record_Created" } }));
    result["workflow_evidence"] = { deal_before: before.deal, deal_after: after.deal, contact_before: before.contact, contact_after: after.contact, request_after: request2 };
    save();

    // 6. duplicate prevention, only after the create above is unambiguous
    if (env["S2F_LIVE_DUP_CHECK"] === "1") {
      const again = await writer.create(record);
      expect(again.status).toBe("exists");
      expect(again.record.record_ref).toBe(requestId);
      step("duplicate create refused (exists, same id)");
    }
    step("DONE");
    save();
    console.log(`LIVE RESULT: Request ${requestId} created for Deal ${dealId}; ids saved in %TEMP%\\s2f_first_write_result.json. Nothing was deleted.`);
  }, 300_000);
});
