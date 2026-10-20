# Onboarding -> WorkDrive -> CRM Requests: integration contract and runtime

Status (2026-10-20): **implemented and mock-tested locally.** Nothing here has run against a live Zoho Sandbox, ShetabanHost Staging or Production. Every "verified" below means "verified by an automated local test with mocks" unless it says otherwise.

## Runtime composition (single composition point: `crm/runtime.ts` `createCrmRuntime`, called by `http.ts` `runtimeFromEnv`)

```
POST /api/onboarding/submit -> handleSubmit -> service.submit (validate, token, Deal directory)
  raw-field mode:          LocalFileSink -> LedgerOnboardingStore -> RequestsStore
  workdrive-key / -ref:    DeferredFileSink (uploads stay in memory, never on the local disk)
                           -> LedgerOnboardingStore
                                phase "staging": WorkDriveStagingWriter.prepare -> WorkDriveSubmissionStorage -> HttpWorkDriveApi -> WorkDriveTokenProvider
                                phase "sending": WorkDriveStagingWriter.create -> RequestsStore (ONE CRM POST)
```

* The runtime is built **once per process** (`http.ts` `getRuntime`): OAuth tokens and the organisation check are reused. A failed build is not cached.
* Missing or inconsistent configuration fails closed (`503 STAGING_UNAVAILABLE`) before any network call.

## Configuration (names only; values never in the repository)

| Variable | Purpose |
|---|---|
| `SIX2FIT_ONBOARDING_STORE=crm`, `SIX2FIT_ONBOARDING_CRM_ENABLED=true`, `SIX2FIT_ZOHO_*` | CRM Requests writer (Sandbox only; see `crm/config.ts`) |
| `SIX2FIT_ONBOARDING_CRM_PERSISTENCE=workdrive-key` | files and complete answers live only in WorkDrive |
| `SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID` / `_NAME` | the approved root Team Folder and its exact title |
| `SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN` | `https://accounts.zoho.<dc>` (Canada: `https://accounts.zohocloud.ca`) |
| `SIX2FIT_WORKDRIVE_API_BASE` | `https://www.zohoapis.<dc>/workdrive/api/v1` (same data centre) |
| `SIX2FIT_WORKDRIVE_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | the WorkDrive-only grant (must differ from the CRM refresh token) |
| `SIX2FIT_WORKDRIVE_ALLOW_CROSS_DC` | `true` only if the WorkDrive team really is in another data centre than the CRM |
| `SIX2FIT_WORKDRIVE_TIMEOUT_MS` (20000), `SIX2FIT_WORKDRIVE_STAGING_DEADLINE_MS` (90000) | per-call timeout, staging budget |
| `SIX2FIT_WORKDRIVE_TOKEN_CACHE_DIR` | optional private directory shared by workers for the short-lived access token |
| `SIX2FIT_ZOHO_READER_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | optional dedicated READ-ONLY CRM grant (otherwise the writer grant is reused and readiness reports `SHARED_GRANT`) |
| `SIX2FIT_OPS_CALLER_SECRET` (>= 32) | signs the readiness / reconciliation calls |
| `SIX2FIT_EXPECTED_ORG_ID`, `SIX2FIT_PRODUCT_SCOPE_MAP`, `SIX2FIT_ONBOARDING_TOKEN_SECRET`, `SIX2FIT_STAGING_STORAGE_DIR` | as in `STAGING.md` |

Time budget (T08): the ledger lease defaults to `max(staging deadline + 5 x WorkDrive timeout, (CRM attempts + 3) x CRM timeout) + 30 s` (220 s with defaults). An explicit `SIX2FIT_ONBOARDING_LEDGER_LEASE_MS` shorter than that is refused (`LEASE_TOO_SHORT`). The host's own request timeout is **Unknown** and must be measured on ShetabanHost; this code does not claim compatibility.

## Contract A: Onboarding -> WorkDrive -> CRM Requests

| Item | Definition |
|---|---|
| Trigger | one valid submit with a signed Deal link that passes the Deal directory check |
| Unique id | `uniqueformkey` (`onb2_<dealId>_<linkId>`) = WorkDrive folder name; ledger id = subject key |
| WorkDrive layout | `<root>/<uniqueformkey>/{<answerKey>-<sha16>.<ext>..., submission.v1.json}`, SHA-256 verified after upload, never overwritten or deleted |
| CRM | one create in `Requests` with the structured mapping; no raw JSON, no document field (`workdrive-key`) |
| Source of truth | WorkDrive: complete answers and files. CRM: structured Request. Ledger: idempotency only |
| Success | WorkDrive verified, one Request, ledger `created`, HTTP 200 |
| Failure | WorkDrive refused / deadline: claim released, 503, retry resumes. Process death while staging: taken over after the lease. CRM definite refusal: released. CRM ambiguous / death after `sending`: never re-POSTed; lookup only; `OUTCOME_UNKNOWN` / `needs_review` |
| Idempotency | identical retry -> `deduplicated:true`; same key different content -> 409 before any upload; ten concurrent identical submits -> one Request |
| Reconciliation | `POST /api/internal/onboarding-reconcile` (read-only), see the runbook |
| Environment | local mocks verified; Sandbox, Staging, Production **not verified** |

## Contract B: CRM Request -> authorised staff -> WorkDrive documents

Approved (WD-ACCESS-01/02): shared access for the approved staff group; WorkDrive enforces authentication and membership; no public links. The CRM button is **not implemented in this repository**: see `WD_ACCESS_CRM_BUTTON_PENDING.md`. Not operational.
