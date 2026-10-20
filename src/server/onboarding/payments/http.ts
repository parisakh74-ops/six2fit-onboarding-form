import { eventKey, type FactStore } from "./facts";
import type { PaymentOnboarding } from "./orchestrator";
import { PaymentError } from "./types";
import { orderIdFromWebhook, verifyWooSignature } from "./verifier";

/** Public path the shop posts to (and the Passenger-safe alias `/?six2fit_api=payment_webhook`). */
export const PAYMENT_WEBHOOK_PATH = "/api/payments/woocommerce";
const MAX_BODY = 256 * 1024;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const plain = (status: number, error_code: string): Response => Response.json({ error_code, message: error_code }, { status, headers: HEADERS });

export function isPaymentWebhookRequest(request: Request): boolean {
  const u = new URL(request.url);
  return request.method === "POST" && (u.pathname === PAYMENT_WEBHOOK_PATH || (u.pathname === "/" && u.searchParams.get("six2fit_api") === "payment_webhook"));
}

export type PaymentWebhookDeps = { orchestrator: PaymentOnboarding; facts: FactStore; webhookSecret: string };

/**
 * WooCommerce webhook receiver (ONB-PAY-01). The signature only proves the sender knows the secret; the payload is NOT
 * trusted for anything but the order id: the order is re-read from the shop and judged by `WooCommerceOrderVerifier`
 * (status + paid date + positive total + gateway transaction reference). Replays and retries are harmless: processing is
 * idempotent per order (at most one link, one delivery), and the delivery id is only a cheap short-circuit.
 * Platform-facing answers: 200 for every settled or reviewable state (so the shop does not disable the webhook), 401 for a bad
 * signature, 400 for a malformed body, 503 when something needed could not be read (the shop retries).
 */
export async function handlePaymentWebhook(request: Request, deps: PaymentWebhookDeps): Promise<Response> {
  if (!isPaymentWebhookRequest(request)) return plain(404, "NOT_FOUND");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return plain(413, "PAYLOAD_TOO_LARGE");
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY) return plain(413, "PAYLOAD_TOO_LARGE");
  if (!verifyWooSignature(body, request.headers.get("x-wc-webhook-signature"), deps.webhookSecret)) return plain(401, "INVALID_SIGNATURE");

  // WooCommerce pings a new webhook with a form-encoded `webhook_id=<n>` body (signed too): acknowledge, do nothing.
  if (/^webhook_id=\d+$/.test(body.trim())) return Response.json({ status: "ok", ping: true }, { status: 200, headers: HEADERS });

  let orderId: string;
  try {
    orderId = orderIdFromWebhook(body);
  } catch {
    return plain(400, "INVALID_PAYLOAD");
  }
  const delivery = (request.headers.get("x-wc-webhook-delivery-id") ?? "").trim();
  const evt = /^[A-Za-z0-9_-]{1,100}$/.test(delivery) ? eventKey(delivery) : null;
  try {
    if (evt && (await deps.facts.get(evt, "done"))) return Response.json({ status: "ok", duplicate_delivery: true }, { status: 200, headers: HEADERS });
    const outcome = await deps.orchestrator.process(orderId);
    // Only the state is returned: no order content, no link, no customer data.
    if (evt && (outcome.state === "delivered" || outcome.state === "revoked" || outcome.state === "not_first_period" || outcome.state === "needs_review")) await deps.facts.put(evt, "done", { order: orderId, state: outcome.state });
    return Response.json({ status: "ok", state: outcome.state }, { status: 200, headers: HEADERS });
  } catch (e) {
    return e instanceof PaymentError && e.code === "SIGNATURE" ? plain(401, "INVALID_SIGNATURE") : plain(503, "TEMPORARILY_UNAVAILABLE");
  }
}
