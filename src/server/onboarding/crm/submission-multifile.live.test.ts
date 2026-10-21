// @vitest-environment node
// LIVE Sandbox + WorkDrive test: ONE synthetic MULTI-FILE (7 uploads) Onboarding submission through the REAL runtime
// (handleSubmit -> service -> ledger -> WorkDrive staging -> Requests create), linked to the EXISTING synthetic Deal.
// PREPARED, NOT EXECUTED. Operator-run only (tools/s2f-sandbox-workdrive-test.ps1 -MultiFile). Credentials only from the process
// environment. Synthetic data only (artificial files with valid magic numbers, marker S2F-TEST-ONBOARDING-20261021). Nothing is deleted.
// The older adapter-level `live-multifile.live.test.ts` stays separately gated and is NOT run by this test.
//
// Guards (all required): S2F_LIVE_MF=1, S2F_LIVE_CONFIRM=S2F-TEST-ONBOARDING-20261021-MULTIFILE, S2F_LIVE_DEAL_ID / S2F_LIVE_PRODUCT_ID
// (Sandbox ids), sandbox + org 850673613 + Sandbox id prefix, persistence workdrive-key, WorkDrive root title /^S2F-.*TEST/,
// WorkDrive API base https://www.zohoapis.<dc>/workdrive/api/v1, automations NOT enabled.
// Optional: S2F_LIVE_RECOVERY=1 (case C: 4th upload refused, resumed retry), S2F_LIVE_MF_AMBIGUOUS=1 (case D: upload applied, answer lost).
// WorkDrive write budget (POST /files and /upload counted at the network layer): A 9, C 9, D 10, plus a margin of 1.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { handleSubmit, runtimeFromEnv, type Runtime } from "../http";
import { signLinkToken, uniqueFormKey, verifyLinkToken } from "../tokens";
import { WdHttpError, type WdItem, type WorkDriveApi } from "../workdrive/api";
import { DOCUMENT_NAME } from "../workdrive/storage";
import { ZohoClient } from "./client";
import { loadCrmConfig } from "./config";
import { LIVE_EMAIL, MULTIFILE_ENTITLEMENTS, buildMultiFileRequest, liveSubmissionId, syntheticFiles, syntheticMultiFileAnswers } from "./live-fixtures";

const env = process.env as Record<string, string | undefined>;
const CONFIRM = "S2F-TEST-ONBOARDING-20261021-MULTIFILE";
const DEAL = (env["S2F_LIVE_DEAL_ID"] ?? "").trim();
const PRODUCT = (env["S2F_LIVE_PRODUCT_ID"] ?? "").trim();
const LIVE =
  env["S2F_LIVE_MF"] === "1" &&
  env["S2F_LIVE_CONFIRM"] === CONFIRM &&
  /^6223361000\d{9}$/.test(DEAL) &&
  /^6223361000\d{9}$/.test(PRODUCT) &&
  env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox" &&
  env["SIX2FIT_ZOHO_ORG_ZGID"] === "850673613" &&
  env["SIX2FIT_ZOHO_MODULE_ID_PREFIX"] === "6223361000" &&
  env["SIX2FIT_ONBOARDING_CRM_PERSISTENCE"] === "workdrive-key" &&
  /^S2F-[A-Z0-9-]*TEST/.test(env["SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME"] ?? "") &&
  /^https:\/\/www\.zohoapis\.[a-z.]+\/workdrive\/api\/v1$/.test(env["SIX2FIT_WORKDRIVE_API_BASE"] ?? "") &&
  env["SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS"] !== "true";

const RECOVERY = env["S2F_LIVE_RECOVERY"] === "1";
const AMBIGUOUS = env["S2F_LIVE_MF_AMBIGUOUS"] === "1";
const WD_WRITE_CAP = 10 + (RECOVERY ? 10 : 0) + (AMBIGUOUS ? 11 : 0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Failure injection at the adapter boundary (a decorator around the REAL client): the Nth upload never leaves, or is applied and its answer lost. */
class Guarded implements WorkDriveApi {
  uploads = 0;
  armed: { upload: number; kind: "not-sent" | "answer-lost" } | null = null;
  constructor(private readonly inner: WorkDriveApi) {}
  getItem(id: string) { return this.inner.getItem(id); }
  list(id: string) { return this.inner.list(id); }
  download(id: string) { return this.inner.download(id); }
  createFolder(p: string, n: string) { return this.inner.createFolder(p, n); }
  async upload(p: string, n: string, b: Uint8Array): Promise<WdItem> {
    this.uploads += 1;
    if (this.armed && this.uploads === this.armed.upload) {
      if (this.armed.kind === "not-sent") throw new WdHttpError(503);
      await this.inner.upload(p, n, b);
      throw new WdHttpError(0);
    }
    return this.inner.upload(p, n, b);
  }
}

describe.skipIf(!LIVE)("LIVE Sandbox + WorkDrive: multi-file synthetic submission", () => {
  it("uploads 7 files, verifies every hash, creates ONE Request, proves duplicate/conflict handling and (optionally) recovery", async () => {
    const result: Record<string, unknown> = { marker: CONFIRM, wd_write_cap: WD_WRITE_CAP, steps: [] as string[] };
    const step = (s: string) => (result["steps"] as string[]).push(s);
    const save = async () => writeFile(join(process.env["TEMP"] ?? tmpdir(), "s2f_multifile_result.json"), JSON.stringify(result, null, 2));

    const crmPosts: Array<{ trigger: unknown }> = [];
    const wdWrites: string[] = [];
    const crmFetch = (async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "POST" && /\/crm\/v8\/Requests$/.test(new URL(url).pathname)) crmPosts.push({ trigger: (JSON.parse(init.body ?? "{}") as Record<string, unknown>)["trigger"] });
      return (globalThis.fetch as unknown as (a: string, b: unknown) => Promise<Response>)(url, init);
    }) as never;
    const wdFetch = (async (url: string, init: { method?: string }) => {
      const p = new URL(url).pathname;
      if ((init.method ?? "GET") === "POST" && (p.endsWith("/files") || p.endsWith("/upload"))) {
        wdWrites.push(p.split("/").pop() as string);
        if (wdWrites.length > WD_WRITE_CAP) throw new Error("STOP: WorkDrive write budget exceeded");
      }
      return (globalThis.fetch as unknown as (a: string, b: unknown) => Promise<Response>)(url, init);
    }) as never;

    const dir = await mkdtemp(join(tmpdir(), "s2f-mf-live-"));
    await mkdir(dir, { recursive: true });
    const secret = randomBytes(24).toString("hex");
    const runtimeEnv: Record<string, string | undefined> = {
      ...env,
      SIX2FIT_STAGING_MODE: "true", SIX2FIT_ONBOARDING_STORE: "crm", SIX2FIT_ONBOARDING_TOKEN_SECRET: secret, SIX2FIT_STAGING_STORAGE_DIR: dir,
      SIX2FIT_EXPECTED_ORG_ID: "850673613",
      // The cellulite add-on opens the MS-06 photo field; the link and this (test-local) product map must agree.
      SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [...MULTIFILE_ENTITLEMENTS] } }),
      SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "60000",
    };
    const build = (workdriveApi?: WorkDriveApi): Runtime => runtimeFromEnv(runtimeEnv, {}, { fetch: crmFetch, workdriveFetch: wdFetch, ...(workdriveApi ? { workdriveApi } : {}) });
    const rt = build();
    const crm = rt.ops?.crm;
    expect(crm?.persistence).toBe("workdrive-key");
    expect(crm?.sink.deferred).toBe(true);
    const wd = crm?.workdrive;
    if (!wd || !crm?.lookup) throw new Error("WorkDrive runtime missing");
    await wd.storage.verifyRootFolder();
    result["workdrive_root"] = { id: wd.config.rootFolderId, title: wd.config.rootFolderName };
    step("WorkDrive OAuth refresh + root folder (id and title) verified");

    const client = new ZohoClient(loadCrmConfig(runtimeEnv), { fetch: crmFetch, now: () => Date.now(), sleep });
    const first = (r: { json: unknown }) => (isObj(r.json) && Array.isArray(r.json["data"]) && isObj(r.json["data"][0]) ? (r.json["data"][0] as Record<string, unknown>) : {});
    const getRequest = async (id: string) => first(await client.request("GET", `/Requests/${id}`, { query: { fields: "uniqueformkey,Deal,Contact,Product,Email,Form_Complete,Onboarding_Scope,Request_Status,Submission_Id,Form_Version,Is_First_Request" } }));
    const snapshot = async () => ({
      deal: first(await client.request("GET", `/Deals/${DEAL}`, { query: { fields: "Stage,Package_Completed,Remaining_Pacakge,Support_Owner,Modified_Time" } })),
    });
    const waitLookup = async (key: string): Promise<string> => {
      for (let i = 0; i < 14; i += 1) {
        const id = await crm.lookup!.lookupId(key).catch(() => null);
        if (id) return id;
        await sleep(5000); // the CRM search index lags a create by ~20 s
      }
      throw new Error("Request not found by uniqueformkey after 70 s: do NOT retry the POST; inspect the Requests module by key");
    };

    const answers = syntheticMultiFileAnswers(LIVE_EMAIL);
    const files = syntheticFiles();
    const hashes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, sha256Hex(f.bytes)]));
    expect(new Set(Object.values(hashes)).size).toBe(7);
    const link = (jti: string) => signLinkToken({ v: 2, deal_id: DEAL, jti, scope: "Combo", entitlements: [...MULTIFILE_ENTITLEMENTS], exp: Math.floor(Date.now() / 1000) + 24 * 3600, is_first_request: true, product_related_to: "S2F-TEST-ONBOARDING-20261021" }, secret);
    const submit = (runtime: Runtime, token: string, sid: string, over: { answers?: Record<string, string>; files?: typeof files } = {}) =>
      handleSubmit(buildMultiFileRequest({ token, submissionId: sid, answers: over.answers ?? answers, files: over.files ?? files }), { runtime: () => runtime });
    const folderItems = async (key: string) => {
      const folders = (await wd.api.list(wd.config.rootFolderId)).filter((i) => i.kind === "folder" && i.name === key);
      expect(folders).toHaveLength(1);
      return { folder: folders[0] as WdItem, items: await wd.api.list((folders[0] as WdItem).id) };
    };

    // ===== A. the main case: one NEW unique Request, seven files in one submission =====
    const stamp = Date.now().toString(36);
    const token = link(`s2ftest${stamp}MFA${randomBytes(4).toString("hex")}`);
    const key = uniqueFormKey(verifyLinkToken(token, secret));
    const sid = liveSubmissionId("MF-A", stamp);
    const before = await snapshot();
    const res = await submit(rt, token, sid);
    const body = (await res.json()) as Record<string, unknown>;
    result["case_A"] = { unique_form_key: key, submit: { status: res.status, code: body["error_code"] ?? body["status"], issues: body["issues"] } };
    await save();
    expect(res.status, `submit failed: ${String(body["error_code"])} ${JSON.stringify(body["issues"] ?? "")}`).toBe(200);
    expect(body).toMatchObject({ status: "completed", deduplicated: false });
    step("A: 7-file submission accepted (200, not deduplicated)");

    const { folder, items } = await folderItems(key);
    expect(items).toHaveLength(8);
    expect(new Set(items.map((i) => i.name)).size).toBe(8); // every item exactly once
    const docItem = items.filter((i) => i.name === DOCUMENT_NAME);
    expect(docItem).toHaveLength(1);
    const doc = JSON.parse(new TextDecoder().decode(await wd.api.download((docItem[0] as WdItem).id))) as { files: Array<{ key: string; sha256: string; size: number; type: string; ref: string }>; unique_form_key: string };
    expect(doc.unique_form_key).toBe(key);
    expect(doc.files).toHaveLength(7);
    const verified: Array<{ key: string; name: string; sha256: string; bytes: number }> = [];
    for (const [k, f] of Object.entries(files)) {
      const entry = doc.files.find((x) => x.key === k);
      expect(entry, `document entry for ${k}`).toBeDefined();
      const stored = items.find((i) => i.id === (entry as { ref: string }).ref.replace(/^wd:/, ""));
      expect(stored, `stored item for ${k}`).toBeDefined();
      expect(entry?.sha256).toBe(hashes[k]);
      expect(entry?.size).toBe(f.bytes.length);
      expect(stored?.size).toBe(f.bytes.length);
      expect(sha256Hex(await wd.api.download((stored as WdItem).id))).toBe(hashes[k]); // the stored bytes are the submitted bytes
      verified.push({ key: k, name: (stored as WdItem).name, sha256: hashes[k] as string, bytes: f.bytes.length });
    }
    const identity = await wd.storage.readDocumentIdentityByKey(key);
    (result["case_A"] as Record<string, unknown>)["workdrive"] = { folder_id: folder.id, item_count: items.length, files: verified, document_fingerprint: identity.fingerprint };
    step("A: folder with 7 files + one submission.v1.json; every file downloaded and SHA-256 verified; references match; fingerprint recomputed");

    expect(crmPosts).toHaveLength(1);
    expect(crmPosts[0]?.trigger).toEqual([]);
    const requestId = await waitLookup(key);
    const got = await getRequest(requestId);
    expect(got["uniqueformkey"]).toBe(key);
    expect(isObj(got["Deal"]) && (got["Deal"] as Record<string, unknown>)["id"]).toBe(DEAL);
    expect(got["Email"]).toBe(LIVE_EMAIL);
    expect(got["Form_Complete"]).toBe(true);
    expect(got["Onboarding_Scope"]).toBe("Combo");
    (result["case_A"] as Record<string, unknown>)["request"] = { id: requestId, posts: crmPosts.length, trigger: crmPosts[0]?.trigger, readback: got };
    step("A: exactly one Requests POST (trigger []); found by key; Deal link, Email, Form_Complete, scope verified");
    expect((await readdir(dir)).filter((n) => !["onboarding-ledger", "payments", "issued-links"].includes(n))).toEqual([]);
    step("A: no uploaded file or document on the local disk");
    await save();

    // ===== B. duplicate / conflict (after A is unambiguous) =====
    const writesAfterA = wdWrites.length;
    const again = await submit(rt, token, sid);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true });
    const conflictAnswers = await submit(rt, token, sid, { answers: { ...answers, "ON-01": "S2F-TEST Different" } });
    expect(conflictAnswers.status).toBe(409);
    const changed = { ...files, "MS-05.back": { ...files["MS-05.back"]!, bytes: files["MS-05.back"]!.bytes.map((b, i) => (i === 100 ? b ^ 1 : b)) } };
    const conflictFile = await submit(rt, token, sid, { files: changed });
    expect(conflictFile.status).toBe(409);
    expect(wdWrites.length).toBe(writesAfterA); // no WorkDrive write at all
    expect(crmPosts).toHaveLength(1);
    expect((await folderItems(key)).items).toHaveLength(8);
    step("B: identical resubmit deduplicated; conflicting answers 409; one changed file 409; no write, no new item, no new POST");
    await save();

    // ===== C. partial failure during ONE file upload, then a controlled retry =====
    if (RECOVERY) {
      const guarded = new Guarded(wd.api);
      guarded.armed = { upload: 4, kind: "not-sent" }; // files 1-3 stored, the 4th refused
      const rt2 = build(guarded);
      const token2 = link(`s2ftest${stamp}MFC${randomBytes(4).toString("hex")}`);
      const key2 = uniqueFormKey(verifyLinkToken(token2, secret));
      const sid2 = liveSubmissionId("MF-C", stamp);
      const postsBefore = crmPosts.length;
      const r1 = await submit(rt2, token2, sid2);
      expect(r1.status).toBe(503);
      expect(crmPosts.length).toBe(postsBefore); // WorkDrive failed first: no CRM write
      const mid = await folderItems(key2);
      expect(mid.items).toHaveLength(3);
      const writesMid = wdWrites.length;
      guarded.armed = null;
      const r2 = await submit(rt2, token2, sid2);
      expect(r2.status).toBe(200);
      const done = await folderItems(key2);
      expect(done.items).toHaveLength(8);
      expect(done.items.some((i) => /\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(false); // no renamed duplicate upload
      expect(wdWrites.length - writesMid).toBe(5); // 4 remaining files + the document: stored files were not uploaded again
      expect(crmPosts.length).toBe(postsBefore + 1);
      const id2 = await waitLookup(key2);
      result["case_C"] = { unique_form_key: key2, failure_injected_at_upload: 4, first_status: r1.status, items_after_failure: mid.items.length, second_status: r2.status, items_final: done.items.map((i) => i.name).sort(), request_id: id2, posts: crmPosts.length - postsBefore };
      step("C: 4th upload refused -> 503, no CRM write, 3 files kept; retry resumed: 8 items, 5 new writes, exactly one Request");
      await save();
    }

    // ===== D. ambiguous upload (applied, answer lost): recovered by looking, never by blind re-upload =====
    if (AMBIGUOUS) {
      const guarded = new Guarded(wd.api);
      guarded.armed = { upload: 2, kind: "answer-lost" };
      const rt3 = build(guarded);
      const token3 = link(`s2ftest${stamp}MFD${randomBytes(4).toString("hex")}`);
      const key3 = uniqueFormKey(verifyLinkToken(token3, secret));
      const sid3 = liveSubmissionId("MF-D", stamp);
      const postsBefore = crmPosts.length;
      const r1 = await submit(rt3, token3, sid3);
      result["case_D"] = { unique_form_key: key3, first_status: r1.status };
      if (r1.status !== 200) {
        guarded.armed = null;
        const r2 = await submit(rt3, token3, sid3);
        (result["case_D"] as Record<string, unknown>)["second_status"] = r2.status;
        expect(r2.status).toBe(200);
      }
      const done = await folderItems(key3);
      expect(done.items).toHaveLength(8);
      expect(new Set(done.items.map((i) => i.name)).size).toBe(8);
      expect(crmPosts.length).toBe(postsBefore + 1);
      (result["case_D"] as Record<string, unknown>)["items_final"] = done.items.map((i) => i.name).sort();
      step("D: upload applied with a lost answer recovered by listing: 8 distinct items, exactly one Request");
      await save();
    }

    // ===== side effects: did anything touch the synthetic Deal after the create? =====
    await sleep(30_000);
    const after = await snapshot();
    result["deal_before"] = before.deal;
    result["deal_after"] = after.deal;
    result["workdrive_write_calls"] = wdWrites.length;
    step("DONE (nothing deleted)");
    await save();
    console.log(`LIVE RESULT: Request ${requestId} (key ${key}); WorkDrive folder ${folder.id}; details in %TEMP%\\s2f_multifile_result.json`);
  }, 900_000);
});
