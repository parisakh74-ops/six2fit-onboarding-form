// @vitest-environment node
// T07 readiness + T09 reconciliation endpoints. MOCKS ONLY.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "../crm/mock-zoho";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { handleSubmit, runtimeFromEnv, type Runtime } from "../http";
import { IdempotencyLedger } from "../ledger";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signIssuerRequest } from "../links/auth";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { MockWorkDrive } from "../workdrive/mock";
import { RECONCILE_PATH, READINESS_PATH, handleOps, opsKindOf } from "./ops";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const PRODUCT = "6223361000999000001";
const CONTACT = "6223361000127220001";
const OPS_SECRET = "ops-caller-secret-0123456789abcdef0123456";
const HOST = "https://onboarding-staging.6tofit.com";

let dir: string;
let storage: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-ops-"));
  storage = join(dir, "storage");
  await mkdir(storage, { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const ENV = (): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true",
  SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET,
  SIX2FIT_STAGING_STORAGE_DIR: storage,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID,
  SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: [] } }),
  SIX2FIT_OPS_CALLER_SECRET: OPS_SECRET,
  SIX2FIT_ONBOARDING_STORE: "crm",
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "c",
  SIX2FIT_ZOHO_CLIENT_SECRET: "s",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ZOHO_TIMEOUT_MS: "400",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID,
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
  SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.com/workdrive/api/v1",
  SIX2FIT_WORKDRIVE_CLIENT_ID: "wc",
  SIX2FIT_WORKDRIVE_CLIENT_SECRET: "ws",
  SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "synthetic-wd-refresh",
});

class Reader implements CrmDealReader {
  async getDeal(): Promise<DealView> {
    return { id: DEAL_ID, orgId: MOCK_ORG_ID, contactId: CONTACT, productId: PRODUCT, productName: "P", productRelatedTo: "F" };
  }
  async getContact(): Promise<ContactView> {
    return { id: CONTACT, email: "a@example.invalid", phone: null, mobile: null };
  }
  async hasPriorRequests() {
    return false;
  }
}

function world(env: Record<string, string> = ENV(), wd = new MockWorkDrive(ROOT_ID, ROOT_NAME)) {
  const zoho = new MockZoho();
  const rt: Runtime = runtimeFromEnv(env, { dealReader: new Reader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { rt, zoho, wd, env };
}

function signed(path: string, body: string, secret = OPS_SECRET, ts = Math.floor(NOW_MS / 1000)): Request {
  return new Request(`${HOST}${path}`, { method: "POST", body, headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signIssuerRequest(secret, ts, "POST", path, body) } });
}
const call = async (w: ReturnType<typeof world>, path: string, body = "", secret = OPS_SECRET) => {
  const req = signed(path, body, secret);
  const kind = opsKindOf(req);
  if (!kind) throw new Error("not an ops request");
  const res = await handleOps(req, kind, { runtime: () => w.rt, env: w.env });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

async function submitOne(w: ReturnType<typeof world>) {
  const form = new FormData();
  const answers = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
  form.append("form_session_token", dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }));
  form.append("submission_id", "11111111-2222-4333-8444-555555555555");
  form.append("verification_state", "{}");
  for (const [k, v] of Object.entries(answers)) form.append(`answer:${k}`, v);
  const f = jpegFile("a.jpg", 2048);
  form.append("file:MS-05.front", new File([f.bytes as BlobPart], f.name, { type: f.type }));
  return handleSubmit(new Request(`${HOST}/api/onboarding/submit`, { method: "POST", headers: { "idempotency-key": "11111111-2222-4333-8444-555555555555" }, body: form }), { runtime: () => w.rt });
}

describe("operations endpoints: access", () => {
  it("dispatch recognises both spellings; unsigned, wrongly signed, stale and secret-less requests are refused", async () => {
    expect(opsKindOf(new Request(`${HOST}${READINESS_PATH}`, { method: "POST" }))).toBe("readiness");
    expect(opsKindOf(new Request(`${HOST}/?six2fit_api=reconcile`, { method: "POST" }))).toBe("reconcile");
    expect(opsKindOf(new Request(`${HOST}${READINESS_PATH}`, { method: "GET" }))).toBeNull();
    const w = world();
    expect((await call(w, READINESS_PATH, "", "x".repeat(40))).status).toBe(401);
    const stale = signed(READINESS_PATH, "", OPS_SECRET, Math.floor(NOW_MS / 1000) - 3600);
    expect((await handleOps(stale, "readiness", { runtime: () => w.rt, env: w.env })).status).toBe(401);
    const noSecret = { ...w.env, SIX2FIT_OPS_CALLER_SECRET: "short" };
    expect((await handleOps(signed(READINESS_PATH, ""), "readiness", { runtime: () => w.rt, env: noSecret })).status).toBe(503);
    expect((await handleOps(signed(READINESS_PATH, ""), "readiness", { runtime: () => null, env: w.env })).status).toBe(503);
  });
});

describe("T07 readiness", () => {
  it("passes on a healthy mock environment without creating any customer record", async () => {
    const w = world();
    const { status, json } = await call(w, READINESS_PATH);
    expect(status).toBe(200);
    expect(json["checks"].filter((c: any) => c.status === "fail")).toEqual([]);
    expect(json["ok"]).toBe(true);
    expect(json["persistence"]).toBe("workdrive-key");
    expect(w.wd.calls.upload + w.wd.calls.createFolder).toBe(0);
    expect(w.zoho.requests.filter((r) => r.method === "POST" && r.path.endsWith("/Requests"))).toHaveLength(0);
    expect(JSON.stringify(json)).not.toMatch(/synthetic-|OPS_SECRET|ops-caller/);
  });

  it("fails closed and names the problem when the WorkDrive root is not the approved folder", async () => {
    const w = world(ENV(), new MockWorkDrive(ROOT_ID, "SOMETHING-ELSE"));
    const { json } = await call(w, READINESS_PATH);
    expect(json["ok"]).toBe(false);
    expect(json["checks"].find((c: any) => c.name === "workdrive_auth_and_root")).toMatchObject({ status: "fail", code: "WD_INVALID_PARENT" });
  });

  it("fails on environment mismatch and on missing required variables, without echoing values", async () => {
    const env = { ...ENV(), SIX2FIT_EXPECTED_ORG_ID: "111111111", SIX2FIT_PRODUCT_SCOPE_MAP: "" };
    const w = world(env);
    const { json } = await call(w, READINESS_PATH);
    expect(json["ok"]).toBe(false);
    expect(json["checks"].find((c: any) => c.name === "expected_org_matches_crm_config").status).toBe("fail");
    expect(json["checks"].find((c: any) => c.name === "required_environment")).toMatchObject({ status: "fail", detail: "SIX2FIT_PRODUCT_SCOPE_MAP" });
  });
});

describe("T09 reconciliation", () => {
  it("reports matched, orphan and ledger states; a stuck ledger entry is surfaced; nothing is written", async () => {
    const w = world();
    expect((await submitOne(w)).status).toBe(200);
    const folder = w.wd.all(ROOT_ID).find((i) => i.kind === "folder") as { name: string };
    w.wd.plant(ROOT_ID, "onb2_6223361000127220099_orphanlink0123456789", "folder");
    const ledger = new IdempotencyLedger(join(storage, "onboarding-ledger"));
    await ledger.claim({ v: 1, id: "onb_" + "b".repeat(40), gen: 1, fp: "f".repeat(64), uk: "onb2_6223361000127220055_stuck0123456789abc", state: "needs_review", attempts: 1, started: NOW_MS - 1e6, updated: NOW_MS - 1e6, code: "UNRESOLVED_OUTCOME" });
    const { status, json } = await call(w, RECONCILE_PATH, JSON.stringify({ keys: [folder.name, "onb2_6223361000127220077_missing0123456789"] }));
    expect(status).toBe(200);
    const byKey = Object.fromEntries(json["workdrive"].entries.map((e: any) => [e.key, e.status]));
    expect(byKey[folder.name]).toBe("matched");
    expect(byKey["onb2_6223361000127220077_missing0123456789"]).toBe("crm_without_folder");
    expect(byKey["onb2_6223361000127220099_orphanlink0123456789"]).toBe("orphan_workdrive");
    expect(json["ledger"]["by_state"]).toMatchObject({ created: 1, needs_review: 1 });
    expect(json["ledger"]["needs_attention"]).toEqual([expect.objectContaining({ key: "onb2_6223361000127220055_stuck0123456789abc", state: "needs_review", code: "UNRESOLVED_OUTCOME" })]);
    expect(w.wd.calls.upload).toBe(2); // only the submission's own writes (file + document): reconciliation added none
  });

  it("validates the key list (shape, size) and does not run for a malformed request", async () => {
    const w = world();
    expect((await call(w, RECONCILE_PATH, JSON.stringify({ keys: ["../../etc/passwd"] }))).status).toBe(400);
    expect((await call(w, RECONCILE_PATH, JSON.stringify({ keys: "x" }))).status).toBe(400);
    expect((await call(w, RECONCILE_PATH, "{not json")).status).toBe(400);
    expect(w.wd.calls.list).toBe(0);
  });
});
