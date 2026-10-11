# Six2Fit onboarding — launch readiness checkpoint

This archive contains the onboarding UI from the supplied Lovable project. The supplied project has no server routes, CRM adapter, OAuth configuration, or file storage worker. The client therefore fails closed until the application provides the two same-origin endpoints below.

## Implemented in this checkpoint

- Removed the sample order and sample person prefill from the client.
- Removed the mock submit delay.
- Scope and add-on entitlements come only from a validated server bootstrap; URL parameters and browser record IDs are not trusted.
- Added a typed bootstrap contract and a multipart submit contract with a per-submit `submission_id` and `Idempotency-Key`.
- Kept resume data namespaced to a new storage key and merged it with the server prefill only after bootstrap succeeds.
- The UI does not render or submit the form when bootstrap is missing, expired, malformed, or unavailable.

## Required server contract

`GET /api/onboarding/bootstrap` must authenticate the current user/session and resolve the target Request on the server. It returns:

```json
{
  "form_session_token": "opaque, short-lived token",
  "scope": "Diet | Training | Combo | CIP",
  "entitlements": ["cellulite"],
  "prefill": {},
  "expires_at": "2026-10-11T12:00:00.000Z"
}
```

The resolver must derive identity from the authenticated session and trusted CRM/order context. It must ignore any Request/Deal/Contact ID supplied by the browser, require exactly one eligible Request, verify ownership/association and entitlement, and fail closed on zero or multiple matches. The opaque token must bind the resolved Request, user, tenant, expiry, and allowed fields; it must be unusable after expiry or for a different session.

`POST /api/onboarding/submit` accepts the token, `submission_id`, `verification_state`, `answer:<field>` parts, and `file:<field>` parts. The server must re-resolve and authorize the Request from the token, validate all field names/types and file limits, and persist a submission before mutating CRM records.

## Idempotency and file retry requirements

Use a durable unique key scoped to tenant/org, for example `(org_id, submission_id)`, and atomically claim it before CRM/file side effects. A replay returns the original result; a payload mismatch for an existing key is a conflict. Track states such as `received`, `files_pending`, `crm_pending`, `completed`, and `failed_retryable`. File uploads need their own content hash/object key and resumable retry; retries must not create duplicate CRM attachments. The CRM `Submission_Id` text field alone is not an idempotency guarantee.

## Secrets and production configuration

Zoho OAuth client credentials, refresh tokens, signing keys, storage credentials, and CRM organization IDs must be server-only environment/secret-manager values. Do not expose them through `VITE_*`, `NEXT_PUBLIC_*`, HTML, bootstrap JSON, logs, or client bundles. Production startup should fail if a production allowlist, redirect URI, org ID, or secret is missing or points at Sandbox.

## Sandbox-to-Production gate

No production change is included here. Before migration, export an approved field/API-name manifest from Sandbox, review lookup and picklist dependencies, apply it to a disposable Production clone or controlled window, and run synthetic smoke tests using non-customer data. Rollout needs a feature flag, error-rate/latency/file-failure monitoring, dead-letter/retry visibility, and a rollback that disables intake and restores the previous adapter without deleting records. Production OAuth and target-org access are still required.

## Current blockers

1. The backend repository/runtime that should own `/api/onboarding/bootstrap` and `/api/onboarding/submit` is not present in this ZIP.
2. Resolver inputs and policy are not yet available: authenticated identity source, trusted order/consult identifier, eligibility status, duplicate-match handling, and the allowed Request field set.
3. Production OAuth/secrets and the approved Sandbox→Production schema manifest are not available.

Until those inputs exist, this checkpoint intentionally remains a client contract and a safe fail-closed UI; it does not claim launch readiness or modify Zoho Production.
