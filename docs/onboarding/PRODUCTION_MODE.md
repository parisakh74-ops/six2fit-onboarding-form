# Production mode (code support only; nothing is deployed or written)

The CRM configuration now takes an EXPLICIT environment, `SIX2FIT_ZOHO_ENVIRONMENT=sandbox|production` (no default, never inferred
from a token or host). Everything below must match it or the runtime refuses to start (`NOT_CONFIGURED`) or to write (`ENV_MISMATCH`):

| | sandbox | production |
|---|---|---|
| `SIX2FIT_ZOHO_API_DOMAIN` | `https://sandbox.zohoapis.<dc>` | `https://www.zohoapis.<dc>` |
| `SIX2FIT_ZOHO_ACCOUNTS_DOMAIN` | `https://accounts.zoho.<dc>` (same DC) | same |
| `SIX2FIT_ZOHO_ORG_ZGID` | Sandbox org (required) | Production org (required) |
| `SIX2FIT_ZOHO_ORG_API_ID` | optional; must NOT start `6067417000` | **required**; must start `6067417000` |
| `SIX2FIT_ZOHO_MODULE_ID_PREFIX` | never `6067417000...` | must be `6067417000...` |
| `GET /org` `type` | `sandbox` | `production` |
| token `api_domain` | sandbox host or `www` host of the same DC | exactly the configured `www` host |

Before the first write (and every 15 min) the client checks org zgid, org API id, org type, module id prefix. Workflows stay
suppressed (`trigger: []`) unless `SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS=true`. E-mail delivery is refused outside Sandbox.
The operator live tests keep their own Sandbox-only guards.

## Environment variable names (Production, values not recorded here)
`SIX2FIT_ONBOARDING_STORE=crm`, `SIX2FIT_ONBOARDING_CRM_ENABLED`, `SIX2FIT_ZOHO_ENVIRONMENT`, `SIX2FIT_ZOHO_ORG_ZGID`, `SIX2FIT_ZOHO_ORG_API_ID`,
`SIX2FIT_ZOHO_API_DOMAIN`, `SIX2FIT_ZOHO_ACCOUNTS_DOMAIN`, `SIX2FIT_ZOHO_MODULE_ID_PREFIX`, `SIX2FIT_EXPECTED_ORG_ID`,
`SIX2FIT_ZOHO_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN` (writer), `SIX2FIT_ZOHO_READER_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN` (read-only),
`SIX2FIT_ONBOARDING_REQUESTS_MODULE` (`Requests`), `SIX2FIT_ONBOARDING_CRM_PERSISTENCE=workdrive-key`, `SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID/_NAME`,
`SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN/_API_BASE/_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN`, `SIX2FIT_PRODUCT_SCOPE_MAP`, `SIX2FIT_ONBOARDING_TOKEN_SECRET`,
`SIX2FIT_OPS_CALLER_SECRET`, `SIX2FIT_STAGING_STORAGE_DIR` (persistent, outside the web root), `SIX2FIT_FORM_BASE_URL`.

## OAuth scopes the application needs (not requested or configured)
- CRM writer (Requests create + environment check + duplicate lookup): `ZohoCRM.org.READ`, `ZohoCRM.settings.modules.READ`,
  `ZohoCRM.modules.custom.CREATE`, `ZohoCRM.modules.custom.READ`, `ZohoSearch.securesearch.READ`. (The Requests module is a custom module.)
- CRM reader (Deal-bound links; READ-ONLY grant): `ZohoCRM.org.READ`, `ZohoCRM.settings.modules.READ`, `ZohoCRM.settings.fields.READ`
  (readiness), `ZohoCRM.modules.deals.READ`, `ZohoCRM.modules.contacts.READ`, `ZohoCRM.modules.custom.READ` (prior Requests), `ZohoSearch.securesearch.READ`.
- WorkDrive (separate grant, never the CRM grant): `WorkDrive.files.CREATE`, `WorkDrive.files.READ`, plus whatever folder listing/creation the
  approved root needs (the Sandbox live tests passed with these two).
- Not needed and not to be granted: `ZohoCRM.send_mail.deals.CREATE` (invitations are not enabled), any DELETE/UPDATE scope.
