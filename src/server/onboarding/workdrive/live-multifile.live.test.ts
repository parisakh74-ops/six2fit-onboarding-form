// @vitest-environment node
// LIVE multi-file / recovery QA (PREPARED, NOT YET APPROVED TO RUN). Skipped unless S2F_LIVE_MULTIFILE=1 and S2F_WD_TOKEN are set.
// Failure injection is local to the adapter boundary (a decorator around the real client): no shared infrastructure or Zoho service is touched.
// Synthetic bytes only; hard cap on write operations; no delete, overwrite or share exists in the API surface used.
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../canonical";
import type { StoredFile, SubmissionRecord } from "../ports";
import { WdHttpError, type WdItem, type WorkDriveApi } from "./api";
import { HttpWorkDriveApi } from "./http-api";
import { WorkDriveSubmissionStorage, buildDocument } from "./storage";

const LIVE = process.env["S2F_LIVE_MULTIFILE"] === "1" && Boolean(process.env["S2F_WD_TOKEN"]);
const ROOT = "76a80aad8e6f6764944278234c783ad4a4f95";
const ROOT_NAME = "S2F-ONBOARDING-TEST";
const BASE = "https://www.zohoapis.com/workdrive/api/v1";
const MAX_WRITES = 10; // folder creations + upload calls, injected ones included

const synthetic = (size: number, seed: number): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
  for (let i = 16; i < size; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

class Guarded implements WorkDriveApi {
  writes = 0;
  uploads = 0;
  /** 1-based upload number to break, and how: "not-sent" (request never leaves) or "answer-lost" (sent and applied, answer dropped). */
  constructor(private readonly inner: WorkDriveApi, private mode: { upload: number; kind: "not-sent" | "answer-lost" } | null) {}
  disarm() {
    this.mode = null;
  }
  private write() {
    this.writes += 1;
    if (this.writes > MAX_WRITES) throw new Error("STOP: write budget exceeded");
  }
  getItem(id: string) { return this.inner.getItem(id); }
  list(id: string) { return this.inner.list(id); }
  download(id: string) { return this.inner.download(id); }
  createFolder(p: string, n: string) { this.write(); return this.inner.createFolder(p, n); }
  async upload(p: string, n: string, b: Uint8Array): Promise<WdItem> {
    this.write();
    this.uploads += 1;
    if (this.mode && this.uploads === this.mode.upload) {
      if (this.mode.kind === "not-sent") throw new WdHttpError(503);
      await this.inner.upload(p, n, b);
      throw new WdHttpError(0);
    }
    return this.inner.upload(p, n, b);
  }
}

describe.skipIf(!LIVE)("WorkDrive adapter LIVE multi-file recovery QA", () => {
  it("A (upload of file 2 never sent) and B (answer lost after commit)", async () => {
    const ev: string[] = [];
    const calls: string[] = [];
    const recFetch = async (url: string, init?: { method?: string }) => {
      const res = await fetch(url, init as RequestInit);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname.replace(/\/[0-9a-z]{30,}/g, "/<id>")} -> ${res.status}`);
      return res;
    };
    const real = new HttpWorkDriveApi({ fetch: recFetch as never, accessToken: async () => process.env["S2F_WD_TOKEN"] as string, baseUrl: BASE, timeoutMs: 30_000 });
    const front = synthetic(2048, 3);
    const back = synthetic(3072, 7);
    const stamp = Date.now().toString(36);

    const run = async (label: string, kind: "not-sent" | "answer-lost") => {
      const key = `onb2_QAMF${label}_${label === "A" && process.env["S2F_QA_STAMP_A"] ? process.env["S2F_QA_STAMP_A"] : stamp}`; // A may resume an already interrupted folder
      const files: StoredFile[] = [
        { key: "MS-05.front", name: "front.jpg", type: "image/jpeg", size: front.length, sha256: sha256Hex(front) },
        { key: "MS-05.back", name: "back.jpg", type: "image/jpeg", size: back.length, sha256: sha256Hex(back) },
      ];
      const record: SubmissionRecord = {
        subject_key: `onb_${sha256Hex(key).slice(0, 40)}`,
        unique_form_key: key,
        fingerprint: sha256Hex(`fp-${key}`),
        scope: "Combo",
        subject: { kind: "deal", dealId: "0000000000000000000" } as SubmissionRecord["subject"],
        link_id: `link_qa_${label}_${stamp}`,
        entitlements: [],
        answers: { "QA-01": "synthetic" },
        verification_state: {},
        files,
        submitted_at: new Date().toISOString(),
      };
      const bytes = { "MS-05.front": front, "MS-05.back": back };
      const guarded = new Guarded(real, { upload: 2, kind });
      const mk = () => new WorkDriveSubmissionStorage(guarded, { rootFolderId: ROOT, rootFolderName: ROOT_NAME });

      // attempt 1: broken at the 2nd upload
      const first = await mk().stage(record, bytes).then(() => "OK", (e: unknown) => `FAILED code=${(e as { code?: string }).code}`);
      const folder = (await real.list(ROOT)).filter((i) => i.name === key);
      expect(folder).toHaveLength(1);
      const fid = (folder[0] as WdItem).id;
      const afterFirst = await real.list(fid);
      ev.push(`${label} ${kind}: attempt1=${first}; folder=${fid}; items after attempt1=${afterFirst.map((i) => `${i.name}(${i.size}B)`).join(", ") || "none"}; writes=${guarded.writes}`);

      // attempt 2: injection off, same key (new adapter instance = new process)
      guarded.disarm();
      const writesBefore = guarded.writes;
      const staged = await mk().stage(record, bytes);
      const items = await real.list(fid);
      ev.push(`${label} attempt2: ok; writes this attempt=${guarded.writes - writesBefore}; items=${items.map((i) => `${i.name}[${i.id}](${i.size}B)`).join(" | ")}`);
      expect(items).toHaveLength(3);
      expect(items.every((i) => !/\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(true);

      // JSON references both files, hashes verified by download
      const doc = items.find((i) => i.name === "submission.v1.json") as WdItem;
      const docBytes = await real.download(doc.id);
      const expected = new TextEncoder().encode(canonicalJson(buildDocument(record, staged.files)));
      const parsed = JSON.parse(new TextDecoder().decode(docBytes)) as { files: Array<{ key: string; sha256: string; ref: string }> };
      for (const f of items.filter((i) => i.name.startsWith("MS-05."))) {
        const b = await real.download(f.id);
        const want = f.name.startsWith("MS-05.front") ? front : back;
        expect(sha256Hex(b)).toBe(sha256Hex(want));
      }
      expect(parsed.files.map((f) => f.ref).sort()).toEqual(items.filter((i) => i.name.startsWith("MS-05.")).map((i) => `wd:${i.id}`).sort());
      ev.push(`${label} document sha256 match=${sha256Hex(docBytes) === sha256Hex(expected)}; refs to both files=${parsed.files.length === 2}`);

      // attempt 3: identical retry, zero writes expected
      const w3 = guarded.writes;
      await mk().stage(record, bytes);
      const after = await real.list(fid);
      ev.push(`${label} identical retry: writes=${guarded.writes - w3}; items=${after.length}`);
      expect(guarded.writes - w3).toBe(0);
      expect(after).toHaveLength(3);
      ev.push(`${label} TOTAL writes=${guarded.writes} (cap ${MAX_WRITES})`);
    };

    await run("A", "not-sent");
    await run("B", "answer-lost");
    ev.push(`API CALLS (${calls.length}); non-2xx: ${calls.filter((c) => !/-> 20[01]$/.test(c)).join("; ") || "none"}`);
    console.log(`\n=== LIVE MULTIFILE EVIDENCE ===\n${ev.join("\n")}\n=== END ===`);
  }, 300_000);
});
