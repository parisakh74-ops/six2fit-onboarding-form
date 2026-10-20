# ONB-DELIVERY-01: first invitation by e-mail (adapter implemented and mock-tested; REAL SENDING OFF)

Status 2026-10-20: **no e-mail has ever been sent by this code.** The provider is **not approved**; Zoho CRM Send Mail is a candidate only.

## What exists (source + local mock tests)
* `payments/email-delivery.ts` `EmailDelivery` (`LinkDelivery`): validates the link (https, exact form origin), looks up the Contact e-mail read-only, applies the recipient allowlist, hands one message to a `MailProvider`. Missing / invalid / non-allowlisted recipient or foreign link = **permanent** refusal (never reaches the provider).
* `payments/crm-send-mail.ts` `ZohoCrmSendMail`: `POST /crm/v8/Deals/{id}/actions/send_mail` with the documented body (`from`, `to`, `subject`, `content`, `mail_format: html`, `org_email`). Error mapping from the documented codes: `MANDATORY_NOT_FOUND`, `NOT_ALLOWED`, `NO_PERMISSION`, `INVALID_DATA`, `FEATURE_NOT_SUPPORTED`, `FILE_SIZE_EXCEEDS` = permanent; `LIMIT_EXCEEDED`, `CUSTOM_ERROR`, `RECORD_LOCKED`, 401/403, 429 = definite (retry later); 5xx, timeout, network, unreadable or non-documented success shape = **ambiguous** (never resent). The Sandbox environment guard runs before the first send. Source: Zoho CRM v8 Send Mail API page (no idempotency key, response carries only a `message_id`).
* `payments/invitation-email.ts`: **DRAFT** Persian copy, link only, no personal data. Wording needs Product/UX approval.
* `payments/email-runtime.ts`: built only when `SIX2FIT_EMAIL_DELIVERY_MODE=crm-send-mail` and all of `SIX2FIT_EMAIL_FROM`, `_FROM_NAME`, `SIX2FIT_EMAIL_ALLOWED_RECIPIENTS` (at least one; the runtime is Sandbox-only so nobody else can ever be mailed), a **separate** send-mail grant `SIX2FIT_ZOHO_MAILER_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN` (scope `ZohoCRM.send_mail.deals.CREATE`; never the writer or reader grant) and `SIX2FIT_FORM_BASE_URL` (https) are set. Anything missing fails closed; default is OFF (the payment webhook answers `503 PAYMENT_DELIVERY_NOT_CONFIGURED`).
* Orchestrator rules (tested): permanent refusal -> review once, never retried; ambiguous -> review, never resent; definite -> retry after the back-off up to the attempt limit; **no expired (or about-to-expire) or revoked link is ever sent**; the provider reference is stored as `proof: "provider_accepted"`, which is **not** proof of inbox delivery.

## Not done / unknown
* Which provider (CRM Send Mail vs a transactional provider) and which sender: Product decision. Whether `noreply@six2fit.com` is in the org's allowed From list for the API, the edition's daily limit, SPF/DKIM/DMARC: **Unknown** (no access).
* No delivery or bounce tracking exists with Send Mail (only acceptance). Bounce visibility needs a different provider.
* The `delivery_retry_later` retry sweep has no trigger yet (`orchestrator.reconcile()` has no caller).
* The legacy CRM senders (see `SANDBOX_STAGING_RELEASE_PLAN.md`) were deliberately **not touched** (REL-CUTOVER-LEGACY-01).
