// @vitest-environment node
// LIVE Sandbox + WorkDrive test: ONE synthetic single-file Onboarding submission through the REAL runtime
// (handleSubmit -> service -> ledger -> WorkDrive staging -> Requests create), linked to the EXISTING synthetic Deal.
// PREPARED, NOT EXECUTED. Operator-run only (tools/s2f-sandbox-workdrive-test.ps1). Credentials only from the process environment.
// Synthetic data only (marker S2F-TEST-ONBOARDING-20261021, non-routable e-mail, a generated pseudo-image). Nothing is deleted.
//
// Guards (all required): S2F_LIVE_WD=1, S2F_LIVE_CONFIRM=S2F-TEST-ONBOARDING-20261021, S2F_LIVE_DEAL_ID (Sandbox Deal id),
// S2F_LIVE_PRODUCT_ID (the Deal's synthetic Product id), sandbox + org 850673613 + Sandbox id prefix, persistence workdrive-key,
// WorkDrive root title matching /^S2F-.*TEST/, WorkDrive API base https://www.zohoapis.<dc>/workdrive/api/v1, automations NOT enabled.
// Optional: S2F_LIVE_RECOVERY=1 adds a second NEW Request with an injected WorkDrive failure and a resumed retry.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { JPEG_HEAD, validAnswers } from "../fixtures";
import { handleSubmit, runtimeFromEnv, type Runtime } from "../http";
import { signLinkToken, uniqueFormKey, verifyLinkToken } from "../tokens";
import { WdHttpError, type WdItem, type WorkDriveApi } from "../workdrive/api";
import { DOCUMENT_NAME } from "../workdrive/storage";
import { ZohoClient } from "./client";
import { loadCrmConfig } from "./config";

const env = process.env as Record<string, string | undefined>;
const MARK = "S2F-TEST-ONBOARDING-20261021";
const EMAIL = "s2f-test-onboarding-20261021@s2f-test.example.invalid";
const DEAL = (env["S2F_LIVE_DEAL_ID"] ?? "").trim();
const PRODUCT = (env["S2F_LIVE_PRODUCT_ID"] ?? "").trim();
const LIVE =
  env["S2F_LIVE_WD"] === "1" &&
  env["S2F_LIVE_CONFIRM"] === MARK &&
  /^6223361000\d{9}$/.test(DEAL) &&
  /^6223361000\d{9}$/.test(PRODUCT) &&
  env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox" &&
  env["SIX2FIT_ZOHO_ORG_ZGID"] === "850673613" &&
  env["SIX2FIT_ZOHO_MODULE_ID_PREFIX"] === "6223361000" &&
  env["SIX2FIT_ONBOARDING_CRM_PERSISTENCE"] === "workdrive-key" &&
  /^S2F-[A-Z0-9-]*TEST/.test(env["SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME"] ?? "") &&
  /^https:\/\/www\.zohoapis\.[a-z.]+\/workdrive\/api\/v1$/.test(env["SIX2FIT_WORKDRIVE_API_BASE"] ?? "") &&
  env["SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS"] !== "true";

const WD_WRITE_CAP = 12; // folder creations + uploads for the whole run
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Failure injection at the adapter boundary: the Nth upload either never leaves ("not-sent") or is applied and its answer is lost. */
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

describe.skipIf(!LIVE)("LIVE Sandbox + WorkDrive: single-file synthetic submission", () => {
  it("uploads, verifies integrity, creates a NEW Request, reads it back, and proves duplicate prevention (and recovery)", async () => {
    const result: Record<string, unknown> = { marker: MARK, steps: [] as string[] };
    const step = (s: string) => (result["steps"] as string[]).push(s);
    const save = async () => writeFile(join(process.env["TEMP"] ?? tmpdir(), "s2f_workdrive_test_result.json"), JSON.stringify(result, null, 2));

    // --- recording fetches: what really leaves this process (paths, methods, trigger values; never bodies of other calls) ---
    const crmPosts: Array<{ path: string; trigger: unknown }> = [];
    const wdWrites: string[] = [];
    const crmFetch = (async (url: string, init: { method: string; body?: string }) => {
      const u = new URL(url);
      if (init.method === "POST" && /\/crm\/v8\/Requests$/.test(u.pathname)) crmPosts.push({ path: u.pathname, trigger: (JSON.parse(init.body ?? "{}") as Record<string, unknown>)["trigger"] });
      return (globalThis.fetch as unknown as (a: string, b: unknown) => Promise<Response>)(url, init);
    }) as never;
    const wdFetch = (async (url: string, init: { method?: string }) => {
      const u = new URL(url);
      if ((init.method ?? "GET") === "POST" && (u.pathname.endsWith("/files") || u.pathname.endsWith("/upload"))) {
        wdWrites.push(`${u.pathname.split("/").pop()}`);
        if (wdWrites.length > WD_WRITE_CAP) throw new Error("STOP: WorkDrive write budget exceeded");
      }
      return (globalThis.fetch as unknown as (a: string, b: unknown) => Promise<Response>)(url, init);
    }) as never;

    // --- the REAL runtime (real OAuth token provider, real WorkDrive, real CRM, real read-only Deal reader) ---
    const dir = await mkdtemp(join(tmpdir(), "s2f-wd-live-"));
    await mkdir(dir, { recursive: true });
    const secret = randomBytes(24).toString("hex");
    const runtimeEnv: Record<string, string | undefined> = {
      ...env,
      SIX2FIT_STAGING_MODE: "true",
      SIX2FIT_ONBOARDING_STORE: "crm",
      SIX2FIT_ONBOARDING_TOKEN_SECRET: secret,
      SIX2FIT_STAGING_STORAGE_DIR: dir,
      SIX2FIT_EXPECTED_ORG_ID: "850673613",
      SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [] } }),
      SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "60000",
    };
    const build = (workdriveApi?: WorkDriveApi): Runtime => runtimeFromEnv(runtimeEnv, {}, { fetch: crmFetch, workdriveFetch: wdFetch, ...(workdriveApi ? { workdriveApi } : {}) });
    const rt = build();
    const crm = rt.ops?.crm;
    expect(crm?.persistence).toBe("workdrive-key");
    expect(crm?.sink.deferred).toBe(true); // uploads stay in memory: never on the local disk
    const wd = crm?.workdrive;
    if (!wd || !crm?.lookup) throw new Error("WorkDrive runtime missing");

    // READINESS (read-only): the WorkDrive grant authenticates and the root is exactly the approved test folder.
    await wd.storage.verifyRootFolder();
    step("WorkDrive OAuth refresh + root folder title verified");

    const config = loadCrmConfig(runtimeEnv);
    const client = new ZohoClient(config, { fetch: crmFetch, now: () => Date.now(), sleep });
    const getRequest = async (id: string) => {
      const r = await client.request("GET", `/Requests/${id}`, { query: { fields: "uniqueformkey,Deal,Email,Form_Complete,Onboarding_Scope,Request_Status,Submission_Id,Form_Version,Is_First_Request" } });
      const d = isObj(r.json) && Array.isArray(r.json["data"]) ? (r.json["data"][0] as Record<string, unknown>) : {};
      return d;
    };
    const waitLookup = async (key: string): Promise<string> => {
      for (let i = 0; i < 14; i += 1) {
        const id = await crm.lookup!.lookupId(key).catch(() => null);
        if (id) return id;
        await sleep(5000); // the CRM search index lags a create by ~20 s
      }
      throw new Error("Request not found by uniqueformkey after 70 s");
    };

    const answers = validAnswers("Combo", { "ON-01": "S2F-TEST Synthetic", "ON-07": EMAIL, "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    const fileBytes = new Uint8Array(4096);
    fileBytes.set(JPEG_HEAD);
    for (let i = 16; i < fileBytes.length; i += 1) fileBytes[i] = (i * 37 + 11) & 0xff; // deterministic pseudo-image, no real content
    const fileHash = sha256Hex(fileBytes);

    const link = (jti: string) => signLinkToken({ v: 2, deal_id: DEAL, jti, scope: "Combo", entitlements: [], exp: Math.floor(Date.now() / 1000) + 24 * 3600, is_first_request: true, product_related_to: MARK }, secret);
    const request = (token: string, sid: string, over: Record<string, string> = {}) => {
      const form = new FormData();
      form.append("form_session_token", token);
      form.append("submission_id", sid);
      form.append("verification_state", "{}");
      for (const [k, v] of Object.entries({ ...answers, ...over })) form.append(`answer:${k}`, v);
      form.append("file:MS-05.front", new File([fileBytes as BlobPart], "front.jpg", { type: "image/jpeg" }));
      return new Request("https://onboarding-staging.6tofit.com/api/onboarding/submit", { method: "POST", headers: { "idempotency-key": sid }, body: form });
    };
    const folderItems = async (key: string) => {
      const folders = (await wd.api.list(wd.config.rootFolderId)).filter((i) => i.kind === "folder" && i.name === key);
      expect(folders).toHaveLength(1);
      return { folder: folders[0] as WdItem, items: await wd.api.list((folders[0] as WdItem).id) };
    };

    // ===== A. the main case: one NEW unique Request, one file =====
    const stamp = Date.now().toString(36);
    const jti = `s2ftest${stamp}A${randomBytes(4).toString("hex")}`;
    const token = link(jti);
    const key = uniqueFormKey(verifyLinkToken(token, secret));
    const sid = "aaaaaaaa-bbbb-4ccc-8ddd-" + stamp.padStart(12, "0").slice(-12);
    result["case_A"] = { unique_form_key: key, file_sha256: fileHash };
    const res = await handleSubmit(request(token, sid), { runtime: () => rt });
    const body = (await res.json()) as Record<string, unknown>;
    (result["case_A"] as Record<string, unknown>)["submit"] = { status: res.status, body_code: body["error_code"] ?? body["status"] };
    await save();
    expect(res.status, `submit failed: ${String(body["error_code"])}`).toBe(200);
    expect(body).toMatchObject({ status: "completed", deduplicated: false });
    step("A: submission accepted (200, not deduplicated)");

    // WorkDrive: exactly one folder named by the key; exactly the file + the canonical document; bytes verified by download.
    const { folder, items } = await folderItems(key);
    const names = items.map((i) => i.name).sort();
    const fileItem = items.find((i) => i.name.startsWith("MS-05.front-") && i.name.endsWith(".jpg")) as WdItem;
    const docItem = items.find((i) => i.name === DOCUMENT_NAME) as WdItem;
    expect(items).toHaveLength(2);
    expect(fileItem?.size).toBe(fileBytes.length);
    expect(sha256Hex(await wd.api.download(fileItem.id))).toBe(fileHash); // integrity: the stored bytes are the submitted bytes
    const doc = JSON.parse(new TextDecoder().decode(await wd.api.download(docItem.id))) as Record<string, unknown>;
    expect(doc["unique_form_key"]).toBe(key);
    expect((doc["files"] as Array<Record<string, unknown>>)[0]?.["sha256"]).toBe(fileHash);
    const identity = await wd.storage.readDocumentIdentityByKey(key); // fingerprint recomputed from the stored content
    (result["case_A"] as Record<string, unknown>)["workdrive"] = { folder_id: folder.id, items: names, document_fingerprint: identity.fingerprint };
    step("A: WorkDrive folder, 1 file + canonical document, SHA-256 verified by download, fingerprint recomputed");

    // CRM: exactly one POST (trigger []), the Request is found by key and read back with the right Deal link.
    expect(crmPosts).toHaveLength(1);
    expect(crmPosts[0]?.trigger).toEqual([]);
    const requestId = await waitLookup(key);
    const got = await getRequest(requestId);
    expect(got["uniqueformkey"]).toBe(key);
    expect(isObj(got["Deal"]) && (got["Deal"] as Record<string, unknown>)["id"]).toBe(DEAL);
    expect(got["Email"]).toBe(EMAIL);
    expect(got["Form_Complete"]).toBe(true);
    expect(got["Onboarding_Scope"]).toBe("Combo");
    (result["case_A"] as Record<string, unknown>)["request"] = { id: requestId, posts: crmPosts.length, trigger: crmPosts[0]?.trigger, readback: got };
    step("A: Request found by key, read back (Deal link, Email, Form_Complete, scope), one POST with trigger []");

    // no upload on the local disk (only the ledger exists locally)
    const local = (await readdir(dir)).filter((n) => !["onboarding-ledger", "payments", "issued-links"].includes(n));
    expect(local).toEqual([]);
    step("A: no upload or document on the local disk");
    await save();

    // ===== B. duplicate prevention (after A is unambiguous) =====
    const itemsBefore = items.length;
    const again = await handleSubmit(request(token, sid), { runtime: () => rt });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true });
    expect(crmPosts).toHaveLength(1);
    expect((await folderItems(key)).items).toHaveLength(itemsBefore);
    const uploadsAfterDup = wdWrites.length;
    const conflicting = await handleSubmit(request(token, sid, { "ON-01": "S2F-TEST Different" }), { runtime: () => rt });
    expect(conflicting.status).toBe(409);
    expect(crmPosts).toHaveLength(1);
    expect(wdWrites.length).toBe(uploadsAfterDup); // refused before any upload
    expect((await folderItems(key)).items).toHaveLength(itemsBefore);
    step("B: identical resubmit deduplicated; conflicting resubmit 409; no new upload, folder item or Request POST");
    await save();

    // ===== C. partial-failure recovery (optional): a SECOND new Request, document upload fails once, retry resumes =====
    if (env["S2F_LIVE_RECOVERY"] === "1") {
      const guarded = new Guarded(wd.api);
      guarded.armed = { upload: 2, kind: "not-sent" }; // file uploaded, then the canonical document upload is refused
      const rt2 = build(guarded);
      const token2 = link(`s2ftest${stamp}C${randomBytes(4).toString("hex")}`);
      const key2 = uniqueFormKey(verifyLinkToken(token2, secret));
      const sid2 = "cccccccc-bbbb-4ccc-8ddd-" + stamp.padStart(12, "0").slice(-12);
      const postsBefore = crmPosts.length;
      const first = await handleSubmit(request(token2, sid2), { runtime: () => rt2 });
      expect(first.status).toBe(503); // WorkDrive refused: nothing reached the CRM
      expect(crmPosts.length).toBe(postsBefore);
      const mid = await folderItems(key2);
      expect(mid.items).toHaveLength(1); // the file is already there
      guarded.armed = null;
      const second = await handleSubmit(request(token2, sid2), { runtime: () => rt2 });
      expect(second.status).toBe(200);
      const done = await folderItems(key2);
      expect(done.items).toHaveLength(2); // resumed: the file was reused, only the document was added, nothing duplicated
      expect(done.items.some((i) => /\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(false); // WorkDrive did not rename a duplicate upload
      expect(crmPosts.length).toBe(postsBefore + 1);
      const id2 = await waitLookup(key2);
      result["case_C"] = { unique_form_key: key2, request_id: id2, first_status: first.status, second_status: second.status, items: done.items.map((i) => i.name).sort() };
      step("C: injected WorkDrive failure -> 503, no CRM write; retry resumed, 2 items, exactly one Request");
      await save();
    }

    result["workdrive_write_calls"] = wdWrites.length;
    step("DONE (nothing deleted)");
    await save();
    console.log(`LIVE RESULT: Request ${requestId} (key ${key}); WorkDrive folder ${folder.id}; details in %TEMP%\\s2f_workdrive_test_result.json`);
  }, 600_000);
});
