# Create Form button -> Link Issuer: integration contract (proposal, nothing connected)

Status: **local implementation and mock tests only.** The CRM button, its Function, the Deal fields and every workflow are untouched. The text below is a proposal for the Product Manager to approve; none of it has been executed.

## 1. What exists in the CRM (CA Dev Sandbox, read-only, 2026-10-18)

| Item | Fact |
|---|---|
| Button | `Create_Form` (id `6223361000067263088`), Deals detail page, layout Standard, profiles: Administrator, Standard, Sales Manager, CX Manager, Support Expert, Sales Expert |
| Binding | The button stores the function **by name** `RequestFormOnDealWithoutSend` (its stored function id `1437139000000028064` does not exist in the Sandbox). The Sandbox function whose display name is exactly `RequestFormOnDealWithoutSend` is API name **`requestformondeal1`** (category Button, id `6223361000067263078`, header `string button.RequestFormOnDeal1(String dealId)`). Its body is identical to the repository snapshot. The same name was already identified in the Production timeline (TD-24J). |
| Behaviour today | validates Deal / Contact / contact channel / Product, computes `isFirstReq` (any prior Request of the Contact), builds `https://forms.six2fit.com?dealId=...&productName=...&productRelatedTo=...&formSentAt=...&isFirstReq=...` (+ `zf_lang=fa`), writes **four** Deal fields and sends nothing |
| Deal fields written today | `Request_Form_Sent_At`, `Request_Form_Sent=true`, `English_Form_Link`, `Persian_Form_Link` |

## 2. Frontend URL contract (verified in code)

- The form is the site root `/`. The signed token is the query parameter **`session`** (`src/lib/onboarding/integration.ts`: `loadBootstrap` reads `new URLSearchParams(location.search).get("session")` and POSTs `/?six2fit_api=bootstrap&session=<token>`).
- Scope and entitlements come only from the signed claims; the optional `scope` search param is untrusted.
- The UI is Persian only (`<html lang="fa" dir="rtl">`); **no component reads a language parameter**.
- Persian URL: `https://<form-host>/?session=<token>`. English URL: the same plus `lang=en`, which the frontend **ignores today** (it shows the Persian form). The issuer reports `language_support: { fa: true, en: false }`.
- No `dealId`, product, name, e-mail or phone ever appears in a URL.

## 3. Link Issuer (implemented locally: `src/server/onboarding/links/`)

`POST /api/internal/onboarding-link` with `{ "deal_id": "<digits>" }`, called by the CRM Function. (The route file is **not** registered: that needs `routeTree.gen.ts` regeneration, a separate step.)

- Authentication: HMAC-SHA256 `x-s2f-signature` over `timestamp.METHOD.path.sha256(body)` with `x-s2f-timestamp` (5-minute window). The secret is separate from the token-signing secret.
- Reads (never writes): Deal, Contact, "has prior Requests" through the `CrmDealReader` port. The port has no mutating method; a test asserts it.
- Validation order: Deal id shape -> Deal exists -> Deal belongs to the expected organisation -> Contact exists and matches -> Contact has e-mail/phone/mobile -> Product present -> **explicit** Product-to-scope mapping (no mapping = `PRODUCT_UNMAPPED`, never guessed).
- Token: existing **v2** contract (`deal_id`, `jti`, `scope`, `entitlements`, `exp`, `is_first_request`, `product_related_to`). No incompatibility was found, so no new version. Environment separation is by **separate signing secrets per environment** plus the organisation check; v2 carries no `env` claim.
- Responses: `issued` or `reused` with `urls.fa`, `urls.en`, `jti`, `expires_at`, `scope`, `entitlements`, `is_first_request`; errors `INVALID_DEAL_ID` 400, `DEAL_NOT_FOUND` 404, `WRONG_ENVIRONMENT` 403, `NO_CONTACT` / `NO_CONTACT_CHANNEL` / `PRODUCT_MISSING` / `PRODUCT_UNMAPPED` 422, `ALREADY_SUBMITTED` / `SUBMISSION_UNRESOLVED` 409, `CRM_UNAVAILABLE` / `ISSUER_UNAVAILABLE` 503, `UNAUTHORIZED` 401.

### Reuse rule (provisional, not approved)
Newest link of the Deal: submitted -> stop (`ALREADY_SUBMITTED`); unresolved (ledger `in_progress/unknown/needs_review/integrity`) -> stop (`SUBMISSION_UNRESOLVED`); valid (unexpired by more than 60 s), unrevoked and still matching the Deal's current mapping -> **reuse the same token** (the registry stores claims; HMAC is deterministic, so the rebuilt token is byte-identical); otherwise issue a new link. Two simultaneous clicks issue one link (compare-and-set).

### Minimum registry (decision pending, only an interface and an in-memory test double exist)
Needs per Deal: `{deal_id, jti, scope, entitlements, iat, exp, product_id, is_first_request, product_related_to}`: no PII, no token, no secret. Options: (a) append-only facts on the existing hard-link `FactStore` (same primitive as the ledger; needs a key prefix extension; same host-level hard-link caveat); (b) a CRM field on the Deal (schema change, and the CRM is then the registry); (c) stateless: no reuse (every click a new token). Submission state is read from the onboarding ledger by `subjectKey` (implemented read-only: `LedgerSubmissionStatusReader`).

## 4. Proposed Deluge adaptation of `RequestFormOnDeal1` (**not executed, not applied**)

Keep today's guards and messages. Replace only the link construction and the Deal update:

```
// 1. keep: Deal lookup, Contact lookup, channel and Product checks, their error strings
// 2. remove: the isFirstReq search and the urlParams/base/link strings (the issuer does that)
// 3. call the issuer
path = "/api/internal/onboarding-link";
payload = Map(); payload.put("deal_id", dealId);
body = payload.toString();
ts = (zoho.currenttime.toLong() / 1000).toString();
signature = zoho.encryption.hmacsha256(<issuer secret from an org variable or connection>, ts + ".POST." + path + "." + zoho.encryption.sha256(body));
resp = invokeurl [ url :"https://<onboarding host>" + path  type :POST  parameters :body
                   headers :{"Content-Type":"application/json","x-s2f-timestamp":ts,"x-s2f-signature":signature}
                   detailed :true ];
// 4. 200 -> update ONLY English_Form_Link and Persian_Form_Link from urls.en / urls.fa
//    (no Request_Form_Sent / Request_Form_Sent_At; see section 5), return the existing success string,
//    appending a note when status == "reused"
// 5. non-200 -> map error_code to staff messages (existing wording for Contact/Product/channel; new for
//    PRODUCT_UNMAPPED, ALREADY_SUBMITTED, SUBMISSION_UNRESOLVED, CRM_UNAVAILABLE); never write a link
```
Unverified Deluge details: exact output format of `zoho.encryption.hmacsha256/sha256` (must be lower-case hex to match the server), and where the secret lives (org variable vs connection). Verify in a Sandbox test function before any change to the button's function.

## 5. `Request_Form_Sent` and `Request_Form_Sent_At`
Today the button sets both when it merely **generates** a link. In the Sandbox they are referenced by the (inactive) reminder workflows (3/14/30 days) and `Send SMS`; re-activating those would remind customers who never received a link. Proposal: **do not write them on generation**; keep them for an explicit "sent" action (a staff-confirmed step, or the auto-send paths when they are migrated). Option B (keep today's behaviour) is the least change but contradicts the stated principle. **Product decision.**

## 6. Collision with the active workflow `Trigger Onboarding Form Link`
Rule on Deals: active since 2025-08, fires when `Form_Request_Trigger` becomes `Run` (picklist `-None-/Run/Done`; "repeat" off), calls `RequestFormOnDealWithoutSend (For mobile app)` (`requestformondealwithoutsendformobileapp`), which writes the **same four Deal fields** with a legacy `forms.six2fit.com?dealId=...` link. Nothing in the repository or the Sandbox shows who sets `Run` (the mobile app is a hypothesis). Consequences once the button issues signed links: any `Run` overwrites `English_Form_Link`/`Persian_Form_Link` with an unsigned legacy link (last writer wins, no error). Mitigations (all need approval; nothing was changed): switch that function to the same issuer in the same release; or retire/guard the workflow; and find the caller of `Run` first. The workflow, its function and the field were not modified.

## 7. Blockers before the button can be connected
1. **Bootstrap cannot open a Deal-bound link yet**: `ConsultHandoffDirectory` fails closed (`IDENTITY_UNAVAILABLE`) for `deal` subjects, so an issued link would not load in the real runtime. A Deal-aware `SubjectDirectory` (re-verify Deal/Contact/product mapping, minimal prefill) is required.
2. Real read-only `CrmDealReader` (Sandbox OAuth, read scopes); the Sandbox has **no Products** and the QA Deal has none, so a Sandbox Product + mapping entry is needed (CRM write: approval).
3. Approved Product-to-scope/entitlement table (and the meaning of `CIP`).
4. Durable issuance registry decision; TTL (provisional 14 days in tests); revocation tool for staff.
5. English UI (or accept that `lang=en` shows Persian).
6. Route registration (`routeTree.gen.ts`), issuer environment variables (`caller secret`, base URL, expected org, token secret), staging deployment.
7. The `Run` workflow collision and the other five link generators (auto-send paths).
