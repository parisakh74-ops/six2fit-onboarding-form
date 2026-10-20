// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { StoreError } from "../errors";
import { DEAL_ID, NOW_MS, SECRET, dealToken, jpegFile, validAnswers } from "../fixtures";
import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import type { CreateResult, CrmWriter, StoredRef, SubjectDirectory, SubmissionExtras, SubmissionRecord } from "../ports";
import { createOnboardingService, type SubmitInput } from "../service";
import { WdHttpError } from "./api";
import { HttpWorkDriveApi } from "./http-api";
import { MockWorkDrive } from "./mock";
import { DOCUMENT_NAME, DeferredFileSink, WorkDriveStagingWriter, WorkDriveSubmissionStorage } from "./storage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-wd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROOT_NAME = "S2F-ONBOARDING-TEST";
const UKEY = `onb2_${DEAL_ID}_link_0123456789abcdef0123`;

class Directory implements SubjectDirectory {
  async resolve() {
    return { prefill: { "ON-01": "Ali Rezaei" } };
  }
}

/** Stands in for the CRM writer: records what it was given. Never a network call. */
class FakeCrm implements CrmWriter {
  readonly records = new Map<string, SubmissionRecord>();
  creates = 0;
  failNext: StoreError | null = null;
  lastExtras: SubmissionExtras | undefined;

  async create(record: SubmissionRecord, extras?: SubmissionExtras): Promise<CreateResult> {
    this.creates += 1;
    this.lastExtras = extras;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const existing = this.records.get(record.unique_form_key);
    if (existing) return { status: "exists", record: { fingerprint: existing.fingerprint, submitted_at: existing.submitted_at, record_ref: "100000001" } };
    this.records.set(record.unique_form_key, record);
    return { status: "created", record: { fingerprint: record.fingerprint, submitted_at: record.submitted_at, record_ref: "100000001" } };
  }

  async lookupId(key: string): Promise<string | null> {
    return this.records.has(key) ? "100000001" : null;
  }

  async readRecord(_id: string, key: string): Promise<StoredRef> {
    const r = this.records.get(key);
    if (!r) throw new StoreError("UNAVAILABLE", "missing", "READ_AFTER_WRITE");
    return { fingerprint: r.fingerprint, submitted_at: r.submitted_at, record_ref: "100000001" };
  }
}

const ANSWERS = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });

function world(wd = new MockWorkDrive()) {
  const clock = { t: NOW_MS };
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  const crm = new FakeCrm();
  const storage = () => new WorkDriveSubmissionStorage(wd, { rootFolderId: wd.rootId, rootFolderName: ROOT_NAME });
  /** A separate "worker": own service/store/storage objects; shares only the ledger directory, WorkDrive and the CRM. */
  const worker = () => {
    const store = new LedgerOnboardingStore(new WorkDriveStagingWriter(crm, storage()), new IdempotencyLedger(join(dir, "ledger")), { now: () => clock.t, sleep, waitMs: 1_000_000_000 });
    return createOnboardingService({ store, directory: new Directory(), sink: new DeferredFileSink(), secret: SECRET, now: () => clock.t });
  };
  return { wd, crm, clock, worker, storage };
}

const front = () => jpegFile("front.jpg", 4096);
const back = () => {
  const f = jpegFile("back.jpg", 3072);
  f.bytes[200] = 9;
  return f;
};
const input = (over: Partial<SubmitInput> = {}): SubmitInput => {
  const id = over.submissionId ?? "11111111-2222-4333-8444-555555555555";
  return { token: dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }), submissionId: id, idempotencyKey: id, answers: ANSWERS, verificationState: "{}", files: { "MS-05.front": front(), "MS-05.back": back() }, ...over };
};
const retryId = "22222222-2222-4333-8444-555555555555";
const submissionFolder = (wd: MockWorkDrive) => wd.all(wd.rootId).filter((i) => i.kind === "folder");
const filesIn = (wd: MockWorkDrive) => {
  const f = submissionFolder(wd)[0];
  return f ? wd.all(f.id) : [];
};

describe("WorkDrive staging: normal paths", () => {
  it("1) first submission: one folder named by uniqueformkey, two hashed files and one canonical document; the CRM gets verified refs", async () => {
    const w = world();
    const r = await w.worker().submit(input());
    expect(r.status).toBe(200);
    expect(r.body["deduplicated"]).toBe(false);
    const folders = submissionFolder(w.wd);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.name).toBe(UKEY);
    const items = filesIn(w.wd);
    expect(items.map((i) => i.name).sort()).toEqual(
      [`MS-05.back-${sha256Hex(back().bytes).slice(0, 16)}.jpg`, `MS-05.front-${sha256Hex(front().bytes).slice(0, 16)}.jpg`, DOCUMENT_NAME].sort(),
    );
    expect(w.wd.calls.upload).toBe(3);
    const rec = w.crm.records.get(UKEY) as SubmissionRecord;
    expect(rec.document_ref).toMatch(/^wd:wd\d+$/);
    expect(rec.files.every((f) => /^wd:wd\d+$/.test(f.ref ?? ""))).toBe(true);
    // every write stayed inside the approved root and its own submission folder
    const allowed = new Set([w.wd.rootId, folders[0]?.id]);
    expect(w.wd.writeParents.every((p) => allowed.has(p))).toBe(true);
    // file bytes reach the CRM writer only as transient extras, never inside the record
    expect(JSON.stringify(rec)).not.toContain("bytes");
  });

  it("2) identical retry: deduplicated, no second upload and no second CRM create", async () => {
    const w = world();
    await w.worker().submit(input());
    const r = await w.worker().submit(input({ submissionId: retryId }));
    expect(r.status).toBe(200);
    expect(r.body["deduplicated"]).toBe(true);
    expect(w.wd.calls.upload).toBe(3);
    expect(w.wd.calls.createFolder).toBe(1);
    expect(w.crm.creates).toBe(1);
  });

  it("3) concurrent identical requests from two workers: exactly one stages and one creates", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.worker().submit(input()), w.worker().submit(input({ submissionId: retryId }))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body["deduplicated"], b.body["deduplicated"]].sort()).toEqual([false, true]);
    expect(submissionFolder(w.wd)).toHaveLength(1);
    expect(filesIn(w.wd)).toHaveLength(3);
    expect(w.wd.calls.upload).toBe(3);
    expect(w.crm.creates).toBe(1);
  });

  it("4) same identifier with different content is a conflict: 409 at the service, CONTENT conflict at the storage, nothing overwritten", async () => {
    const w = world();
    await w.worker().submit(input());
    const other = input({ submissionId: retryId, answers: validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined, "ON-01": "Someone Else" }) });
    expect((await w.worker().submit(other)).status).toBe(409);
    expect(w.wd.calls.upload).toBe(3);

    // Even if the ledger were lost, a document with another fingerprint is refused (integrity), never replaced.
    const rec = w.crm.records.get(UKEY) as SubmissionRecord;
    const bytes = { "MS-05.front": front().bytes, "MS-05.back": back().bytes };
    await expect(w.storage().stage({ ...rec, fingerprint: "f".repeat(64) }, bytes)).rejects.toMatchObject({ kind: "REJECTED", code: "WD_SUBMISSION_CONFLICT" });
    expect(w.wd.calls.upload).toBe(3);
  });
});

describe("WorkDrive staging: failures and recovery", () => {
  it("5) interrupted upload: the retry resumes with the missing file only (no duplicates)", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 503, applied: false });
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.crm.creates).toBe(0);
    expect(filesIn(w.wd)).toHaveLength(1);
    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(200);
    const items = filesIn(w.wd);
    expect(items).toHaveLength(3);
    expect(items.every((i) => !/\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(true);
    expect(w.wd.calls.upload).toBe(4); // front, back(failed), back, document
    expect(w.crm.creates).toBe(1);
  });

  it("6a) WorkDrive succeeded, CRM definitively refused: the retry reuses the staged items", async () => {
    const w = world();
    const refused = new StoreError("UNAVAILABLE", "crm refused", "HTTP_400");
    refused.notWritten = true;
    w.crm.failNext = refused;
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.wd.calls.upload).toBe(3);
    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(200);
    expect(w.wd.calls.upload).toBe(3); // nothing uploaded again
    expect(w.crm.creates).toBe(2);
    expect(filesIn(w.wd)).toHaveLength(3);
  });

  it("6b) WorkDrive succeeded, CRM outcome UNKNOWN: no automatic second write; WorkDrive is not touched again", async () => {
    const w = world();
    w.crm.failNext = new StoreError("UNAVAILABLE", "crm timeout", "TIMEOUT");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(503); // still inside the quiescence window
    expect(w.crm.creates).toBe(1);
    expect(w.wd.calls.upload).toBe(3);
    expect(w.wd.calls.createFolder).toBe(1);
  });

  it("7) lost API response after a committed upload: found, verified and reused (no second upload)", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 1, status: 0, applied: true });
    expect((await w.worker().submit(input())).status).toBe(200);
    expect(w.wd.calls.upload).toBe(3); // front (answer lost, committed), back, document
    const items = filesIn(w.wd);
    expect(items).toHaveLength(3);
    expect(items.every((i) => !/\d{2}-\d{2}-\d{4}/.test(i.name))).toBe(true);
  });

  it("7b) lost response on folder creation is recovered by listing", async () => {
    const w = world();
    w.wd.inject({ op: "createFolder", nth: 1, status: 0, applied: true });
    expect((await w.worker().submit(input())).status).toBe(200);
    expect(submissionFolder(w.wd)).toHaveLength(1);
  });

  it("8a) pre-existing duplicate files: ambiguous, reported as integrity, nothing uploaded, nothing deleted", async () => {
    const w = world();
    const folder = w.wd.plant(w.wd.rootId, UKEY, "folder");
    const name = `MS-05.front-${sha256Hex(front().bytes).slice(0, 16)}.jpg`;
    w.wd.plant(folder.id, name, "file", front().bytes);
    w.wd.plant(folder.id, name, "file", front().bytes);
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.wd.calls.upload).toBe(0);
    expect(w.wd.all(folder.id)).toHaveLength(2);
    expect(w.crm.creates).toBe(0);
    // the integrity state sticks: the next request is refused too, without touching WorkDrive again
    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(503);
    expect(w.wd.calls.upload).toBe(0);
  });

  it("8b) a same-name duplicate with a timestamp suffix next to the original is ambiguous too", async () => {
    const w = world();
    const folder = w.wd.plant(w.wd.rootId, UKEY, "folder");
    const name = `MS-05.front-${sha256Hex(front().bytes).slice(0, 16)}.jpg`;
    w.wd.plant(folder.id, name, "file", front().bytes);
    w.wd.plant(folder.id, name.replace(".jpg", " 17-10-2026 00:54:47:912.jpg"), "file", front().bytes);
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_AMBIGUOUS_FILES" });
    expect(w.wd.calls.upload).toBe(0);
  });

  it("8c) an existing file with the expected name but other content is a conflict, never overwritten", async () => {
    const w = world();
    const folder = w.wd.plant(w.wd.rootId, UKEY, "folder");
    const bytes = front().bytes;
    w.wd.plant(folder.id, `MS-05.front-${sha256Hex(bytes).slice(0, 16)}.jpg`, "file", new Uint8Array(bytes.length)); // same size, other bytes
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": bytes })).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_FILE_INTEGRITY" });
    expect(w.wd.calls.upload).toBe(0);
  });

  it("8d) two folders for one submission key are ambiguous", async () => {
    const w = world();
    w.wd.plant(w.wd.rootId, UKEY, "folder");
    w.wd.plant(w.wd.rootId, UKEY, "folder");
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_AMBIGUOUS_FOLDER" });
    expect(w.wd.calls.upload).toBe(0);
  });
});

function baseRecord(): SubmissionRecord {
  const f = front();
  return {
    subject_key: "onb_" + "a".repeat(40),
    unique_form_key: UKEY,
    fingerprint: "a".repeat(64),
    scope: "Combo",
    subject: { kind: "deal", dealId: DEAL_ID } as SubmissionRecord["subject"],
    link_id: "link_0123456789abcdef0123",
    entitlements: [],
    answers: {},
    verification_state: {},
    files: [{ key: "MS-05.front", name: "front.jpg", type: "image/jpeg", size: f.bytes.length, sha256: sha256Hex(f.bytes) }],
    submitted_at: new Date(NOW_MS).toISOString(),
  };
}

describe("WorkDrive staging: access and parent checks", () => {
  it("9a) a root id that does not exist is rejected before any write", async () => {
    const wd = new MockWorkDrive();
    const storage = new WorkDriveSubmissionStorage(wd, { rootFolderId: "not_the_approved_folder", rootFolderName: ROOT_NAME });
    await expect(storage.stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ code: "WD_INVALID_PARENT", notWritten: true });
    expect(wd.writeParents).toEqual([]);
  });

  it("9b) a root folder with another title is rejected before any write", async () => {
    const wd = new MockWorkDrive("root_test_folder_0001", "General");
    const storage = new WorkDriveSubmissionStorage(wd, { rootFolderId: wd.rootId, rootFolderName: ROOT_NAME });
    await expect(storage.stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ code: "WD_INVALID_PARENT" });
    expect(wd.writeParents).toEqual([]);
  });

  it("9c) a submission key that could escape the naming scheme is rejected", async () => {
    const w = world();
    await expect(w.storage().stage({ ...baseRecord(), unique_form_key: "../../other" }, {})).rejects.toMatchObject({ code: "WD_INVALID_KEY" });
    expect(w.wd.writeParents).toEqual([]);
  });

  it("10a) unauthenticated: 503 at the service, nothing written to WorkDrive, the CRM is never reached", async () => {
    const w = world();
    w.wd.mode = "unauthenticated";
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.crm.creates).toBe(0);
    expect(w.wd.writeParents).toEqual([]);
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ code: "WD_UNAUTHENTICATED", notWritten: true });
  });

  it("10b) read-only caller (403 on writes): clean refusal, no items, CRM not reached", async () => {
    const w = world();
    w.wd.mode = "readOnly";
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.wd.all(w.wd.rootId)).toHaveLength(0);
    expect(w.crm.creates).toBe(0);
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": front().bytes })).rejects.toMatchObject({ code: "WD_FORBIDDEN" });
  });

  it("rejects file bytes that do not match the submission record (hash or size)", async () => {
    const w = world();
    const wrong = front().bytes.slice();
    wrong[300] = 1;
    await expect(w.storage().stage(baseRecord(), { "MS-05.front": wrong })).rejects.toMatchObject({ code: "WD_INVALID_FILE" });
    await expect(w.storage().stage(baseRecord(), {})).rejects.toMatchObject({ code: "WD_INVALID_FILE" });
    expect(w.wd.calls.upload).toBe(0);
  });
});

describe("multi-file submission: interruption and recovery (mock failure injection)", () => {
  const docOf = async (w: ReturnType<typeof world>) => {
    const item = filesIn(w.wd).find((i) => i.name === DOCUMENT_NAME) as { id: string };
    return JSON.parse(new TextDecoder().decode(await w.wd.download(item.id))) as { files: Array<{ key: string; sha256: string; size: number; ref: string }>; fingerprint: string };
  };

  it("M1) file 1 uploaded, file 2 fails: nothing else is created and the CRM is untouched; the retry uploads ONLY the missing file, then the document; the identical retry uploads nothing", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 503, applied: false });

    expect((await w.worker().submit(input())).status).toBe(503);
    expect(filesIn(w.wd)).toHaveLength(1); // only the first file; no document yet
    expect(filesIn(w.wd).some((i) => i.name === DOCUMENT_NAME)).toBe(false);
    expect(w.crm.creates).toBe(0); // CRM is never attempted before every file and the document are confirmed

    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(200);
    const [a, b] = w.wd.uploadLog;
    expect(a).not.toBe(b);
    expect(w.wd.uploadLog).toEqual([a, b, b, DOCUMENT_NAME]); // the verified first file was reused, never uploaded again
    expect(filesIn(w.wd)).toHaveLength(3);
    expect(w.crm.creates).toBe(1);

    // the canonical JSON references BOTH files with their hashes and refs
    const doc = await docOf(w);
    const rec = w.crm.records.get(UKEY) as SubmissionRecord;
    expect(doc.files.map((f) => f.key).sort()).toEqual(["MS-05.back", "MS-05.front"]);
    expect(doc.files.map((f) => f.sha256).sort()).toEqual([sha256Hex(back().bytes), sha256Hex(front().bytes)].sort());
    expect(doc.files.map((f) => f.ref).sort()).toEqual(rec.files.map((f) => f.ref).sort());
    const ids = new Set(filesIn(w.wd).map((i) => `wd:${i.id}`));
    expect(doc.files.every((f) => ids.has(f.ref))).toBe(true);
    expect(rec.document_ref && ids.has(rec.document_ref)).toBe(true);

    const uploads = w.wd.calls.upload;
    const again = await w.worker().submit(input({ submissionId: "33333333-2222-4333-8444-555555555555" }));
    expect(again.body["deduplicated"]).toBe(true);
    expect(w.wd.calls.upload).toBe(uploads);
    expect(w.crm.creates).toBe(1);
  });

  it("M2) both files uploaded, the document upload fails: the retry uploads only the document", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 3, status: 503, applied: false });
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(filesIn(w.wd)).toHaveLength(2);
    expect(w.crm.creates).toBe(0);
    expect((await w.worker().submit(input({ submissionId: retryId }))).status).toBe(200);
    expect(w.wd.uploadLog.filter((n) => n === DOCUMENT_NAME)).toHaveLength(2); // failed attempt + the one that landed
    expect(w.wd.uploadLog).toHaveLength(4);
    expect(filesIn(w.wd)).toHaveLength(3);
    expect((await docOf(w)).files).toHaveLength(2);
  });

  it("M3) the second file's upload landed but its answer was lost AND the next listing is checked: no duplicate, JSON still references both", async () => {
    const w = world();
    w.wd.inject({ op: "upload", nth: 2, status: 0, applied: true });
    expect((await w.worker().submit(input())).status).toBe(200);
    expect(w.wd.uploadLog).toHaveLength(3); // file, file (answer lost), document
    expect(filesIn(w.wd)).toHaveLength(3);
    expect((await docOf(w)).files).toHaveLength(2);
  });

  it("M4) a file that was altered in WorkDrive is a FILE-INTEGRITY failure, a different submission content is a SUBMISSION conflict; neither uploads or deletes", async () => {
    const w = world();
    await w.worker().submit(input());
    const rec = w.crm.records.get(UKEY) as SubmissionRecord;
    const bytes = { "MS-05.front": front().bytes, "MS-05.back": back().bytes };
    const uploads = w.wd.calls.upload;

    const tampered = filesIn(w.wd).find((i) => i.name.startsWith("MS-05.front")) as { id: string };
    w.wd.plant(w.wd.rootId, "unrelated", "folder"); // noise that must not matter
    // replace the stored bytes under the same item (simulates an external edit)
    (w.wd as unknown as { items: Map<string, { bytes: Uint8Array }> }).items.get(tampered.id)!.bytes = new Uint8Array(front().bytes.length);
    await expect(w.storage().stage(rec, bytes)).rejects.toMatchObject({ kind: "CORRUPT", code: "WD_FILE_INTEGRITY" });
    (w.wd as unknown as { items: Map<string, { bytes: Uint8Array }> }).items.get(tampered.id)!.bytes = front().bytes;

    await expect(w.storage().stage({ ...rec, fingerprint: "e".repeat(64) }, bytes)).rejects.toMatchObject({ kind: "REJECTED", code: "WD_SUBMISSION_CONFLICT" });
    expect(w.wd.calls.upload).toBe(uploads);
    expect(filesIn(w.wd)).toHaveLength(3);
  });

  it("M5) no write path can overwrite or delete: across every scenario only list/get/create-folder/upload/download exist and an existing exact-name item is never uploaded over", async () => {
    const w = world();
    await w.worker().submit(input());
    const before = w.wd.uploadLog.length;
    await w.worker().submit(input({ submissionId: retryId }));
    await w.worker().submit(input({ submissionId: "44444444-2222-4333-8444-555555555555" }));
    expect(w.wd.uploadLog.length).toBe(before);
    expect(Object.keys(w.wd.calls).sort()).toEqual(["createFolder", "download", "getItem", "list", "upload"]);
  });
});

describe("HttpWorkDriveApi (fixtures only, no network)", () => {
  const json = (status: number, body: unknown) => ({ status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const attrs = (id: string, name: string, type = "file", bytes = 10) => ({ id, attributes: { name, type, parent_id: "p1", storage_info: { size: "2.00 KB", size_in_bytes: bytes } } });

  it("lists every page and maps items", async () => {
    const pages = [Array.from({ length: 50 }, (_, i) => attrs(`a${i}`, `n${i}`)), [attrs("z", "last", "folder")]];
    const urls: string[] = [];
    const api = new HttpWorkDriveApi({ fetch: async (u) => (urls.push(u), json(200, { data: pages.shift() })), accessToken: async () => "synthetic", baseUrl: "https://api.invalid/workdrive/api/v1" });
    const items = await api.list("p1");
    expect(items).toHaveLength(51);
    expect(items[50]).toMatchObject({ id: "z", kind: "folder", size: 10 });
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.startsWith("https://api.invalid/"))).toBe(true);
  });

  it("uses the exact size_in_bytes, never the rounded display string; a file without it is an unreadable answer", async () => {
    const mk = (body: unknown) => new HttpWorkDriveApi({ fetch: async () => json(200, body), accessToken: async () => "synthetic", baseUrl: "https://api.invalid" });
    expect((await mk({ data: attrs("a", "x.jpg", "file", 3000) }).getItem("a")).size).toBe(3000); // display string would say "2.00 KB"
    const noBytes = { data: { id: "a", attributes: { name: "x.jpg", type: "file", parent_id: "p1", storage_info: { size: "2.00 KB" } } } };
    await expect(mk(noBytes).getItem("a")).rejects.toMatchObject({ status: 0 });
  });

  it("maps HTTP errors and transport failures (status 0 = ambiguous)", async () => {
    const mk = (f: () => Promise<ReturnType<typeof json>>) => new HttpWorkDriveApi({ fetch: f, accessToken: async () => "synthetic", baseUrl: "https://api.invalid" });
    await expect(mk(async () => json(403, {})).getItem("x")).rejects.toMatchObject({ status: 403 });
    const lost = await mk(async () => { throw new Error("socket"); }).getItem("x").catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(WdHttpError);
    expect((lost as WdHttpError).ambiguous).toBe(true);
    await expect(mk(async () => json(200, { data: { nope: 1 } })).getItem("x")).rejects.toMatchObject({ status: 0 });
  });

  it("never sends override-name-exist=true and reads the upload result back by resource id", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const api = new HttpWorkDriveApi({
      fetch: async (u, init) => {
        seen.push({ url: u, body: init?.body });
        if (u.endsWith("/upload")) return json(200, { data: [{ attributes: { resource_id: "r1" } }] });
        return json(200, { data: attrs("r1", "f.json", "file", 5) });
      },
      accessToken: async () => "synthetic",
      baseUrl: "https://api.invalid",
    });
    const item = await api.upload("p1", "f.json", new Uint8Array(5));
    expect(item).toMatchObject({ id: "r1", size: 5 });
    const form = seen[0]?.body as FormData;
    expect(form.get("override-name-exist")).toBe("false");
    expect(form.get("parent_id")).toBe("p1");
  });
});
