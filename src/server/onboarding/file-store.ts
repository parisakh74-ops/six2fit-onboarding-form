import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StoreError } from "./errors";
import type { CreateResult, FileSink, OnboardingStore, StoredRef, SubmissionRecord, SubjectDirectory, PrefillResult } from "./ports";
import type { Subject } from "./tokens";

const isErrno = (e: unknown, ...codes: string[]) => typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");
const KEY = /^onb_[0-9a-f]{40}$/;

/**
 * Local-file store for STAGING / development only (same role as the Consultation `FileConsultStore`): the record is
 * written to a private temp file and hard-linked to its final name, so exactly one concurrent caller creates it and a
 * crash never leaves a half-written record. It stores the complete answers in plaintext on the host: never use in
 * Production (health data). The CRM-backed store with the idempotency ledger replaces it.
 */
export class FileOnboardingStore implements OnboardingStore {
  constructor(private readonly baseDir: string) {}

  private dir() {
    return join(this.baseDir, "onboarding-v2");
  }

  private path(key: string) {
    if (!KEY.test(key)) throw new StoreError("UNAVAILABLE", "invalid id", "INVALID_ID");
    return join(this.dir(), `${key}.json`);
  }

  async get(key: string): Promise<StoredRef | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(key), "utf8");
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "read failed", "FILE_IO");
    }
    try {
      const r = JSON.parse(raw) as SubmissionRecord;
      if (typeof r.fingerprint !== "string") throw new Error("shape");
      return { fingerprint: r.fingerprint, submitted_at: r.submitted_at, record_ref: key };
    } catch {
      throw new StoreError("CORRUPT", "stored record is not readable", "FILE_CORRUPT");
    }
  }

  async create(key: string, record: SubmissionRecord): Promise<CreateResult> {
    const final = this.path(key);
    const temp = `${final}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(this.dir(), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new StoreError("UNAVAILABLE", "write failed", "FILE_IO");
    }
    try {
      await link(temp, final);
      return { status: "created", record: { fingerprint: record.fingerprint, submitted_at: record.submitted_at, record_ref: key } };
    } catch (e) {
      if (isErrno(e, "EEXIST")) {
        const existing = await this.get(key);
        if (existing) return { status: "exists", record: existing };
        throw new StoreError("UNAVAILABLE", "record vanished", "FILE_IO");
      }
      throw new StoreError("UNAVAILABLE", "link failed", "FILE_IO");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}

/** Development file sink: private files named by subject, key and content hash (idempotent on retry). */
export class LocalFileSink implements FileSink {
  constructor(private readonly baseDir: string) {}

  async put(subjectKey: string, key: string, file: { name: string; type: string; bytes: Uint8Array; sha256: string }): Promise<string> {
    const ext = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg";
    const name = `${subjectKey}-${key.replace(/[^A-Za-z0-9_.-]/g, "_")}-${file.sha256.slice(0, 16)}.${ext}`;
    try {
      await mkdir(join(this.baseDir, "uploads-v2"), { recursive: true, mode: 0o700 });
      const handle = await open(join(this.baseDir, "uploads-v2", name), "wx", 0o600);
      try {
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw new StoreError("UNAVAILABLE", "upload failed", "FILE_IO");
    }
    return `file:${name}`;
  }
}

/** The Consultation hand-off keeps its answers in `<storage>/consult/<id>.json`; only the mapped prefill is read. */
const PREFILL_KEYS = new Set(["ON-01", "ON-03", "ON-06.iso", "ON-06.cc", "ON-06.n", "ON-07", "ON-08", "ON-09.kg", "timezone"]);

/**
 * The Consultation payload stores `ON-06.n` as E.164 (`+<dial><local>`, see its `normalizePhone`), while the
 * Onboarding field `ON-06.n` is the national number (digits only; the dial code lives in `ON-06.cc`).
 * This is the exact inverse of that join: it removes the `<cc>` prefix only when the value starts with it.
 * Anything else (already national, different dial code, no digits left) is returned unchanged so that a
 * mismatch stays visible to the validation instead of being guessed.
 */
export function nationalPhoneFromPrefill(value: string, dial: unknown): string {
  if (typeof dial !== "string" || !/^\+\d{1,4}$/.test(dial) || !value.startsWith(dial)) return value;
  const national = value.slice(dial.length);
  return /^\d+$/.test(national) ? national : value;
}

export class ConsultHandoffDirectory implements SubjectDirectory {
  constructor(private readonly storageDir: string) {}

  async resolve(subject: Subject): Promise<PrefillResult | null> {
    if (subject.kind !== "consult") {
      // Deal-bound links need a CRM resolver (eligibility rules and Deals/Contacts contracts are not verified): fail closed.
      throw new StoreError("NOT_CONFIGURED", "no resolver for this link type", "IDENTITY_UNAVAILABLE");
    }
    let raw: string;
    try {
      raw = await readFile(join(this.storageDir, "consult", `${subject.consultSubmissionId}.json`), "utf8");
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "read failed", "FILE_IO");
    }
    let payload: { onboarding_prefill?: Record<string, unknown> } | undefined;
    try {
      payload = (JSON.parse(raw) as { payload?: { onboarding_prefill?: Record<string, unknown> } }).payload;
    } catch {
      throw new StoreError("CORRUPT", "consultation record is not readable", "FILE_CORRUPT");
    }
    if (!payload) return null;
    const prefill: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload.onboarding_prefill ?? {})) {
      if (PREFILL_KEYS.has(k) && (typeof v === "string" || typeof v === "number") && String(v).length <= 255) prefill[k] = v;
    }
    const phone = prefill["ON-06.n"];
    if (typeof phone === "string") prefill["ON-06.n"] = nationalPhoneFromPrefill(phone, prefill["ON-06.cc"]);
    return { prefill };
  }
}
