# Generated Onboarding link: functional status (local, mock-tested; nothing deployed or connected)

Date: 2026-10-18. Scope: CRM Deal -> Create Form -> signed URL -> bootstrap -> custom form opens. No CRM write, no button/Deluge change, no WorkDrive, no message, no deployment, no commit.

## 1. Bootstrap (Confirmed Fact, mock-tested)
- `links/deal-directory.ts`: `DealSubjectDirectory` (read-only) re-validates every Deal token against trusted CRM data on bootstrap AND submit: Deal exists (else 404), organisation matches (else 403), Deal has a Contact that exists and matches (else 403), Product maps (explicit table) to exactly the claimed scope + entitlements (else 403), CRM failure -> 503 `IDENTITY_UNAVAILABLE`. Prefill is empty (no customer data leaves the CRM).
- `CompositeSubjectDirectory` keeps Consultation links on the unchanged file hand-off; Deal links fail closed exactly as before when no reader is configured.
- `SubjectDirectory.resolve(subject, claims?)` now receives the verified claims.
- `runtimeFromEnv(env, { dealReader })`: the Deal directory is active only when a reader is injected and `SIX2FIT_EXPECTED_ORG_ID` is set. **No real reader exists yet**, so deployed behaviour is unchanged.

## 2. Frontend route contract (Confirmed Fact)
Form at `/`, token in `session`; `loadBootstrap` POSTs `/?six2fit_api=bootstrap&session=<token>`; `scope` URL param is untrusted; a raw `dealId` param is not an input (test: 401 and zero CRM reads). Issuer route `/api/internal/onboarding-link` is registered (route file, `server.ts` dispatch, `routeTree.gen.ts` updated by hand in the generator's exact form) and answers 503 `ISSUER_NOT_CONFIGURED` until reader + registry exist. Sub-path-safe alias: `POST /?six2fit_api=issue_link` (signature always covers the canonical path). Route-tree regeneration by the Vite plugin must be re-checked at the next `vite build`/dev run (not run here).

## 3. Product mapping
Explicit table `SIX2FIT_PRODUCT_SCOPE_MAP` keyed by Product record id; no default, no name inference (test: product named "Combo..." without entry = `PRODUCT_UNMAPPED`). Optional `commercial: { level, duration_months }` is validated and kept for audit only; it never enters a token or URL. **Gaps (Open Questions):** the approved Product -> scope/entitlement table; what `CIP` means and its entitlements; Core/VIP and duration semantics; the Sandbox has 0 Products and the QA Deal has none (a Product + mapping row needs PM approval).

## 4. Language
Frontend is Persian only (`<html lang="fa" dir="rtl">`); `lang` is not consumed. The issuer returns `urls.en = null` and `language_support.en = false` unless `englishUi` is explicitly enabled, so no misleading English link is produced. Minimum work for English: i18n of the 63-field form copy + validation messages + LTR layout + `lang` param/route handling + QA. Not started.

## 5. HMAC compatibility (backend <-> Deluge) (Hypothesis until executed)
Server verifies `x-s2f-signature` = lowercase hex HMAC-SHA256 over `timestamp.METHOD.path.sha256hex(body)` with `x-s2f-timestamp` (unix seconds, 5-minute skew). Deluge `zoho.encryption.hmacsha256(key, message)` output encoding (hex vs base64) and `zoho.encryption.sha256` encoding are unverified; the Deluge side must produce lowercase hex or the signature fails closed (401). Secret storage in Deluge (org variable vs connection) undecided. **Blocker:** an authenticated Deluge invocation cannot be executed without modifying/creating a CRM function (forbidden in this task); verification needs a Sandbox test function created with PM approval. Compatibility plan: create a throwaway Sandbox function that only computes the two digests of a fixed string, compare with the Node values printed by the local test vector, no network call.

## 6. Issuance registry / concurrency
Current `InMemoryIssuedLinkStore` is non-persistent: a restart forgets issued links, so the next click re-issues a new jti (old links still open until `exp`; the ledger keys submission state per jti, so a double submission across two live links is possible). Within one process concurrent clicks are serialised per Deal (test: 3 parallel clicks = 1 link). Across processes only the registry CAS protects. Minimum reliable persistence compatible with "customer data stays in Zoho": (a) append-only fact files on the existing hard-link `FactStore` (needs a key-prefix extension; ids/claims only, no PII), or (b) the already-existing Deal field `Persian_Form_Link` read through `DealView.persianFormLink` to recover the current link after restart (no new storage, but the issuer would parse its own token; the field is also written by the competing `Trigger Onboarding Form Link` workflow). Expiry: `exp` claim (TTL provisional 14 d); revocation: existing revocation facts (`isRevoked`). Nothing permanent was implemented; no CRM field modified.

## 7. Remaining steps before testing Create Form in Sandbox (each needs PM approval)
1. Approve Product -> scope table (+ CIP meaning); create a Sandbox Product and attach it to the QA Deal (CRM write).
2. Real read-only `CrmDealReader` (Sandbox OAuth, read scopes) and its injection into `runtimeFromEnv`.
3. Registry decision (FactStore vs Deal field vs stateless) and TTL.
4. Verify Deluge HMAC output format with a throwaway Sandbox function; decide secret storage.
5. Staging env vars: `SIX2FIT_EXPECTED_ORG_ID`, `SIX2FIT_PRODUCT_SCOPE_MAP`, `SIX2FIT_FORM_BASE_URL`, `SIX2FIT_ISSUER_CALLER_SECRET`, `SIX2FIT_LINK_TTL_SECONDS`; deploy; re-check route tree.
6. Adapt `RequestFormOnDeal1` per `CREATE_FORM_BUTTON_CONTRACT.md` (+ decision on `Request_Form_Sent*` and the `Trigger Onboarding Form Link` collision).
