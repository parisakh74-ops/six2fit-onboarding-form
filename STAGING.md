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
from PowerShell and Unix shells), then configure Passenger with:

```bash
npm run build:shetaban
```

- Application root: the staging domain document root
- Startup file: `.output/server/index.mjs`
- Node.js: 20.x on the host
- Application mode: production

The server-only environment variables must be entered in cPanel's Node.js
application environment-variable panel; never commit them or expose them as
`VITE_*` variables.

The browser calls same-origin `/api/onboarding/bootstrap` and `/api/onboarding/submit`. A staging backend must resolve a synthetic user/order to exactly one Request, provide short-lived bootstrap tokens, durable idempotency, non-production file storage, and a Zoho CRM Sandbox adapter. Never put OAuth client secrets, refresh tokens, signing keys, or Zoho org credentials in `VITE_*` values.

A successful UI build does not mean the Resolver or CRM integration exists.
