# Onboarding persistence: WorkDrive-key MVP (Architecture B)

Status: **implemented locally and mock-tested only.** Nothing here has been run against Zoho CRM or Zoho WorkDrive in this configuration. No deployment, no commit.

## What it is

Third CRM persistence strategy, `SIX2FIT_ONBOARDING_CRM_PERSISTENCE=workdrive-key` (the existing `raw-field` and `workdrive-ref` modes are unchanged).

```
validated submission
  -> ledger claim (one writer per submission key)
  -> WorkDrive:  <root>/<uniqueformkey>/{<key>-<sha16>.<ext> ..., submission.v1.json}   (canonical JSON + files)
  -> CRM Requests: ONE create with `uniqueformkey` + the existing 63-key structured mapping
                   (no raw JSON, no document URL, no reference field)
  -> reconciliation / recovery: join by the same `uniqueformkey`
```

The complete answers and all attachments live **only** in WorkDrive. The CRM Request links to them logically through `uniqueformkey` (= WorkDrive folder name). No CRM schema change is needed.

## Configuration (workdrive-key)

| Variable | Rule |
|---|---|
| `SIX2FIT_ONBOARDING_CRM_PERSISTENCE` | `workdrive-key` |
| `SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID` | required, 20-64 alphanumerics (the approved root Team Folder) |
| `SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME` | required (verified against the live folder title before any write) |
| `SIX2FIT_ONBOARDING_RAW_FIELD` | must be **unset** (raw JSON never reaches the CRM) |
| `SIX2FIT_ONBOARDING_DOC_REF_FIELD` | must be **unset** (no reference field in this mode) |

Missing or malformed values fail with `NOT_CONFIGURED`. `Verified_From` and `Document_Reference` are never written or referenced by this code.

## Idempotency and recovery (all Local Mock-Tested)

| Situation | Behaviour |
|---|---|
| Identical retry | deduplicated; no second Request; no WorkDrive upload |
| Same key, different content | HTTP 409 `SUBMISSION_CONFLICT`; refused **before** any file is uploaded; nothing overwritten |
| WorkDrive success, explicit CRM refusal | claim released; retry reuses the staged items |
| CRM success, response lost | no second POST; one lookup; unresolved = `OUTCOME_UNKNOWN`/`needs_review`; a hit is verified against the WorkDrive document of the same key |
| Ledger lost | identical retry: the CRM unique key refuses the duplicate insert, the record is read back and its document verified -> deduplicated; conflicting retry -> 409 |
| Duplicate folders / documents, tampered document | integrity error (`CORRUPT`); nothing is picked, repaired or deleted |
| WorkDrive temporarily unavailable | retryable `UNAVAILABLE`; never reported as "missing" or "damaged" |

Error codes of `readDocumentIdentityByKey`: `WD_INVALID_KEY`, `WD_FOLDER_NOT_FOUND`, `WD_AMBIGUOUS_FOLDER`, `WD_DOCUMENT_MISSING`, `WD_AMBIGUOUS_FILES`, `WD_DOCUMENT_UNREADABLE`, `WD_DOCUMENT_TAMPERED`, `WD_UNAVAILABLE`, `WD_RATE_LIMITED`, `WD_UNAUTHENTICATED`, `WD_FORBIDDEN`.

## Reconciliation (`workdrive/reconcile.ts`, read-only)

Inputs: the keys of the CRM Requests to check (the CRM writer has no listing; supply them from a CRM report) + the WorkDrive root. Output: per-key status and aggregate counts only (`matched`, `crm_without_folder`, `crm_without_document`, `ambiguous_folder`, `ambiguous_document`, `integrity_failure`, `workdrive_unavailable`, `invalid_key`, `orphan_workdrive`, `crm_found_unlisted`, `crm_lookup_failed`). It never writes, repairs, moves or deletes, and carries no answers, file names, links or credentials. `orphan_workdrive` is **not** proof that no Request exists (CRM search index lag ~20 s; an empty search is never evidence): confirm after the quiescence window.

## Pre-Production blockers (documented, not removed)

1. **Root listing cost.** Finding a submission folder lists every child of the root (pages of 50). `WorkDriveSubmissionStorage.findOrCreateFolder` lists the root up to twice per submission; `readDocumentIdentityByKey` once per call (reconciliation reuses one listing for all keys).
2. **5,000-item ceiling.** `HttpWorkDriveApi.list` stops with an error after 5,000 items on purpose (a silent truncation would make a missing folder look absent and permit a duplicate). The root therefore cannot hold more than 5,000 submission folders. See `WORKDRIVE_LOOKUP_SCALING_PROPOSAL.md`.
3. **Cross-process ledger atomicity** (hard-link claim) is proven only on the local development filesystem, not on the host.
4. **WorkDrive listing consistency** after a write is unverified at scale (one live run saw immediate visibility).
5. **`trigger: []`** (workflow suppression on API create) is documented by Zoho but not observed in the Sandbox.
6. **API rate limits** of WorkDrive are unknown.

## Unresolved operational dependency

Medical and Support staff must eventually reach the authorized Onboarding documents from their normal workflow. With no CRM link field, a person would have to search WorkDrive by folder name (the key contains the Deal id). That is **not** an approved end state. Options (a CRM button, a Note with the private link, a separate Onboarding Submission module, or a reporting view) are a Product decision. No staff UI and no CRM layout change is part of this phase.

## Live-tested vs local mock-tested

- **Live-tested earlier (WorkDrive test folder, synthetic data):** WorkDrive adapter staging, SHA-256 verification, multi-file interruption/recovery, lost-answer recovery, identical retry, same-key conflict.
- **Local mock-tested only (this phase):** the `workdrive-key` mode end to end with the CRM mock, the by-key resolution, the conflict-before-upload guard, ledger-loss recovery and the reconciliation report.
- **Never live-tested:** any CRM write of this mode, the CRM search/duplicate path against WorkDrive evidence, reconciliation against real data.
