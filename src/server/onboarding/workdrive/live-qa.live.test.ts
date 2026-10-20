// @vitest-environment node
// LIVE QA against the approved isolated WorkDrive test folder. Skipped unless S2F_LIVE_QA=1 and S2F_WD_TOKEN are set
// (the token is injected by the operator's wrapper and is never printed). Synthetic data only; no deletes, no overwrites.
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../canonical";
import type { SubmissionRecord } from "../ports";
import type { WdItem } from "./api";
import { HttpWorkDriveApi } from "./http-api";
import { WorkDriveSubmissionStorage, buildDocument } from "./storage";

const LIVE = process.env["S2F_LIVE_QA"] === "1" && Boolean(process.env["S2F_WD_TOKEN"]);
const ROOT = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const BASE = "https://www.zohoapis.com/workdrive/api/v1";

describe.skipIf(!LIVE)("WorkDrive adapter LIVE QA (sequential, synthetic)", () => {
  it("S1-S6", async () => {
    const calls: string[] = [];
    const recFetch = async (url: string, init?: { method?: string }) => {
      const res = await fetch(url, init as RequestInit);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname.replace(/\/[0-9a-z]{30,}/g, "/<id>")} -> ${res.status}`);
      return res;
    };
    const api = new HttpWorkDriveApi({ fetch: recFetch as never, accessToken: async () => process.env["S2F_WD_TOKEN"] as string, baseUrl: BASE, timeoutMs: 30_000 });
    const logs: string[] = [];
    const storage = new WorkDriveSubmissionStorage(api, { rootFolderId: ROOT, rootFolderName: ROOT_NAME }, (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`));
    const ev: string[] = [];
    const say = (s: string) => ev.push(s);
    const names = (xs: WdItem[]) => xs.map((x) => `${x.name} [${x.id}] ${x.kind} ${x.size}B`);

    const stamp = Date.now().toString(36);
    const key = `onb2_QALIVE_${stamp}`;
    const record: SubmissionRecord = {
      subject_key: `onb_${sha256Hex(key).slice(0, 40)}`,
      unique_form_key: key,
      fingerprint: sha256Hex(`fp-${key}-A`),
      scope: "Combo",
      subject: { kind: "deal", dealId: "0000000000000000000" } as SubmissionRecord["subject"],
      link_id: `link_qa_${stamp}`,
      entitlements: [],
      answers: { "QA-01": "synthetic answer", "QA-02": "synthetic persian answer: سلام" },
      verification_state: {},
      files: [],
      submitted_at: new Date().toISOString(),
    };

    say(`TEST ID (unique_form_key): ${key}`);
    const rootBefore = await api.list(ROOT);
    say(`root children BEFORE (${rootBefore.length}): ${names(rootBefore).join(" | ")}`);
    const legacy = rootBefore.find((i) => i.name === "onb2_TEST_0001");
    const legacyBefore = legacy ? await api.list(legacy.id) : [];
    say(`existing onb2_TEST_0001 children BEFORE (read-only): ${legacyBefore.length}`);

    // S1 first upload
    const staged = await storage.stage(record, {});
    const folder = (await api.list(ROOT)).filter((i) => i.name === key);
    expect(folder).toHaveLength(1);
    const folderId = (folder[0] as WdItem).id;
    const listing1 = await api.list(folderId);
    say(`S1 staged: folder ${folderId}, documentRef ${staged.documentRef}; listing right after: ${names(listing1).join(" | ")}`);
    expect(listing1).toHaveLength(1);

    // S2/S3 metadata + download + SHA-256
    const docId = staged.documentRef.replace(/^wd:/, "");
    const meta = await api.getItem(docId);
    const bytes = await api.download(docId);
    const expected = new TextEncoder().encode(canonicalJson(buildDocument(record, staged.files)));
    say(`S2 metadata: name=${meta.name} size=${meta.size} parent_is_test_folder=${meta.parent_id === folderId}`);
    say(`S3 sha256 downloaded=${sha256Hex(bytes)} expected=${sha256Hex(expected)} match=${sha256Hex(bytes) === sha256Hex(expected)}; bytes=${bytes.length}`);
    expect(sha256Hex(bytes)).toBe(sha256Hex(expected));
    expect(meta.parent_id).toBe(folderId);

    // S4 identical retry
    const beforeRetry = (await api.list(folderId)).length;
    const uploadsBefore = calls.filter((c) => c.startsWith("POST") && c.includes("/upload")).length;
    const again = await storage.stage(record, {});
    const afterRetry = await api.list(folderId);
    const uploadsAfter = calls.filter((c) => c.startsWith("POST") && c.includes("/upload")).length;
    say(`S4 retry: same documentRef=${again.documentRef === staged.documentRef}; files before=${beforeRetry} after=${afterRetry.length}; upload calls during retry=${uploadsAfter - uploadsBefore}`);
    expect(again.documentRef).toBe(staged.documentRef);
    expect(afterRetry).toHaveLength(beforeRetry);
    expect(uploadsAfter - uploadsBefore).toBe(0);

    // S5 same identifier, different content
    const conflicting: SubmissionRecord = { ...record, fingerprint: sha256Hex(`fp-${key}-B`), answers: { "QA-01": "DIFFERENT synthetic answer" } };
    const uploadsBeforeC = calls.filter((c) => c.startsWith("POST") && c.includes("/upload")).length;
    const outcome = await storage.stage(conflicting, {}).then(
      () => "ACCEPTED (unexpected)",
      (e: unknown) => `REJECTED kind=${(e as { kind?: string }).kind} code=${(e as { code?: string }).code}`,
    );
    const afterConflict = await api.list(folderId);
    const bytes2 = await api.download(docId);
    say(`S5 conflict: ${outcome}; files=${afterConflict.length}; upload calls=${calls.filter((c) => c.startsWith("POST") && c.includes("/upload")).length - uploadsBeforeC}; document unchanged=${sha256Hex(bytes2) === sha256Hex(expected)}`);
    expect(outcome).toContain("WD_SUBMISSION_CONFLICT");
    expect(afterConflict).toHaveLength(beforeRetry);
    expect(sha256Hex(bytes2)).toBe(sha256Hex(expected));

    // S6 listing after
    const rootAfter = await api.list(ROOT);
    const legacyAfter = legacy ? await api.list(legacy.id) : [];
    say(`S6 root children AFTER (${rootAfter.length}): ${names(rootAfter).join(" | ")}`);
    say(`S6 duplicates of the test folder name in root: ${rootAfter.filter((i) => i.name === key).length}; onb2_TEST_0001 children AFTER (read-only): ${legacyAfter.length}`);
    expect(legacyAfter).toHaveLength(legacyBefore.length);

    say(`API CALLS (${calls.length}):\n  ${calls.join("\n  ")}`);
    say(`ADAPTER LOGS: ${logs.join(" ; ") || "(none)"}`);
    console.log(`\n=== LIVE QA EVIDENCE ===\n${ev.join("\n")}\n=== END ===`);
  }, 180_000);
});
