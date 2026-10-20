# Staging runbook — Six2Fit Onboarding

This repository is configured for a local `staging` mode. It is intentionally not connected to Zoho Production.

```bash
cp .env.staging.example .env.staging
npm install
npm test -- --run
npm run build:staging
npm run dev:staging
```

For a ShetabanHost Node.js application, use the portable build command (works
from PowerShell and Unix shells). It builds the Nitro `node-middleware` preset that the host's
`passenger.cjs` expects and bakes the git commit into the bundle:

```bash
npm run build:shetaban
```

- Application root: `/home/tofitcom/onboarding-staging-repo`
- Startup file: `passenger.cjs`
- Node.js: 22.x on the host (verified 22.23.3 in cPanel, 2026-10-13)
- Application mode: production

DEPLOYMENT WARNING (see the change plan, sections 37-40 of FORMS-CRM-001): the host serves static assets from the live
`.output` and `tmp/restart.txt` does not restart the application. Never delete or replace the old hashed assets or swap
`.output` as a whole before a working restart is proven; follow `changes/proposed/FORMS-CRM-001_STAGING_DEPLOY_AND_RESTART_PROCEDURE.md`.

The server-only environment variables must be entered in cPanel's Node.js
application environment-variable panel; never commit them or expose them as
`VITE_*` variables.

## Backend (src/server/onboarding)

The browser calls same-origin `/api/onboarding/bootstrap` and `/api/onboarding/submit` (also reachable as `/?six2fit_api=bootstrap|submit`).
Server-only variables:

| Variable | Meaning |
|---|---|
| `SIX2FIT_STAGING_MODE` | `true` (the API is staging-only; host must contain `onboarding-staging`) |
| `SIX2FIT_ONBOARDING_TOKEN_SECRET` | >= 32 random characters, signs the onboarding links. **Onboarding-only: the Consultation service holds no signing secret (O1).** Also used by the internal link-issuer route |
| `SIX2FIT_ISSUER_CALLER_SECRET` | >= 32 characters, authenticates the CRM Function that calls the link issuer (separate from every other secret) |
| `SIX2FIT_ACCEPT_CONSULT_HANDOFF` | `true` only for local/staging development: accepts Consultation (v1) hand-off tokens and then also honours the legacy `SIX2FIT_STAGING_TOKEN_SECRET`. **Never set in a production-like deployment; ignored when the store is `crm`** |
| `SIX2FIT_CONSULT_PREFILL_ENABLED`, `SIX2FIT_CONSULT_PREFILL_WINDOW_DAYS` (default 90), `SIX2FIT_CONSULT_PREFILL_CANDIDATE_LIMIT` (default 10) | Consultation prefill for Deal links (eight keys, first cycle, read-only); needs the Production `Consultation_Submissions` module and read grant |
| `SIX2FIT_STAGING_STORAGE_DIR` | local development store (plaintext answers/uploads: never Production data) |
| `SIX2FIT_ONBOARDING_STORE` | `file` (default) or `crm` (Sandbox Requests adapter, explicit) |
| `SIX2FIT_ONBOARDING_CRM_ENABLED`, `SIX2FIT_ZOHO_*`, `SIX2FIT_ONBOARDING_RAW_FIELD`, `SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS`, `SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG`, `SIX2FIT_ONBOARDING_LEDGER_DIR` | see `src/server/onboarding/crm/config.ts`; CRM mode refuses to start without the complete-answers field and a Sandbox organisation |
| `SIX2FIT_ONBOARDING_CRM_PERSISTENCE` | `raw-field` (default), `workdrive-key` (MVP: answers and files only in WorkDrive) or `workdrive-ref` |
| `SIX2FIT_WORKDRIVE_*` (root folder id/name, accounts domain, API base, WorkDrive-only client id/secret/refresh token, timeouts, token cache dir, cross-DC flag) | WorkDrive persistence modes; see `docs/onboarding/WORKDRIVE_INTEGRATION_CONTRACT.md` and `WORKDRIVE_OAUTH_SETUP.md` |
| `SIX2FIT_ZOHO_READER_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | optional dedicated READ-ONLY CRM grant for the Deal reader (otherwise the writer grant is reused) |
| `SIX2FIT_OPS_CALLER_SECRET` | >= 32 characters, signs readiness / reconciliation calls (`docs/onboarding/OPERATIONS_RUNBOOK.md`) |
| `SIX2FIT_EXPECTED_ORG_ID`, `SIX2FIT_PRODUCT_SCOPE_MAP`, `SIX2FIT_FORM_BASE_URL`, `SIX2FIT_LINK_TTL_SECONDS` | Deal directory / link issuer |
| `SIX2FIT_WOO_WEBHOOK_SECRET`, `SIX2FIT_WOO_BASE_URL`, `SIX2FIT_WOO_CONSUMER_KEY` / `_CONSUMER_SECRET`, `SIX2FIT_PAYMENT_GATEWAYS` | payment-driven first invitation; **inert without a delivery channel** (`docs/onboarding/PAYMENT_INVITATION_ONB_PAY_01.md`) |
| `SIX2FIT_ONBOARDING_REQUESTS_MODULE` | API name of the module displayed as "Requests" (default `Requests`; the Sandbox UI shows `CustomModule3`: confirm with `GET /settings/modules`) |
| `SIX2FIT_EMAIL_DELIVERY_MODE` (+ `SIX2FIT_EMAIL_*`, `SIX2FIT_ZOHO_MAILER_*`) | first-invitation e-mail, **OFF by default**; see `docs/onboarding/EMAIL_DELIVERY_ONB_DELIVERY_01.md` |

Links: v1 = Consultation hand-off (`consult_submission_id`), **refused by default**; v2 = Deal-bound link (`deal_id`, `jti`): the issuer of v2 links is an open product decision.
The `crm` store must not be enabled until the decisions listed in `changes/proposed/FORMS-CRM-001_ONBOARDING_STATE_AND_CONTRACT.md` (section 3) are made and a bounded Sandbox test plan is approved.

Never put OAuth client secrets, refresh tokens, signing keys, or Zoho org credentials in `VITE_*` values.
