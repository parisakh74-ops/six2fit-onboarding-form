# ONB-PAY-01: verified-payment first invitation (mock-tested; real integration PENDING)

## What the code does (local mocks only)
Webhook `POST /api/payments/woocommerce` (alias `/?six2fit_api=payment_webhook`) -> `handlePaymentWebhook` -> `createPaymentOnboarding.process(orderId)`:

1. HMAC signature (`X-WC-Webhook-Signature`) proves the sender knows the secret. The body is **not trusted** beyond the order id.
2. The order is re-read from the shop (`WooCommerceOrderVerifier`, read-only key). **Paid** requires: status `processing`/`completed`, a paid date, a positive total **and a gateway transaction reference**; if `SIX2FIT_PAYMENT_GATEWAYS` is set, also an allowed gateway id. A status alone is never proof. Anything else (pending, on-hold, failed, unknown, unreadable, mismatching order id) sends nothing; unreadable answers are retried by the shop (503).
3. Audit fact per order: order id, gateway, gateway transaction reference, paid date, amount (no customer data).
4. The Deal is found read-only (`CrmDealResolver`: the Deal whose `Transaction` URL names the order). Zero = wait for CRM sync; several = review (`deal_ambiguous`); organisation mismatch = refused; unmapped product = review.
5. **First period only**: `isFirstRequest` (the Contact has no earlier Request) must be true; later or unproven periods are skipped (`not_first_period`) and remain manual.
6. The link id is a pure function of the order (one order -> at most one link, one delivery). The link is **recorded in the durable link registry**, so a later manual "Create Form" reuses it; a different link already issued for the Deal stops the automatic invitation (`link_conflict`, review).
7. Delivery has a durable "sending" marker before the send; an ambiguous send is never repeated automatically.
8. Replay: the shop's delivery id short-circuits repeated deliveries; correctness never depends on it.

## What is NOT done (pending, with the exact missing evidence)
* **No delivery channel exists** (e-mail / WhatsApp provider is open decision D-PAY-7). `handlePaymentWebhookFromEnv` answers `503 PAYMENT_DELIVERY_NOT_CONFIGURED` and sends nothing. Nothing real has ever been sent.
* **Production order source (six2fit.com WooCommerce) was not inspected** (no authorised read-only access in this work). Unverified: the REST contract of that shop, whether its gateways (`WC_ZPal`, `stripe` appear in CRM evidence) fill `transaction_id`, the webhook topic to register, and the delivery-id header. If a gateway leaves `transaction_id` empty, orders of that gateway will be treated as **not paid** (fail closed).
* The CRM has no order-id field (CRM-CHG-004 is a proposal); `Transaction` URL matching is an inference from Production evidence and is unverified on the Sandbox. Duplicate Deals per order exist historically; they go to review.
* The sweep for orders left in `awaiting_deal` / `delivery_retry_later` (`orchestrator.reconcile`) has no trigger yet; the shop's next event continues them.
* Conflict to resolve outside this work: the 2026-10-20 register records Finance confirmation as the payment step, while ONB-PAY-01 and C-1 say the first invitation is automatic after a verified payment. This code implements ONB-PAY-01 as instructed.
