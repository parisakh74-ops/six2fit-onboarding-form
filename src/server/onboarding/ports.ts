import type { Scope, Subject } from "./tokens";
import type { AnswerValue } from "./validate";

/** A stored file reference: metadata plus where the sink put it (never the bytes). */
export type StoredFile = { key: string; name: string; type: string; size: number; sha256: string; ref?: string };

/** What the service hands to persistence. Answers are complete; nothing is dropped or truncated here. */
export type SubmissionRecord = {
  /** Ledger / idempotency id (one onboarding per signed link). */
  subject_key: string;
  /** CRM `uniqueformkey`. */
  unique_form_key: string;
  /** Canonical SHA-256 of subject + scope + answers + verification state + file hashes (independent of the browser submission id). */
  fingerprint: string;
  scope: Scope;
  subject: Subject;
  link_id: string;
  entitlements: string[];
  answers: Record<string, AnswerValue>;
  verification_state: Record<string, string>;
  files: StoredFile[];
  submitted_at: string;
  /** Free context for the CRM adapter (from the signed link). */
  is_first_request?: boolean | undefined;
  product_related_to?: string | undefined;
};

/** What a store remembers about a settled submission (never the answers). */
export type StoredRef = { fingerprint: string; submitted_at: string; record_ref?: string };

export type CreateResult = { status: "created"; record: StoredRef } | { status: "exists"; record: StoredRef };

/**
 * Create-only persistence port for Onboarding submissions. Implementations MUST: never overwrite or delete, make
 * `create` atomic and idempotent per subject (exactly one concurrent caller gets `created`), and throw `StoreError`
 * (without answers) on failure. A failed or ambiguous write is never reported as created.
 */
export interface OnboardingStore {
  get(subjectKey: string): Promise<StoredRef | null>;
  create(subjectKey: string, record: SubmissionRecord): Promise<CreateResult>;
}

/** The CRM side used by the ledger: one POST per attempt, lookups by `uniqueformkey` (positive hits only are proof). */
export interface CrmWriter {
  create(record: SubmissionRecord): Promise<CreateResult>;
  lookupId(uniqueFormKey: string): Promise<string | null>;
  readRecord(recordId: string, uniqueFormKey: string): Promise<StoredRef>;
}

/** Customer facts resolved from a signed link, used for prefill and eligibility. */
export type PrefillResult = { prefill: Record<string, unknown> };

/**
 * Resolves what the server knows about the subject of a link. Implementations: Consultation file hand-off (staging),
 * mock (tests), CRM Deals/Contacts reader (NOT built: its business rules and field contracts are unverified).
 * Must fail closed: throw `StoreError` when the subject cannot be resolved.
 */
export interface SubjectDirectory {
  resolve(subject: Subject): Promise<PrefillResult | null>;
}

/** Where uploaded files go. The staging sink writes to local disk (development only); the CRM/WorkDrive sink is a decision. */
export interface FileSink {
  put(subjectKey: string, key: string, file: { name: string; type: string; bytes: Uint8Array; sha256: string }): Promise<string>;
}
