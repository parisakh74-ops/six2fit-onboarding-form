// @vitest-environment node
// OPERATOR-RUN live test against the isolated Notion TEST database (synthetic data only). Skipped unless explicitly enabled:
//   S2F_NOTION_LIVE=1, S2F_NOTION_CONFIRM=S2F-TEST-NOTION-20261024, SIX2FIT_NOTION_TARGET=test, SIX2FIT_NOTION_TOKEN, SIX2FIT_NOTION_DATABASE_ID
// The token comes from the process environment only and is never printed. The live legacy database is refused by loadNotionConfig.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { syntheticFiles, syntheticMultiFileAnswers } from "../crm/live-fixtures";
import { validateSubmission } from "../validate";
import { KEY_PROPERTY } from "./api";
import { loadNotionConfig } from "./config";
import { HttpNotionApi } from "./http-api";
import { NotionSyncLedger } from "./ledger";
import { FILE_PROPERTY, NP, buildNotionPayload, type NotionSubmission } from "./mapping";
import { NotionSync } from "./sync";

const ON = process.env["S2F_NOTION_LIVE"] === "1" && process.env["S2F_NOTION_CONFIRM"] === "S2F-TEST-NOTION-20261024";
const result: Record<string, unknown> = {};

describe.skipIf(!ON)("Notion TEST database (live, synthetic)", () => {
  afterAll(async () => {
    await writeFile(join(tmpdir(), "s2f_notion_live_result.json"), JSON.stringify(result, null, 2));
  });

  it("preflight: integration identity, workspace upload limit, access to ONLY the test database, schema matches the mapper", async () => {
    const config = loadNotionConfig(process.env);
    const h = { Authorization: `Bearer ${config.token}`, "Notion-Version": config.version };
    const me = (await (await fetch(`${config.baseUrl}/v1/users/me`, { headers: h })).json()) as { type?: string; bot?: { workspace_limits?: { max_file_upload_size_in_bytes?: number } } };
    result["integrationType"] = me.type ?? null;
    result["maxFileUploadBytes"] = me.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? null;
    const db = (await (await fetch(`${config.baseUrl}/v1/databases/${config.databaseId}`, { headers: h })).json()) as { object?: string; properties?: Record<string, { type: string }> };
    expect(db.object).toBe("database");
    const types: Record<string, string> = Object.fromEntries(Object.entries(db.properties ?? {}).map(([k, v]) => [k, v.type]));
    const sample = buildNotionPayload({ uniqueFormKey: "onb2_preflight00000000", scope: "Combo", entitlements: ["cellulite"], answers: {}, submittedAt: new Date().toISOString(), files: [] });
    for (const name of [...Object.keys(sample.properties), ...Object.values(FILE_PROPERTY)]) expect(types[name], `missing property ${JSON.stringify(name)}`).toBeDefined();
    for (const prop of Object.values(FILE_PROPERTY)) expect(types[prop]).toBe("files");
    // The live legacy database must NOT be reachable with this integration.
    const live = await fetch(`${config.baseUrl}/v1/databases/1d4d73e9-9527-802d-920b-d7f8da0a37bd`, { headers: h });
    result["liveDatabaseHttpStatus"] = live.status;
    expect(live.status).not.toBe(200);
    result["largestFormFileBytes"] = 20 * 1024 * 1024;
  }, 60_000);

  it("creates one page with answers + seven native uploads, then a replay and a second run create nothing", async () => {
    const config = loadNotionConfig(process.env);
    const dir = await mkdtemp(join(tmpdir(), "s2f-notion-live-"));
    try {
      const log: string[] = [];
      const api = new HttpNotionApi({ fetch, token: config.token, baseUrl: config.baseUrl, version: config.version, timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts, minIntervalMs: config.minIntervalMs, log: (e) => log.push(e) });
      const ledger = new NotionSyncLedger(join(dir, "notion-ledger"), config.leaseMs);
      const sync = new NotionSync(api, ledger, { databaseId: config.databaseId, uploadMaxAgeMs: config.uploadMaxAgeMs, log: (e) => log.push(e) });

      const files = syntheticFiles();
      const raw = { ...syntheticMultiFileAnswers() };
      const fi = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { name: f.name, type: f.type, size: f.bytes.length, head: f.bytes.slice(0, 16) }]));
      const v = validateSubmission(raw, fi, { scope: "Combo", entitlements: ["cellulite"] });
      if (!v.ok) throw new Error("synthetic fixture invalid");
      const stamp = sha256Hex(`notion-live:${Date.now()}`).slice(0, 24);
      const key = `onb2_${stamp}`;
      const sub: NotionSubmission = {
        uniqueFormKey: key, scope: "Combo", entitlements: ["cellulite"], answers: v.answers, submittedAt: new Date().toISOString(),
        files: v.files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: sha256Hex(files[f.key]!.bytes) })),
      };
      const src = { fileBytes: async (k: string) => files[k]!.bytes };
      const t0 = Date.now();
      const first = await sync.sync(sub, "a".repeat(64), src);
      result["first"] = { status: first.status, code: first.code ?? null, ms: Date.now() - t0 };
      expect(first).toEqual({ status: "complete" });

      const pages = await api.queryByKey(config.databaseId, key);
      expect(pages).toHaveLength(1);
      const page = await api.getPage(pages[0]!.id);
      const props = page.properties as Record<string, any>;
      const expected = buildNotionPayload(sub);
      const text = (p: any) => (p?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content).join("");
      expect(text(props[NP.supplementary])).toBe(expected.supplementary); // exact preservation
      expect(props[NP.status].select.name).toBe("Complete");
      const attached: Record<string, string> = {};
      for (const f of expected.files) {
        const entries = props[f.property]?.files ?? [];
        expect(entries, f.property).toHaveLength(1);
        expect(entries[0].name).toBe(f.filename);
        expect(entries[0].type).toBe("file");
        // The hosted Notion file must be the exact bytes (downloaded from the signed URL; the URL itself is not recorded).
        const bytes = new Uint8Array(await (await fetch(entries[0].file.url)).arrayBuffer());
        expect(sha256Hex(bytes)).toBe(f.sha256);
        attached[f.key] = "sha256-verified";
      }
      result["files"] = attached;
      result["pagesForKey"] = pages.length;
      void KEY_PROPERTY;
      void FILE_PROPERTY;

      const calls = log.length;
      expect(await sync.sync(sub, "a".repeat(64), src)).toEqual({ status: "complete" }); // ledger replay: no call
      expect(log.length).toBe(calls);
      // A fresh ledger (lost state) must still find the page by key and not create a second one.
      const sync2 = new NotionSync(api, new NotionSyncLedger(join(dir, "notion-ledger-2"), config.leaseMs), { databaseId: config.databaseId, uploadMaxAgeMs: config.uploadMaxAgeMs });
      expect((await sync2.sync(sub, "a".repeat(64), src)).status).toBe("complete");
      expect(await api.queryByKey(config.databaseId, key)).toHaveLength(1);
      result["replayNoDuplicate"] = true;
      result["rateLimitEvents"] = log.filter((e) => e === "notion.rate_limited").length;
      result["pageId"] = pages[0]!.id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
