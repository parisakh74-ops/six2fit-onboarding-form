import { canonicalJson, fingerprint, sha256Hex } from "../canonical";
import { StoreError } from "../errors";
import type { CreateResult, CrmWriter, FileSink, StoredFile, StoredRef, SubmissionExtras, SubmissionRecord } from "../ports";
import type { Subject } from "../tokens";
import { WdHttpError, type WdItem, type WorkDriveApi } from "./api";

export const DOCUMENT_NAME = "submission.v1.json";
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^onb2_[A-Za-z0-9_-]{8,200}$/;

/** What a verified canonical document proves about its submission (never the answers). */
export type VerifiedDocumentIdentity = { fingerprint: string; submitted_at: string; folderId: string; documentId: string };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type WorkDriveStorageConfig = {
  /** The one approved parent folder (test or production Team Folder). Nothing outside it is ever touched. */
  rootFolderId: string;
  /** Expected title of that folder, verified before the first write (guards against a mistyped or re-pointed id). */
  rootFolderName: string;
  /**
   * Budget for staging ONE submission. Checked between WorkDrive operations: when exceeded the attempt stops with
   * `WD_DEADLINE` (nothing is lost: the claim is released and the retry resumes from what is already in WorkDrive).
   * Must stay below the ledger lease (see `crm/runtime.ts`). Unset = no deadline.
   */
  deadlineMs?: number;
  now?: () => number;
};

export type StagedSubmission = { folderId: string; documentRef: string; files: StoredFile[] };
type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

/** A failure BEFORE the CRM is touched: `notWritten` is true so the ledger may release the claim (retry resumes). */
const stageError = (kind: StoreError["kind"], code: string, message: string): StoreError => {
  const e = new StoreError(kind, message, code);
  e.notWritten = true;
  return e;
};

function mapWd(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  if (e instanceof WdHttpError) {
    if (e.status === 401) return stageError("UNAVAILABLE", "WD_UNAUTHENTICATED", "workdrive rejected the caller");
    if (e.status === 403) return stageError("UNAVAILABLE", "WD_FORBIDDEN", "workdrive denied the operation");
    if (e.status === 404) return stageError("NOT_CONFIGURED", "WD_INVALID_PARENT", "workdrive folder not found");
    if (e.status === 429) return stageError("UNAVAILABLE", "WD_RATE_LIMITED", "workdrive rate limited");
    return stageError("UNAVAILABLE", "WD_UNAVAILABLE", "workdrive unavailable");
  }
  return stageError("UNAVAILABLE", "WD_UNAVAILABLE", "workdrive unavailable");
}

/** The canonical JSON document stored next to the files (exported so QA can recompute the exact expected bytes). */
export function buildDocument(record: SubmissionRecord, files: StoredFile[]) {
  return {
    doc_version: 1,
    form: "onboarding",
    unique_form_key: record.unique_form_key,
    subject_key: record.subject_key,
    link_id: record.link_id,
    scope: record.scope,
    subject: record.subject,
    entitlements: record.entitlements,
    answers: record.answers,
    verification_state: record.verification_state,
    files: files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: f.sha256, ref: f.ref })),
    submitted_at: record.submitted_at,
    fingerprint: record.fingerprint,
  };
}

const extFor = (type: string) => (type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg");

/**
 * Stages one submission in WorkDrive: `<root>/<uniqueformkey>/{<key>-<sha16>.<ext>..., submission.v1.json}`.
 *
 * Safety model (nothing here is a lock: concurrency is arbitrated by the idempotency ledger, which calls this only
 * for the claim holder, see `WorkDriveStagingWriter`):
 *  - never overwrites, moves or deletes; a same-name upload creates a second item in WorkDrive, so every write is
 *    preceded by a listing and followed by a verification (size, parent, SHA-256 of the downloaded bytes);
 *  - state is rebuilt from WorkDrive on every attempt (folder named by `uniqueformkey`, files named by content hash,
 *    one canonical JSON document carrying the fingerprint), so an interrupted attempt resumes and a lost response is
 *    recovered by finding and verifying the item instead of uploading again;
 *  - more than one candidate for a folder/file/document, a different content under the same name, or a document with
 *    another fingerprint is an INTEGRITY state (`CORRUPT`): reported, never resolved automatically.
 */
export class WorkDriveSubmissionStorage {
  private rootVerified = false;

  constructor(
    private readonly api: WorkDriveApi,
    private readonly config: WorkDriveStorageConfig,
    private readonly log: Log = () => undefined,
  ) {}

  async stage(record: SubmissionRecord, fileBytes: Record<string, Uint8Array>): Promise<StagedSubmission> {
    try {
      return await this.stageInner(record, fileBytes);
    } catch (e) {
      throw mapWd(e);
    }
  }

  /** Downloads the canonical document and proves it: own fingerprint recomputed from its content, key and form match. */
  private async verifyDocumentContent(documentId: string, uniqueFormKey: string): Promise<{ fingerprint: string; submitted_at: string }> {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(new TextDecoder().decode(await this.api.download(documentId))) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof WdHttpError) throw e;
      throw stageError("CORRUPT", "WD_DOCUMENT_UNREADABLE", "stored document is not readable");
    }
    const files = (Array.isArray(doc["files"]) ? doc["files"] : []) as Array<Record<string, unknown>>;
    const recomputed = fingerprint({
      subject: doc["subject"],
      scope: doc["scope"],
      entitlements: doc["entitlements"],
      answers: doc["answers"],
      verification_state: doc["verification_state"],
      files: files.map((f) => ({ key: f["key"], sha256: f["sha256"], size: f["size"], type: f["type"] })),
    });
    if (doc["form"] !== "onboarding" || doc["unique_form_key"] !== uniqueFormKey || typeof doc["fingerprint"] !== "string" || recomputed !== doc["fingerprint"]) {
      throw stageError("CORRUPT", "WD_DOCUMENT_TAMPERED", "stored document does not match its own fingerprint");
    }
    return { fingerprint: doc["fingerprint"], submitted_at: String(doc["submitted_at"] ?? "") };
  }

  /**
   * Identity of the canonical document behind a CRM permalink (`https://workdrive.zoho.com/file/<id>` or `wd:<id>`), read
   * from WorkDrive and verified: the document must sit in a folder named by the submission key directly under the approved
   * root, name itself and carry a fingerprint that matches its own content. Read-only; never writes.
   */
  async readDocumentIdentity(permalink: string, uniqueFormKey: string): Promise<{ fingerprint: string; submitted_at: string }> {
    try {
      const m = /^(?:wd:|https:\/\/workdrive\.zoho\.com\/file\/)([A-Za-z0-9]{20,64})$/.exec(permalink);
      if (!m) throw stageError("CORRUPT", "WD_DOCUMENT_REF_INVALID", "document reference is not valid");
      await this.verifyRoot();
      const item = await this.api.getItem(m[1] as string);
      if (item.kind !== "file" || item.name !== DOCUMENT_NAME) throw stageError("CORRUPT", "WD_DOCUMENT_REF_INVALID", "reference does not point at a canonical document");
      const folder = await this.api.getItem(item.parent_id);
      if (folder.kind !== "folder" || folder.name !== uniqueFormKey || folder.parent_id !== this.config.rootFolderId) {
        throw stageError("CORRUPT", "WD_DOCUMENT_REF_INVALID", "document is outside the approved submission folder");
      }
      return await this.verifyDocumentContent(item.id, uniqueFormKey);
    } catch (e) {
      throw mapWd(e);
    }
  }

  /** Submission folders directly under the approved root (one entry per folder; a repeated key means duplicate folders). Read-only. */
  async listSubmissionFolders(): Promise<Array<{ key: string; id: string }>> {
    try {
      await this.verifyRoot();
      const items = await this.api.list(this.config.rootFolderId);
      return items.filter((i) => i.kind === "folder" && KEY_PATTERN.test(i.name)).map((i) => ({ key: i.name, id: i.id }));
    } catch (e) {
      throw mapWd(e);
    }
  }

  /**
   * Verified identity of a submission's canonical document, found by `uniqueformkey` alone (WorkDrive-key persistence).
   * Read-only. Each outcome has its own code and nothing is ever picked silently:
   *  - `WD_INVALID_KEY` (REJECTED)            malformed key
   *  - `WD_FOLDER_NOT_FOUND` (UNAVAILABLE)    no folder (also what a lagging listing looks like: retryable, never proof of absence)
   *  - `WD_AMBIGUOUS_FOLDER` (CORRUPT)        more than one folder with the key
   *  - `WD_DOCUMENT_MISSING` (UNAVAILABLE)    folder without a canonical document
   *  - `WD_AMBIGUOUS_FILES` (CORRUPT)         more than one canonical document candidate
   *  - `WD_DOCUMENT_UNREADABLE` / `WD_DOCUMENT_TAMPERED` (CORRUPT)  content does not prove itself
   *  - `WD_UNAVAILABLE`, `WD_RATE_LIMITED`, `WD_UNAUTHENTICATED`, `WD_FORBIDDEN` (UNAVAILABLE)  WorkDrive could not be read
   * `opts.folders` lets a caller that already listed the root (reconciliation) avoid listing it again for every key.
   * Cost: one root listing (unless supplied) + one folder listing + one download. The root listing is O(submissions)
   * and capped by the HTTP client: a documented pre-Production blocker (see docs/onboarding/WORKDRIVE_KEY_MVP.md).
   */
  async readDocumentIdentityByKey(uniqueFormKey: string, opts: { folders?: ReadonlyArray<{ key: string; id: string }> } = {}): Promise<VerifiedDocumentIdentity> {
    try {
      if (typeof uniqueFormKey !== "string" || !KEY_PATTERN.test(uniqueFormKey)) throw stageError("REJECTED", "WD_INVALID_KEY", "invalid submission key");
      await this.verifyRoot();
      let folderId: string;
      if (opts.folders) {
        const hits = opts.folders.filter((f) => f.key === uniqueFormKey);
        if (hits.length === 0) throw stageError("UNAVAILABLE", "WD_FOLDER_NOT_FOUND", "submission folder not found");
        if (hits.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FOLDER", "more than one folder for a submission");
        folderId = (hits[0] as { id: string }).id;
      } else {
        const root = this.config.rootFolderId;
        const hits = (await this.api.list(root)).filter((i) => i.kind === "folder" && i.name === uniqueFormKey);
        if (hits.length === 0) throw stageError("UNAVAILABLE", "WD_FOLDER_NOT_FOUND", "submission folder not found");
        if (hits.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FOLDER", "more than one folder for a submission");
        const folder = hits[0] as WdItem;
        if (folder.parent_id !== root) throw stageError("CORRUPT", "WD_INVALID_PARENT", "submission folder is outside the approved root");
        folderId = folder.id;
      }
      const docs = await this.candidates(folderId, DOCUMENT_NAME);
      if (docs.length === 0) throw stageError("UNAVAILABLE", "WD_DOCUMENT_MISSING", "canonical document not found");
      if (docs.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "more than one canonical document");
      const doc = docs[0] as WdItem;
      if (doc.name !== DOCUMENT_NAME || doc.parent_id !== folderId) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "stored document is not the expected item");
      const identity = await this.verifyDocumentContent(doc.id, uniqueFormKey);
      return { ...identity, folderId, documentId: doc.id };
    } catch (e) {
      throw mapWd(e);
    }
  }

  /**
   * Reads back a staged submission for the Notion sync (reconciliation). The canonical document is first verified by
   * `readDocumentIdentityByKey` (fingerprint recomputed from its own content); file bytes are re-checked against the recorded
   * SHA-256 and size by the caller. Read-only.
   */
  async readStagedSubmission(uniqueFormKey: string): Promise<{
    submission: { unique_form_key: string; subject: Subject; scope: string; entitlements: string[]; answers: Record<string, never>; files: StoredFile[]; submitted_at: string; fingerprint: string };
    folderId: string;
    download: (ref: string) => Promise<Uint8Array>;
  }> {
    const id = await this.readDocumentIdentityByKey(uniqueFormKey);
    try {
      const doc = JSON.parse(new TextDecoder().decode(await this.api.download(id.documentId))) as Record<string, unknown>;
      const files = (Array.isArray(doc["files"]) ? doc["files"] : []) as StoredFile[];
      return {
        submission: {
          unique_form_key: uniqueFormKey,
          subject: (doc["subject"] ?? { kind: "consult", consultSubmissionId: "" }) as Subject,
          scope: String(doc["scope"] ?? ""),
          entitlements: (Array.isArray(doc["entitlements"]) ? doc["entitlements"] : []) as string[],
          answers: (doc["answers"] ?? {}) as Record<string, never>,
          files,
          submitted_at: id.submitted_at,
          fingerprint: id.fingerprint,
        },
        folderId: id.folderId,
        download: async (ref: string) => {
          const m = /^wd:([A-Za-z0-9]{20,64})$/.exec(ref);
          if (!m) throw stageError("CORRUPT", "WD_DOCUMENT_REF_INVALID", "file reference is not valid");
          const item = await this.api.getItem(m[1] as string);
          if (item.kind !== "file" || item.parent_id !== id.folderId) throw stageError("CORRUPT", "WD_DOCUMENT_REF_INVALID", "file is outside the submission folder");
          return this.api.download(item.id);
        },
      };
    } catch (e) {
      throw mapWd(e);
    }
  }

  /** Readiness: authenticates and proves the configured root is the approved folder (name check). Read-only, one call. */
  async verifyRootFolder(): Promise<void> {
    try {
      await this.verifyRoot();
    } catch (e) {
      throw mapWd(e);
    }
  }

  private async verifyRoot(): Promise<void> {
    if (this.rootVerified) return;
    const root = await this.api.getItem(this.config.rootFolderId);
    if (root.id !== this.config.rootFolderId || root.kind !== "folder" || root.name !== this.config.rootFolderName) {
      throw stageError("NOT_CONFIGURED", "WD_INVALID_PARENT", "workdrive root folder does not match the configuration");
    }
    this.rootVerified = true;
  }

  private async stageInner(record: SubmissionRecord, fileBytes: Record<string, Uint8Array>): Promise<StagedSubmission> {
    if (!KEY_PATTERN.test(record.unique_form_key)) throw stageError("REJECTED", "WD_INVALID_KEY", "invalid submission key");
    const clock = this.config.now ?? (() => Date.now());
    const startedAt = clock();
    const checkpoint = () => {
      if (this.config.deadlineMs !== undefined && clock() - startedAt > this.config.deadlineMs) throw stageError("UNAVAILABLE", "WD_DEADLINE", "staging budget exceeded");
    };
    await this.verifyRoot();
    const folderId = await this.findOrCreateFolder(record.unique_form_key);
    await this.refuseConflictingDocument(folderId, record);

    const files: StoredFile[] = [];
    for (const f of record.files) {
      const bytes = fileBytes[f.key];
      if (!bytes || !HEX64.test(f.sha256) || sha256Hex(bytes) !== f.sha256 || bytes.length !== f.size) {
        throw stageError("REJECTED", "WD_INVALID_FILE", "file bytes do not match the submission record");
      }
      checkpoint();
      const name = `${f.key.replace(/[^A-Za-z0-9_.-]/g, "_")}-${f.sha256.slice(0, 16)}.${extFor(f.type)}`;
      const item = await this.putVerified(folderId, name, bytes, f.sha256);
      files.push({ ...f, ref: `wd:${item.id}` });
    }

    checkpoint();
    const documentRef = await this.putDocument(folderId, record, files);
    this.log("workdrive.staged", { files: files.length });
    return { folderId, documentRef, files };
  }

  private async findOrCreateFolder(name: string): Promise<string> {
    const root = this.config.rootFolderId;
    const exact = async () => (await this.api.list(root)).filter((i) => i.kind === "folder" && i.name === name);
    let found = await exact();
    if (found.length === 0) {
      try {
        await this.api.createFolder(root, name);
      } catch (e) {
        // A lost answer or a name conflict: the folder may exist now. Anything else is a real failure.
        if (!(e instanceof WdHttpError) || !(e.ambiguous || e.status === 409)) throw e;
      }
      found = await exact();
      if (found.length === 0) throw stageError("UNAVAILABLE", "WD_UNAVAILABLE", "submission folder not visible after create");
    }
    if (found.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FOLDER", "more than one folder for a submission");
    const folder = found[0] as WdItem;
    if (folder.parent_id !== root) throw stageError("CORRUPT", "WD_INVALID_PARENT", "submission folder is outside the approved root");
    return folder.id;
  }

  /** Exact-name item plus every same-stem duplicate (WorkDrive renames a same-name upload by appending a timestamp). */
  private async candidates(folderId: string, name: string): Promise<WdItem[]> {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const pattern = new RegExp(`^${esc(stem)}( \\d{2}-\\d{2}-\\d{4} [0-9:.]+)?${esc(ext)}$`);
    return (await this.api.list(folderId)).filter((i) => i.kind === "file" && pattern.test(i.name));
  }

  private async verify(item: WdItem, folderId: string, name: string, bytes: Uint8Array, digest: string): Promise<void> {
    if (item.name !== name || item.parent_id !== folderId) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "stored file is not the expected item");
    // File integrity (NOT a submission conflict): the stored bytes are not the bytes this submission carries.
    if (item.size !== bytes.length) throw stageError("CORRUPT", "WD_FILE_INTEGRITY", "stored file differs from the submission");
    const got = await this.api.download(item.id);
    if (sha256Hex(got) !== digest) throw stageError("CORRUPT", "WD_FILE_INTEGRITY", "stored file differs from the submission");
  }

  /** Upload-once: reuse a verified existing item, never overwrite, never delete. */
  private async putVerified(folderId: string, name: string, bytes: Uint8Array, digest: string): Promise<WdItem> {
    let found = await this.candidates(folderId, name);
    if (found.length === 0) {
      try {
        await this.api.upload(folderId, name, bytes);
      } catch (e) {
        // Lost answer: the upload may have been applied. Look before doing anything else; never upload twice blindly.
        if (!(e instanceof WdHttpError) || !e.ambiguous) throw e;
        this.log("workdrive.upload_ambiguous");
      }
      found = await this.candidates(folderId, name);
      if (found.length === 0) throw stageError("UNAVAILABLE", "WD_UNAVAILABLE", "upload could not be confirmed");
    }
    if (found.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "more than one file matches");
    const item = found[0] as WdItem;
    await this.verify(item, folderId, name, bytes, digest);
    return item;
  }

  /**
   * Runs BEFORE any file is uploaded: if the folder already holds a canonical document for ANOTHER content (different
   * fingerprint), the submission is refused (REJECTED, nothing written) so a conflicting attempt cannot even add files.
   * More than one document candidate is an integrity state. No document yet means a fresh or interrupted submission.
   */
  private async refuseConflictingDocument(folderId: string, record: SubmissionRecord): Promise<void> {
    const found = await this.candidates(folderId, DOCUMENT_NAME);
    if (found.length === 0) return;
    if (found.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "more than one canonical document");
    const item = found[0] as WdItem;
    if (item.name !== DOCUMENT_NAME || item.parent_id !== folderId) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "stored document is not the expected item");
    let existing: { form?: unknown; unique_form_key?: unknown; fingerprint?: unknown };
    try {
      existing = JSON.parse(new TextDecoder().decode(await this.api.download(item.id))) as typeof existing;
    } catch (e) {
      if (e instanceof WdHttpError) throw e;
      throw stageError("CORRUPT", "WD_DOCUMENT_UNREADABLE", "stored document is not readable");
    }
    if (existing.form !== "onboarding" || existing.unique_form_key !== record.unique_form_key) throw stageError("CORRUPT", "WD_DOCUMENT_UNREADABLE", "stored document belongs to another submission");
    if (existing.fingerprint !== record.fingerprint) throw stageError("REJECTED", "WD_SUBMISSION_CONFLICT", "stored document belongs to a different submission content");
  }

  private async putDocument(folderId: string, record: SubmissionRecord, files: StoredFile[]): Promise<string> {
    const doc = buildDocument(record, files);
    let found = await this.candidates(folderId, DOCUMENT_NAME);
    if (found.length === 0) {
      const bytes = new TextEncoder().encode(canonicalJson(doc));
      try {
        await this.api.upload(folderId, DOCUMENT_NAME, bytes);
      } catch (e) {
        if (!(e instanceof WdHttpError) || !e.ambiguous) throw e;
        this.log("workdrive.upload_ambiguous");
      }
      found = await this.candidates(folderId, DOCUMENT_NAME);
      if (found.length === 0) throw stageError("UNAVAILABLE", "WD_UNAVAILABLE", "document upload could not be confirmed");
    }
    if (found.length > 1) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "more than one canonical document");
    const item = found[0] as WdItem;
    if (item.name !== DOCUMENT_NAME || item.parent_id !== folderId) throw stageError("CORRUPT", "WD_AMBIGUOUS_FILES", "stored document is not the expected item");
    // Resume or recovery: the document may come from an earlier attempt (different `submitted_at`), so compare identity, not bytes.
    let existing: { form?: unknown; unique_form_key?: unknown; fingerprint?: unknown; files?: unknown };
    try {
      existing = JSON.parse(new TextDecoder().decode(await this.api.download(item.id))) as typeof existing;
    } catch (e) {
      if (e instanceof WdHttpError) throw e;
      throw stageError("CORRUPT", "WD_DOCUMENT_UNREADABLE", "stored document is not readable");
    }
    const sameRefs = canonicalJson(existing.files) === canonicalJson(doc.files);
    if (existing.form !== "onboarding" || existing.unique_form_key !== record.unique_form_key || existing.fingerprint !== record.fingerprint || !sameRefs) {
      // Submission conflict: the same key already holds a document for different content (another fingerprint or file set).
      throw stageError("REJECTED", "WD_SUBMISSION_CONFLICT", "stored document belongs to a different submission content");
    }
    return `wd:${item.id}`;
  }
}

/**
 * CRM writer decorator: stage in WorkDrive first, then hand the record (with file refs and `document_ref`) to the CRM
 * writer. Runs only for the ledger claim holder (the single place a write may start), so concurrent identical
 * submissions never stage twice.
 */
export class WorkDriveStagingWriter implements CrmWriter {
  constructor(
    private readonly inner: CrmWriter,
    private readonly storage: WorkDriveSubmissionStorage,
  ) {}

  /**
   * Step 1 (ledger phase "staging"): put the files and the canonical document into WorkDrive and return the record that
   * carries the file refs and `document_ref`. Idempotent and resumable; it never touches the CRM. A death of the worker in
   * this step is therefore safe to take over (no CRM POST can have started).
   */
  async prepare(record: SubmissionRecord, extras?: SubmissionExtras): Promise<SubmissionRecord> {
    const staged = await this.storage.stage(record, extras?.fileBytes ?? {});
    return { ...record, files: staged.files, document_ref: staged.documentRef };
  }

  /** Step 2 (ledger phase "sending"): the single CRM create. Stages first only when nobody called `prepare` (legacy direct use). */
  async create(record: SubmissionRecord, extras?: SubmissionExtras): Promise<CreateResult> {
    const ready = record.document_ref ? record : await this.prepare(record, extras);
    return this.inner.create(ready, extras);
  }

  lookupId(uniqueFormKey: string): Promise<string | null> {
    return this.inner.lookupId(uniqueFormKey);
  }

  readRecord(recordId: string, uniqueFormKey: string): Promise<StoredRef> {
    return this.inner.readRecord(recordId, uniqueFormKey);
  }
}

/** Marks files as "written later by the staging writer": the service passes bytes along instead of uploading them. */
export class DeferredFileSink implements FileSink {
  readonly deferred = true;

  async put(): Promise<string> {
    throw new StoreError("NOT_CONFIGURED", "files are staged by the WorkDrive writer", "SINK_DEFERRED");
  }
}
