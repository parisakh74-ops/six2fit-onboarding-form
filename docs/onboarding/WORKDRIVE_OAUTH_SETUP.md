# WorkDrive OAuth setup (least privilege)

Secrets are entered by the Product Manager / Technical Release Owner through the host's secret mechanism. They never go into the repository, chat, logs or `VITE_*` values. Nobody should paste a client secret or grant code into a chat.

1. **Data centre.** Find the data centre of the WorkDrive team and use its hosts (Zoho multi-DC page): accounts `accounts.zoho.<dc>` (Canada: `accounts.zohocloud.ca`) and API `https://www.zohoapis.<dc>/workdrive/api/v1`. The CRM and WorkDrive must be in the same data centre unless `SIX2FIT_WORKDRIVE_ALLOW_CROSS_DC=true` is set deliberately. Only `.com` and `.com.au` WorkDrive bases appeared in evidence; confirm the others in the Sandbox before use.
2. **Separate grant.** Create a Self Client (or server-based client) used only for WorkDrive. Do **not** reuse the CRM refresh token: the config refuses an equal token (`WORKDRIVE_GRANT_SHARED`), and the CRM grant is not known to carry WorkDrive scopes.
3. **Scopes (minimum, from the official scope table).** Start with `WorkDrive.files.CREATE,WorkDrive.files.READ`. If the root-folder check is refused, add `WorkDrive.teamfolders.READ`. Do not add `*.DELETE`, `*.ALL`, sharing (`WorkDrive.teamfolders.sharing.*`) or link (`WorkDrive.links.*`) scopes: the code never needs them. The exact minimum set is **Unknown until tested** in the Sandbox.
4. **Identity.** The grant's user must be a member of the approved root Team Folder with permission to create folders and upload files, and nothing else.
5. **Refresh.** The runtime refreshes access tokens itself (5-minute safety margin, one refresh at a time per process, bounded retries). An optional private cache directory (`SIX2FIT_WORKDRIVE_TOKEN_CACHE_DIR`) lets several worker processes share one short-lived access token; it never stores the refresh token or client secret.
6. **Rotation / revocation.** Revoke the refresh token in the Zoho API console; the next call fails closed as `WD_UNAUTHENTICATED` (503) and readiness reports it. Issue a new grant and restart the process.
7. **Verification.** After configuring a Sandbox, run the readiness probe (see the runbook) before any submission.
