import { createHmac, timingSafeEqual } from "node:crypto";
import { ORDER_ID_PATTERN, PaymentError, type OrderStatus, type OrderVerifier, type VerifiedOrder } from "./types";

/**
 * WooCommerce webhook signature: base64(HMAC-SHA256(rawBody, webhookSecret)) in `X-WC-Webhook-Signature`
 * (documented WooCommerce behaviour; Unknown for the new 6tofit.com site until it is inspected). The signature only proves
 * that the sender knows the secret: the order is still re-read from the shop (`WooCommerceOrderVerifier`).
 */
export function verifyWooSignature(rawBody: Uint8Array | string, header: string | null, secret: string): boolean {
  if (!header || secret.length < 16) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Extracts the order id from a webhook body. Only the id is used; every other field of the body is ignored. */
export function orderIdFromWebhook(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new PaymentError("INVALID_ORDER_ID");
  }
  const id = parsed !== null && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
  const text = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" ? id : "";
  if (!ORDER_ID_PATTERN.test(text)) throw new PaymentError("INVALID_ORDER_ID");
  return text;
}

const STATUSES = new Set<OrderStatus>(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash"]);

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/**
 * Reads an order through the WooCommerce REST API (`GET /wp-json/wc/v3/orders/<id>`, read-only key). Money is considered
 * received only when the status is `processing` or `completed`, the shop recorded a paid date AND a gateway transaction reference exists. A refund total that
 * covers the order total is a full refund; a smaller one is a partial refund (a product decision, never auto-resolved).
 */
export class WooCommerceOrderVerifier implements OrderVerifier {
  constructor(
    private readonly cfg: {
      baseUrl: string;
      consumerKey: string;
      consumerSecret: string;
      fetch?: FetchLike;
      timeoutMs?: number;
      /** ONB-PAY-01: when set, only orders paid through one of these gateway ids count as paid (empty/undefined = any gateway). */
      allowedGateways?: readonly string[];
    },
  ) {
    if (!/^https:\/\/[^/\s]+$/.test(cfg.baseUrl.replace(/\/+$/, "")) || !cfg.consumerKey || !cfg.consumerSecret) throw new PaymentError("NOT_CONFIGURED");
  }

  async verify(orderId: string): Promise<VerifiedOrder> {
    if (!ORDER_ID_PATTERN.test(orderId)) throw new PaymentError("INVALID_ORDER_ID");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 10_000);
    let res: Response;
    try {
      const doFetch: FetchLike = this.cfg.fetch ?? ((u, i) => fetch(u, i));
      res = await doFetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/wp-json/wc/v3/orders/${orderId}`, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Basic ${Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64")}` },
        signal: controller.signal,
      });
    } catch {
      throw new PaymentError("UNAVAILABLE", "order could not be read");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return notFound(orderId);
    if (res.status !== 200) throw new PaymentError("UNAVAILABLE", `order read refused (${res.status >= 500 ? "5xx" : res.status})`);
    let j: Record<string, unknown>;
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new PaymentError("UNAVAILABLE", "order answer unreadable");
    }
    if (String(j["id"]) !== orderId) throw new PaymentError("CORRUPT", "order id mismatch");
    const rawStatus = typeof j["status"] === "string" ? j["status"] : "";
    const status: OrderStatus = STATUSES.has(rawStatus as OrderStatus) ? (rawStatus as OrderStatus) : "unknown";
    const total = typeof j["total"] === "string" ? j["total"] : String(j["total"] ?? "");
    const totalNum = Number(total);
    const refunds = Array.isArray(j["refunds"]) ? (j["refunds"] as Array<{ total?: unknown }>) : [];
    const refundTotal = refunds.reduce((sum, r) => sum + Math.abs(Number(r.total ?? 0) || 0), 0);
    const refunded = status === "refunded" || (refundTotal > 0 && Number.isFinite(totalNum) && refundTotal >= totalNum);
    const datePaid = typeof j["date_paid"] === "string" && j["date_paid"] !== "" ? (j["date_paid"] as string) : null;
    const items = Array.isArray(j["line_items"]) ? (j["line_items"] as Array<{ sku?: unknown }>) : [];
    return {
      orderId,
      status,
      // ONB-PAY-01: a status alone is NOT proof of payment. Money is received only with a paid date, a positive total AND a
      // gateway transaction reference (the auditable payment reference); an allowed gateway when a list is configured.
      paid:
        (status === "processing" || status === "completed") &&
        datePaid !== null &&
        Number.isFinite(totalNum) &&
        totalNum > 0 &&
        typeof j["transaction_id"] === "string" &&
        j["transaction_id"] !== "" &&
        (!this.cfg.allowedGateways || this.cfg.allowedGateways.length === 0 || this.cfg.allowedGateways.includes(typeof j["payment_method"] === "string" ? (j["payment_method"] as string) : "")),
      refunded,
      partialRefund: refundTotal > 0 && !refunded,
      total,
      currency: typeof j["currency"] === "string" ? (j["currency"] as string) : "",
      datePaid,
      gateway: typeof j["payment_method"] === "string" ? (j["payment_method"] as string) : "",
      transactionId: typeof j["transaction_id"] === "string" && j["transaction_id"] !== "" ? (j["transaction_id"] as string) : null,
      productSkus: items.map((i) => (typeof i.sku === "string" ? i.sku : "")).filter(Boolean),
    };
  }
}

const notFound = (orderId: string): VerifiedOrder => ({ orderId, status: "unknown", paid: false, refunded: false, partialRefund: false, total: "0", currency: "", datePaid: null, gateway: "", transactionId: null, productSkus: [] });
