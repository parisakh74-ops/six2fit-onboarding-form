# Operations runbook: readiness, reconciliation, failure recovery, live QA

Local-mock status only. Nothing here was exercised on a live Sandbox or on ShetabanHost.

## Signed operations calls

`POST /api/internal/onboarding-readiness` and `POST /api/internal/onboarding-reconcile` (alias `POST /?six2fit_api=readiness|reconcile`). Authentication: the same HMAC scheme as the link issuer (`x-s2f-timestamp`, `x-s2f-signature` over `timestamp.METHOD.canonicalPath.sha256(body)`, 5-minute window) with `SIX2FIT_OPS_CALLER_SECRET` (>= 32 characters, separate from every other secret). Without that secret both answer `503 OPS_NOT_CONFIGURED`. Both only read.

* **Readiness** returns named checks: sandbox-only isolation, expected organisation, uploads not stored locally, hard-link capable storage (temporary probe files, removed), ledger readable, WorkDrive authentication and exact root-folder title, CRM organisation and the fields the reader needs, dedicated reader grant, required environment names. It creates no customer record and changes no customer data.
* **Reconciliation** body `{ "keys": ["onb2_..."] }` (up to 500 keys of CRM Requests to check; the CRM writer has no listing). Statuses per key: `matched`, `crm_without_folder`, `crm_without_document`, `ambiguous_folder`, `ambiguous_document`, `integrity_failure`, `workdrive_unavailable`, `invalid_key`, `orphan_workdrive`, `crm_found_unlisted`, `crm_lookup_failed`, plus the ledger overview (`by_state`, and `needs_attention` for `unknown`, `needs_review`, `integrity` and stale `in_progress`). `orphan_workdrive` and `crm_without_folder` are **not proof** (index lag ~20 s, listing lag): re-check after the quiescence window. Nothing is deleted, repaired or overwritten.

## Failure recovery

| Observation | Meaning | Action |
|---|---|---|
| 503 `STORAGE_UNAVAILABLE`, ledger `released` | WorkDrive or token problem before the CRM was touched | the browser retries; staged items are reused |
| ledger `in_progress` / `staging`, old | a worker died while staging | the next identical request takes over after the lease; no operator action |
| ledger `in_progress` / `sending`, old; `unknown`; `needs_review` | a CRM POST may have happened | never re-POST. After the quiescence window a lookup settles it; if still unresolved an authorised operator decides with `resolveManually` (`ledger.ts`, audited, needs evidence from the CRM after the index lag) |
| `integrity` / `DUPLICATE_RECORDS`, `WD_AMBIGUOUS_*`, `WD_DOCUMENT_TAMPERED` | duplicate or altered data | stop; investigate by hand; the code never resolves it |
| `WD_UNAUTHENTICATED` / `WD_AUTH_FAILED` | grant revoked, expired or wrong scope | see `WORKDRIVE_OAUTH_SETUP.md` |
| `LEASE_TOO_SHORT` at start | lease shorter than the time budget | remove the explicit lease or raise it |

## Live Sandbox QA safeguards (`*.live.test.ts`, never run by the default suite)

They run only when **all** of `S2F_LIVE_QA=1` (or `S2F_LIVE_MULTIFILE=1`), `S2F_WD_TOKEN`, `S2F_WD_ROOT_ID`, `S2F_WD_ROOT_NAME` (must look like `S2F-...TEST`) and `S2F_WD_API_BASE` (an exact `https://www.zohoapis.<dc>/workdrive/api/v1`) are set. Synthetic data only; no delete or overwrite exists in the API surface; `live-qa` stops after 8 POSTs and `live-multifile` after 10 writes. The multi-file test additionally needs explicit Product Manager approval.

## Sandbox sequence (when credentials exist)

1. Readiness probe is all `pass` (a `warn` for the shared reader grant is acceptable in the Sandbox).
2. Submit synthetic 0-, 1- and 7-file Onboardings; compare WorkDrive items and the Request.
3. Repeat identically (deduplicated), then with different content (409).
4. Kill the process during an upload, restart, retry.
5. Run reconciliation over the test keys.
6. Record actual evidence per step; a step that could not run is "not performed".
