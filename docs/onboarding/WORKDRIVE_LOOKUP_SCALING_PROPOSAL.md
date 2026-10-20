# Proposal: scalable WorkDrive submission lookup

Status: **proposal only. Not implemented, not approved, not tested.** The tested layout `<root>/<uniqueformkey>/` is unchanged.

## Problem

Resolving a submission by `uniqueformkey` lists the children of the root and filters by name. Cost grows linearly (50 items per request) and the HTTP client deliberately fails beyond 5,000 items. This is acceptable for the Sandbox MVP and blocks Production.

## Options (to be compared with live evidence before any change)

1. **Monthly shards** `<root>/<YYYY-MM>/<uniqueformkey>/`. The month comes from `Submitted_At`, which the CRM mapping already writes, so the CRM-to-WorkDrive direction knows the shard exactly. Lookups list one shard. Risks: month-boundary and time-zone edges (resolve by writing and reading the UTC month of the stored `Submitted_At`, and checking both neighbours only on a miss), a migration step for folders created under the flat layout, and reconciliation that must list all shards.
2. **Per-Deal parent** `<root>/<dealId>/<uniqueformkey>/`. The Deal id is inside the key, so no date is needed, but finding the Deal folder still lists the root unless combined with option 1 or option 3.
3. **WorkDrive search by name.** Would remove listing entirely. Its endpoint, scope, consistency and rate limits are unverified; it needs a read-only live probe on the test folder first.
4. **Folder-id cache in the ledger.** Cheap on the hot path, but it is local state: after a ledger loss or host migration the fallback is still a listing, so it complements rather than replaces 1-3.
5. **CRM-side pointer** (separate field, Note, or an Onboarding Submission module) holding the folder or document id. Removes lookups, costs a CRM schema or module decision and a second write path; revisit together with the operational-access decision.

## Suggested evaluation order

1. Read-only probe of WorkDrive search (option 3) on the test root with synthetic folders.
2. If search is unsuitable: option 1 with option 4 as an accelerator.
3. Whatever is chosen: keep the 5,000-item guard (or its per-shard equivalent), add a migration/reconciliation test for the flat layout, and measure calls per submission and per reconciliation run.

## Acceptance criteria for any option

- No silent truncation: a listing that cannot be completed is an error, never "not found".
- Exactly one folder per key; duplicates are reported, never auto-resolved.
- Lookup cost per submission is bounded and independent of the total number of submissions.
- Existing flat-layout submissions stay resolvable.
- Reconciliation remains read-only.
