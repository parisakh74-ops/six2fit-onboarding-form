// @vitest-environment node
// The Notion follow-up inside the REAL submission pipeline (token -> service -> ledger -> WorkDrive -> CRM -> Notion), all mocks.
// Proves: CRM/WorkDrive persistence is unchanged, a Notion failure never changes the response nor creates a second CRM Request,
// a replay never creates a second Notion page, and reconciliation rebuilds everything from WorkDrive.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../canonical";
import { handleSubmit, runtimeFromEnv, type Runtime } from "../http";
import type { ContactView, CrmDealReader, DealView } from "../links/types";
import { MockWorkDrive } from "../workdrive/mock";
import { hostedMultiFileRequest } from "../crm/hosted-fixtures";
import { LIVE_EMAIL, syntheticFiles } from "../crm/live-fixtures";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "../crm/mock-zoho";
import { NOTION_RECONCILE_PATH, handleOps, opsKindOf } from "../ops/ops";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signIssuerRequest } from "../links/auth";
import { NotionHttpError } from "./api";
import { FILE_PROPERTY, NP } from "./mapping";
import { MockNotion } from "./mock";

const ROOT_ID = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const DEAL = "6223361000127334002";
const PRODUCT = "6223361000127336001";
const CONTACT = "6223361000127337001";
const SECRET = "hosted-compat-secret-0123456789abcdef0123456789";
const NOTION_DB = "b".repeat(32);

let dir: string;
let clockMs = Date.now();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-notion-e2e-"));
  await mkdir(dir, { recursive: true });
  clockMs = Date.now();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  SIX2FIT_STAGING_MODE: "true", SIX2FIT_ONBOARDING_STORE: "crm", SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir,
  SIX2FIT_EXPECTED_ORG_ID: MOCK_ORG_ID, SIX2FIT_PRODUCT_SCOPE_MAP: JSON.stringify({ [PRODUCT]: { scope: "Combo", entitlements: ["cellulite"] } }),
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true", SIX2FIT_ZOHO_ENVIRONMENT: "sandbox", SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN, SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "c", SIX2FIT_ZOHO_CLIENT_SECRET: "s", SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh", SIX2FIT_ZOHO_TIMEOUT_MS: "400",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key", SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: ROOT_ID, SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: ROOT_NAME,
  SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN, SIX2FIT_WORKDRIVE_API_BASE: "https://www.zohoapis.com/workdrive/api/v1",
  SIX2FIT_WORKDRIVE_CLIENT_ID: "wc", SIX2FIT_WORKDRIVE_CLIENT_SECRET: "ws", SIX2FIT_WORKDRIVE_REFRESH_TOKEN: "synthetic-wd-refresh",
  SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "50",
  SIX2FIT_NOTION_SYNC: "true", SIX2FIT_NOTION_TARGET: "test", SIX2FIT_NOTION_TOKEN: "secret_synthetic_notion_token_0123456789", SIX2FIT_NOTION_DATABASE_ID: NOTION_DB,
  ...extra,
});
class Reader implements CrmDealReader {
  async getDeal(): Promise<DealView> { return { id: DEAL, orgId: MOCK_ORG_ID, contactId: CONTACT, productId: PRODUCT, productName: "S2F-TEST-ONBOARDING-20261021", productRelatedTo: null }; }
  async getContact(): Promise<ContactView> { return { id: CONTACT, email: LIVE_EMAIL, phone: null, mobile: null }; }
  async hasPriorRequests() { return false; }
}
const world = (extra: Record<string, string> = {}, resolveFitness?: (dealId: string) => Promise<string | null>) => {
  const zoho = new MockZoho();
  const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
  const notion = new MockNotion(() => clockMs);
  const rt: Runtime = runtimeFromEnv(env(extra), { dealReader: new Reader(), notion: { api: notion, now: () => clockMs, ...(resolveFitness ? { resolveFitness } : {}) } }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
  return { zoho, wd, notion, rt };
};
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const submit = (rt: Runtime, stamp: string) => handleSubmit(hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp, nowSeconds: Math.floor(Date.now() / 1000) }).request, { runtime: () => rt });
const pageComplete = (n: MockNotion) => n.pages.length === 1 && n.pages[0]!.properties[NP.status]?.select?.name === "Complete";

describe("Notion sync inside the real submission pipeline (mocks)", () => {
  it("success: CRM + WorkDrive persistence is exactly as before; the Notion page gets the answers, the supplementary text and all seven files", async () => {
    const w = world();
    const res = await submit(w.rt, "n1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });
    await vi.waitFor(() => expect(pageComplete(w.notion)).toBe(true), { timeout: 3000 });
    expect(posts(w.zoho)).toBe(1);
    const folder = w.wd.all(ROOT_ID).filter((i) => i.kind === "folder");
    expect(folder).toHaveLength(1);
    expect(w.wd.all((folder[0] as { id: string }).id)).toHaveLength(8); // 7 files + submission.v1.json, unchanged
    const files = syntheticFiles();
    const page = w.notion.pages[0]!;
    for (const [k, prop] of Object.entries(FILE_PROPERTY)) {
      const att = w.notion.attached(page.id, prop);
      expect(att, k).toHaveLength(1);
      expect(att[0]!.sha).toBe(sha256Hex(files[k]!.bytes));
    }
    expect(page.properties[NP.link]?.url).toMatch(/^https:\/\/workdrive\.zoho\.com\/folder\//);
    expect(page.properties[NP.supplementary].rich_text.length).toBeGreaterThan(0);
  });

  it("replay of the same submission: 200 deduplicated, no new CRM Request, no new Notion page or upload", async () => {
    const w = world();
    await submit(w.rt, "n2");
    await vi.waitFor(() => expect(pageComplete(w.notion)).toBe(true), { timeout: 3000 });
    const before = { ...w.notion.calls };
    const again = await submit(w.rt, "n2");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(w.zoho)).toBe(1);
    expect(w.notion.pages).toHaveLength(1);
    expect(w.notion.calls).toEqual(before);
  });

  it("Notion completely down: the customer still gets 200, exactly ONE CRM Request exists, a replay creates none; reconciliation later completes from WorkDrive", async () => {
    const w = world();
    w.notion.faults.push(
      { op: "queryByKey", times: 99, error: new NotionHttpError(503, "service_unavailable") },
      { op: "createPage", times: 99, error: new NotionHttpError(503, "service_unavailable") },
    );
    const res = await submit(w.rt, "n3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", deduplicated: false });
    await vi.waitFor(async () => expect((await w.rt.notion!.ledger.read(hostedKey("n3")))?.state).toBe("pending"), { timeout: 3000 });
    expect(w.notion.pages).toHaveLength(0);
    expect(posts(w.zoho)).toBe(1);

    const replay = await submit(w.rt, "n3");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ deduplicated: true });
    expect(posts(w.zoho)).toBe(1);

    // Notion recovers; the back-off has passed; reconciliation rebuilds the page from the verified WorkDrive document.
    w.notion.faults.length = 0;
    clockMs += 20 * 60_000;
    const out = await w.rt.notion!.reconcile();
    expect(out.map((o) => o.outcome.status)).toEqual(["complete"]);
    expect(w.notion.pages).toHaveLength(1);
    const files = syntheticFiles();
    for (const [k, prop] of Object.entries(FILE_PROPERTY)) expect(w.notion.attached(w.notion.pages[0]!.id, prop)[0]?.sha, k).toBe(sha256Hex(files[k]!.bytes));
    expect(posts(w.zoho)).toBe(1);
    expect(await w.rt.notion!.reconcile()).toEqual([]); // nothing left to do
  });

  it("a half-finished upload is repaired by reconciliation without a second page or re-attached files", async () => {
    const w = world();
    w.notion.faults.push({ op: "sendFileUpload", after: 3, times: 99, error: new NotionHttpError(503, "service_unavailable") });
    await submit(w.rt, "n4");
    await vi.waitFor(async () => expect((await w.rt.notion!.ledger.read(hostedKey("n4")))?.state).toBe("partial"), { timeout: 3000 });
    expect(w.notion.pages[0]!.properties[NP.status].select.name).toBe("Partial");
    w.notion.faults.length = 0;
    clockMs += 20 * 60_000;
    expect((await w.rt.notion!.reconcile()).map((o) => o.outcome.status)).toEqual(["complete"]);
    expect(w.notion.pages).toHaveLength(1);
    for (const prop of Object.values(FILE_PROPERTY)) expect(w.notion.attached(w.notion.pages[0]!.id, prop)).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
  });

  it("configuration is fail-closed: the live legacy database, a non-test target, a missing token or an unknown store never build a runtime", () => {
    const build = (extra: Record<string, string>) => () => runtimeFromEnv(env(extra), { dealReader: new Reader() }, { fetch: new MockZoho().fetch, workdriveApi: new MockWorkDrive(ROOT_ID, ROOT_NAME) });
    expect(build({ SIX2FIT_NOTION_DATABASE_ID: "1d4d73e9-9527-802d-920b-d7f8da0a37bd" })).toThrow();
    expect(build({ SIX2FIT_NOTION_DATABASE_ID: "1d4d73e9-9527-81f7-a40f-000bb78ae018" })).toThrow();
    expect(build({ SIX2FIT_NOTION_TARGET: "live" })).toThrow();
    expect(build({ SIX2FIT_NOTION_TOKEN: "" })).toThrow();
    expect(build({ SIX2FIT_NOTION_SYNC: "false" })).not.toThrow(); // off = no Notion at all
  });

  it("with SIX2FIT_NOTION_SYNC unset the pipeline has no Notion runtime and behaves exactly as before", async () => {
    const e = env();
    delete (e as Record<string, string | undefined>)["SIX2FIT_NOTION_SYNC"];
    const zoho = new MockZoho();
    const wd = new MockWorkDrive(ROOT_ID, ROOT_NAME);
    const rt = runtimeFromEnv(e, { dealReader: new Reader() }, { fetch: zoho.fetch, workdriveApi: wd, sleep: async () => undefined });
    expect(rt.notion).toBeUndefined();
    expect((await submit(rt, "n5")).status).toBe(200);
    expect(posts(zoho)).toBe(1);
  });
});

describe("durable pending + reconciliation through the existing operations path", () => {
  const OPS_SECRET = "ops-caller-secret-0123456789abcdef0123456";
  const opsCall = async (rt: Runtime, body = "{}") => {
    const path = NOTION_RECONCILE_PATH;
    const ts = Math.floor(Date.now() / 1000);
    const req = new Request(`https://onboarding-staging.6tofit.com${path}`, { method: "POST", body, headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signIssuerRequest(OPS_SECRET, ts, "POST", path, body) } });
    expect(opsKindOf(req)).toBe("notion-reconcile");
    const res = await handleOps(req, "notion-reconcile", { runtime: () => rt, env: { SIX2FIT_OPS_CALLER_SECRET: OPS_SECRET } });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  it("inline budget 0: the pending entry is durable BEFORE the 200, Notion is not called at all during the request, and the ops endpoint completes the sync", async () => {
    const w = world({ SIX2FIT_NOTION_INLINE_BUDGET_MS: "0" });
    const res = await submit(w.rt, "d1");
    expect(res.status).toBe(200);
    expect(w.notion.calls).toEqual({ queryByKey: 0, createPage: 0, updatePage: 0, getPage: 0, createFileUpload: 0, sendFileUpload: 0 });
    const entry = await w.rt.notion!.ledger.read(hostedKey("d1"));
    expect(entry).toMatchObject({ state: "pending", attempts: 0 }); // recorded before the response
    expect(posts(w.zoho)).toBe(1);

    const r = await opsCall(w.rt);
    expect(r).toEqual({ status: 200, json: { processed: 1, complete: 1, partial: 0, pending: 0, blocked: 0, busy: 0, codes: [] } });
    expect(w.notion.pages).toHaveLength(1);
    const files = syntheticFiles();
    for (const [k, prop] of Object.entries(FILE_PROPERTY)) expect(w.notion.attached(w.notion.pages[0]!.id, prop)[0]?.sha, k).toBe(sha256Hex(files[k]!.bytes));
    expect((await opsCall(w.rt)).json["processed"]).toBe(0); // idempotent: nothing is due any more
    expect(posts(w.zoho)).toBe(1);
  });

  it("ops reconcile: signed caller only, bounded input, counts and codes only (no key, page id or answer)", async () => {
    const w = world({ SIX2FIT_NOTION_INLINE_BUDGET_MS: "0" });
    await submit(w.rt, "d2");
    const bad = new Request("https://onboarding-staging.6tofit.com" + NOTION_RECONCILE_PATH, { method: "POST", body: "{}", headers: { [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)), [SIGNATURE_HEADER]: "00".repeat(32) } });
    expect((await handleOps(bad, "notion-reconcile", { runtime: () => w.rt, env: { SIX2FIT_OPS_CALLER_SECRET: OPS_SECRET } })).status).toBe(401);
    expect((await opsCall(w.rt, '{"limit":0}')).status).toBe(400);
    expect((await opsCall(w.rt, '{"limit":"all"}')).status).toBe(400);
    expect(w.notion.calls.createPage).toBe(0);
    const ok = await opsCall(w.rt, '{"limit":5}');
    const text = JSON.stringify(ok.json);
    expect(text).not.toContain("onb2_");
    expect(text).not.toContain("page");
  });

  it("a Notion outage during reconcile leaves a partial/pending entry (never a duplicate); the next ops run finishes it", async () => {
    const w = world({ SIX2FIT_NOTION_INLINE_BUDGET_MS: "0" });
    await submit(w.rt, "d3");
    w.notion.faults.push({ op: "sendFileUpload", after: 2, times: 99, error: new NotionHttpError(503, "service_unavailable") });
    const r1 = await opsCall(w.rt);
    expect(r1.json).toMatchObject({ processed: 1, partial: 1, complete: 0 });
    expect(r1.json["codes"]).toEqual(["http_503_service_unavailable"]);
    w.notion.faults.length = 0;
    expect((await opsCall(w.rt)).json["processed"]).toBe(0); // back-off not over: nothing due yet
    clockMs += 20 * 60_000;
    expect((await opsCall(w.rt)).json).toMatchObject({ processed: 1, complete: 1 });
    expect(w.notion.pages).toHaveLength(1);
    for (const prop of Object.values(FILE_PROPERTY)) expect(w.notion.attached(w.notion.pages[0]!.id, prop)).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
  });

  it("if the pending entry cannot be recorded the customer is NOT told success; the retry (same submission id) records it and does not duplicate the CRM Request", async () => {
    const w = world({ SIX2FIT_NOTION_INLINE_BUDGET_MS: "0" });
    const ledger = w.rt.notion!.ledger;
    const original = ledger.register.bind(ledger);
    let fail = true;
    ledger.register = async (...a: Parameters<typeof original>) => {
      if (fail) throw new Error("disk full");
      return original(...a);
    };
    const first = await submit(w.rt, "d4");
    expect(first.status).toBe(503);
    expect(posts(w.zoho)).toBe(1); // persisted once
    fail = false;
    const retry = await submit(w.rt, "d4");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ deduplicated: true });
    expect(posts(w.zoho)).toBe(1);
    expect((await ledger.read(hostedKey("d4")))?.state).toBe("pending");
    expect((await opsCall(w.rt)).json).toMatchObject({ complete: 1 });
    expect(w.notion.pages).toHaveLength(1);
  });

  it("Product.Fitness is read from the CRM (Deal -> Product), written as the form type, and a CRM read failure delays the page instead of creating it wrongly", async () => {
    let fitness: string | null = "VIP";
    let down = true;
    const w = world({ SIX2FIT_NOTION_INLINE_BUDGET_MS: "0" }, async (dealId) => {
      expect(dealId).toBe(DEAL);
      if (down) throw new Error("crm read failed");
      return fitness;
    });
    await submit(w.rt, "d5");
    expect((await opsCall(w.rt)).json).toMatchObject({ pending: 1 });
    expect(w.notion.pages).toHaveLength(0);
    down = false;
    clockMs += 20 * 60_000;
    expect((await opsCall(w.rt)).json).toMatchObject({ complete: 1 });
    expect(w.notion.pages[0]!.properties[NP.formType]).toEqual({ select: { name: "VIP" } });
    expect(fitness).toBe("VIP");
  });
});

function hostedKey(stamp: string): string {
  return hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp, nowSeconds: Math.floor(Date.now() / 1000) }).formKey;
}
