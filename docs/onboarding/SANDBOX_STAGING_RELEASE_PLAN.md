# Sandbox readiness, Staging plan and ordered Production checklist (2026-10-20)

Claim levels: **Source** (read in code), **Local test** (mocks), **Sandbox UI** (read-only observation of the Sandbox Setup UI), **Sandbox API** (a real API call: none yet), **Proposed**, **Unknown**, **Blocked**.

## 1. Sandbox readiness (PHASE B)

**Observed read-only in the Sandbox Setup UI (2026-10-20, no data opened, nothing changed):** host `crmsandbox.zoho.com` with org path `org850673613` (web UI of the `.com` data centre; the API data centre still has to be proven by the token response, the config does not assume it). Modules present: Leads, Contacts, Deals, Requests, Products, Email Logs, Consultation Submissions. Deals fields: "Contact Name" (Lookup), "Product" (Lookup, custom), "Product Related to" (Single Line, custom). **The module displayed as "Requests" is listed with the module name `CustomModule3`** (the Trello discovery doc says the same for Production). The REST API addresses a module by API name, so the default `Requests` is probably wrong for a live Sandbox: the code now reads `SIX2FIT_ONBOARDING_REQUESTS_MODULE` and must be set to the real API name (**Unknown until a real `GET /settings/modules` is read**; the readiness probe reports a mismatch).

Missing configuration (nothing was available in this session: no `S2F_*`/`SIX2FIT_*` variables, and the Claude Zoho connectors are Production-bound):
1. CRM writer grant (Sandbox), optional dedicated read-only grant, optional send-mail grant (do not create without approval).
2. WorkDrive-only grant, the WorkDrive test folder id and exact title, the WorkDrive data centre.
3. `SIX2FIT_ZOHO_ORG_ZGID`, `_API_DOMAIN`, `_ACCOUNTS_DOMAIN`, `_MODULE_ID_PREFIX` (`6223361000`), `SIX2FIT_EXPECTED_ORG_ID`, `SIX2FIT_ONBOARDING_REQUESTS_MODULE`, `SIX2FIT_PRODUCT_SCOPE_MAP`, `SIX2FIT_OPS_CALLER_SECRET`, `SIX2FIT_ONBOARDING_TOKEN_SECRET`, `SIX2FIT_STAGING_STORAGE_DIR`, `SIX2FIT_FORM_BASE_URL`.
4. A synthetic Deal + Contact + Product in the Sandbox with a non-routable e-mail (`...@example.invalid`).
5. Confirmation that Sandbox workflows cannot reach real people (rules still point at the Production Flow app; staff addresses are copied users). The writer sends `trigger: []`; that suppression is **not yet observed** in the Sandbox.

Safety gate before any Sandbox write (all must be proven, otherwise do not write): organisation id equals the expected one and type is `sandbox` (checked by `verifyEnvironment`), data centre matches (`zoho-dc.ts`), WorkDrive root title matches, recipients are synthetic, workflow suppression observed.

## 2. Verification status (PHASE C)

| Item | Status |
|---|---|
| Local suite and `tsc` | **Verified (local test):** Onboarding 458 passed, 2 skipped, 0 failed; Consultation (read-only run, no change) 645 passed, 14 skipped, 0 failed |
| All 16 Sandbox checks (org identity, reader mappings, issuance, restart, 0/1-file submit, WorkDrive integrity, Request creation and mapping, duplicates, conflicts, interrupted upload, ambiguous CRM write, reconciliation, expired/revoked link, cross-org isolation) | **Blocked** (no credentials, no verified isolation). Not performed. Mock results exist for each but are not Sandbox evidence |
| Multi-file live test | **Not run** (needs separate approval) |
| Reader field names | **Sandbox UI** corroborates the labels for `Contact_Name`, `Product`, `Product_Related_to`; API names not read; Requests module API name conflicts with the default (see above) |

## 3. Legacy coexistence (REL-CUTOVER-LEGACY-01, deferred, nothing changed)

Facts (source / earlier discovery): Deals rule `Send Onboarding Form` (repeating, all Deals, no guard) calls `Send_Onboarding_Form`, which e-mails from `noreply@six2fit.com` and sends WhatsApp, and writes `Request_Form_Sent` regardless of delivery; the 25-day sender, 3-day reminder and the Create Form / Request Form buttons also send legacy links; `Trigger Onboarding Form Link` sets stored link fields. These run on Deal creation/edit, i.e. **before and independently of the new payment-verified invitation**: a customer can receive a legacy form link immediately and the new invitation later. **Risks:** duplicate or conflicting invitations, two Requests for one period (different `uniqueformkey`), `Request_Form_Sent` read as delivery. **Isolation for now:** the new journey never writes Deal link fields or `Request_Form_Sent`; Sandbox tests use only synthetic Deals created for the test and must not edit a Deal that a legacy rule watches, and Sandbox rules must be confirmed inactive or suppressed (`trigger: []`) before any write. Resolution (disable/guard/migrate) is the **last** Production gate.

## 4. CRM-to-WorkDrive staff access (T10)
Not implemented. Contract in `WD_ACCESS_CRM_BUTTON_PENDING.md`: button on the Requests module (API name per section 1) -> function reads `uniqueformkey` -> finds exactly one folder under the approved root -> returns the **private** folder link; WorkDrive membership enforces access; no share links; no CRM customisation or permission change was made. Read-only verification of private-link validity and membership enforcement needs a WorkDrive session and two test identities: **Blocked**.

## 5. Staging readiness matrix (nothing deployed)

| Check | Status |
|---|---|
| ShetabanHost runtime compatibility (Node 22, Passenger/LiteSpeed worker behaviour, `.output` handling) | Not Tested (known restart quirks are documented in the hosting notes) |
| Filesystem atomicity and hard links | Not Tested on the host (probe exists: readiness `storage_hardlink_atomic`; verified only on the local filesystem) |
| Persistence across process restart | Not Tested on the host (Local test only) |
| Multi-worker behaviour | Not Tested (cross-instance races tested locally with several store instances) |
| Request size and timeout | Not Tested (80 MB body cap in code; host timeout Unknown; lease/deadline budget enforced in code) |
| Environment configuration | Not Tested (names documented in `STAGING.md`; host panel exposes values: read names only) |
| CRM and WorkDrive connectivity from the host | Not Tested (outbound access from the host is Unknown) |
| Consultation and Onboarding UI regression, mobile, prefill, identity consistency | Not Tested in a browser on Staging (component and API tests pass locally) |
| Security (secrets, enumeration, headers) | Local test only |
| Error and recovery scenarios | Local test only |

## 6. Ordered Production checklist
1. Local implementation approved.
2. Sandbox integration evidence approved (all 16 checks with real evidence).
3. Staging deployment separately authorised and tested (section 5).
4. CRM/WorkDrive permissions verified (button, staff group, non-member denied).
5. Payment verification and e-mail delivery proven (WooCommerce read-only contract of six2fit.com, provider and sender approved, controlled test recipients).
6. Customer-facing form flows and mobile UX approved (including final Persian email copy).
7. Logging, recovery and rollback procedures approved.
8. Production environment configuration and launch authorisation completed (the code is Sandbox-only today: a Class 3 Change Plan is required).
9. Final Go/No-Go review completed.
10. **LAST GATE, REL-CUTOVER-LEGACY-01:** review and migrate the existing CRM Functions, Workflows and automations and old form links to the new journey, validate duplicate prevention and sending behaviour, and authorise final activation. **Not executed. Production is not ready while this gate is open.** The existing Production journey stays operational until then.
