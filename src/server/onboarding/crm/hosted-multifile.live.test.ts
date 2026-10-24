// @vitest-environment node
// OPERATOR-RUN hosted smoke test: ONE synthetic seven-file (Combo + cellulite) Onboarding submission against the already
// activated Staging application https://onboarding-staging.6tofit.com, plus ONE identical replay (must be deduplicated: no new
// writes). Skipped unless every guard holds. The hosted app writes to the Zoho CA Dev SANDBOX and the WorkDrive test folder; this
// test itself holds no CRM or WorkDrive credential, only the Onboarding link-signing secret (S2F_HOSTED_TOKEN_SECRET, supplied
// at execution time by the operator script from a private local source; never printed, logged or stored here).
//
// Guards (all required): S2F_HOSTED_MF=1, S2F_HOSTED_CONFIRM=S2F-TEST-ONBOARDING-20261021-HOSTED, S2F_HOSTED_HOST = the exact
// Staging origin, S2F_LIVE_DEAL_ID = the synthetic Sandbox Deal (6223361000...), S2F_HOSTED_TOKEN_SECRET (>= 32 characters).
// A failed POST is NEVER retried: its outcome is recorded and the run stops (the hosted ledger makes a later retry safe, but that
// decision belongs to the operator after reading the result file).
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../canonical";
import { loadNotionConfig } from "../notion/config";
import { HttpNotionApi } from "../notion/http-api";
import { FILE_PROPERTY, NP, buildNotionPayload } from "../notion/mapping";
import { HOSTED_CONFIRM, HOSTED_STAGING_HOST, assertHostedTarget, assertSandboxId, hostedMultiFileRequest } from "./hosted-fixtures";

vi.setConfig({ testTimeout: 240_000 });
const env = process.env as Record<string, string | undefined>;
const HOST = (env["S2F_HOSTED_HOST"] ?? "").trim();
const DEAL = (env["S2F_LIVE_DEAL_ID"] ?? "").trim();
const SECRET = (env["S2F_HOSTED_TOKEN_SECRET"] ?? "").trim();
const LIVE =
  env["S2F_HOSTED_MF"] === "1" &&
  env["S2F_HOSTED_CONFIRM"] === HOSTED_CONFIRM &&
  HOST === HOSTED_STAGING_HOST &&
  /^6223361000\d{9}$/.test(DEAL) &&
  SECRET.length >= 32;

const RESULT = (env["S2F_HOSTED_RESULT"] ?? "").trim() || join(tmpdir(), "s2f_hosted_multifile_result.json");
const result: Record<string, unknown> = { started_at: new Date().toISOString(), host: HOST, deal_id: DEAL };
const save = () => {
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(RESULT, JSON.stringify(result, null, 1) + "\n");
};

async function send(label: string, build: () => Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const t0 = Date.now();
  const res = await fetch(build(), { signal: AbortSignal.timeout(180_000) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { non_json_bytes: text.length };
  }
  // Only category-level fields are recorded (never the token, the form content or any header).
  result[label] = { http: res.status, ms: Date.now() - t0, status: body["status"] ?? null, deduplicated: body["deduplicated"] ?? null, error_code: body["error_code"] ?? null };
  save();
  return { status: res.status, body };
}

describe.skipIf(!LIVE)("HOSTED Onboarding Staging: one seven-file Combo + cellulite submission (Sandbox CRM + WorkDrive)", () => {
  it("target and ids are the approved Staging origin and Sandbox ids", () => {
    expect(() => assertHostedTarget(HOST)).not.toThrow();
    expect(() => assertSandboxId(DEAL)).not.toThrow();
  });

  it("H1 one submission completes (hosted app writes the WorkDrive folder, 7 files + document, and ONE Sandbox Request)", async () => {
    const stamp = Date.now().toString(16);
    const nowSeconds = Math.floor(Date.now() / 1000); // fixed for both requests: the replay carries the IDENTICAL token
    const m = hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp, nowSeconds });
    result["submission_id"] = m.submissionId;
    result["unique_form_key"] = m.formKey; // = the WorkDrive folder name and the Request's uniqueformkey
    result["files_sent"] = m.files;
    save();
    const first = await send("first", () => m.request);
    if (first.status !== 200) {
      result["stopped"] = "first submission was not 200: NOT retried; inspect the result file, WorkDrive and the CRM before any retry";
      save();
    }
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "completed", deduplicated: false });

    // One identical replay: same token, same ids, same bytes. Must be deduplicated (no further write).
    const replay = hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp, nowSeconds });
    expect(replay.token).toBe(m.token);
    const again = await send("replay", () => replay.request);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduplicated: true });
    result["finished_at"] = new Date().toISOString();
    save();
  });

  // Optional H2: only when the operator also supplied the Notion TEST integration (hidden prompt in the operator script).
  it.skipIf(!env["SIX2FIT_NOTION_TOKEN"])("H2 the hosted app produced ONE complete Notion TEST page: seven files SHA-256 verified, replay created no second page", async () => {
    const config = loadNotionConfig(env); // refuses a non-test target and the live legacy database
    expect(config.databaseId).toBe("6067e223e3c048e68dbdcf0119cbb3a7");
    const key = String(result["unique_form_key"] ?? "");
    expect(key).toMatch(/^onb2_/);
    const api = new HttpNotionApi({ fetch, token: config.token, baseUrl: config.baseUrl, version: config.version, timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts, minIntervalMs: config.minIntervalMs });
    let page: { id: string; properties: Record<string, any> } | undefined;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const pages = await api.queryByKey(config.databaseId, key);
      expect(pages.length).toBeLessThanOrEqual(1); // never two pages for one submission
      if (pages[0]) {
        const full = await api.getPage(pages[0].id);
        if ((full.properties as Record<string, any>)[NP.status]?.select?.name === "Complete") {
          page = full as typeof page;
          break;
        }
        result["notion_status"] = (full.properties as Record<string, any>)[NP.status]?.select?.name ?? null;
        save();
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    result["notion_complete"] = !!page;
    save();
    expect(page, "Notion page not Complete within 3 minutes: run the reconcile endpoint, do NOT resubmit").toBeDefined();
    const props = page!.properties;
    const files = FILE_PROPERTY;
    const synthetic = (await import("./live-fixtures")).syntheticFiles();
    const verified: string[] = [];
    for (const [k, prop] of Object.entries(files)) {
      const entries = props[prop]?.files ?? [];
      expect(entries, prop).toHaveLength(1);
      const bytes = new Uint8Array(await (await fetch(entries[0].file.url)).arrayBuffer());
      expect(sha256Hex(bytes)).toBe(sha256Hex(synthetic[k]!.bytes));
      verified.push(k);
    }
    expect(String(props[NP.supplementary]?.rich_text?.length ?? 0)).not.toBe("0");
    expect(buildNotionPayload).toBeDefined();
    result["notion_files_verified"] = verified.length;
    result["notion_pages_for_key"] = (await api.queryByKey(config.databaseId, key)).length;
    expect(result["notion_pages_for_key"]).toBe(1);
    save();
  });
});
