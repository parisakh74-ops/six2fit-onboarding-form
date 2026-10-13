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
| `SIX2FIT_STAGING_TOKEN_SECRET` | >= 32 characters, signs the onboarding links (same secret as the Consultation service issues with) |
| `SIX2FIT_STAGING_STORAGE_DIR` | local development store (plaintext answers/uploads: never Production data) |
| `SIX2FIT_ONBOARDING_STORE` | `file` (default) or `crm` (Sandbox Requests adapter, explicit) |
| `SIX2FIT_ONBOARDING_CRM_ENABLED`, `SIX2FIT_ZOHO_*`, `SIX2FIT_ONBOARDING_RAW_FIELD`, `SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS`, `SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG`, `SIX2FIT_ONBOARDING_LEDGER_DIR` | see `src/server/onboarding/crm/config.ts`; CRM mode refuses to start without the complete-answers field and a Sandbox organisation |

Links: v1 = Consultation hand-off (`consult_submission_id`); v2 = Deal-bound link (`deal_id`, `jti`): the issuer of v2 links is an open product decision.
The `crm` store must not be enabled until the decisions listed in `changes/proposed/FORMS-CRM-001_ONBOARDING_STATE_AND_CONTRACT.md` (section 3) are made and a bounded Sandbox test plan is approved.

Never put OAuth client secrets, refresh tokens, signing keys, or Zoho org credentials in `VITE_*` values.
