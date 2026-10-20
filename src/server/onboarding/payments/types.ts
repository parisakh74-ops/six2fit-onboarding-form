/**
 * Post-payment initiation of Onboarding (design: change plan section 42). Local, mock-tested code only: no route is
 * registered, no webhook is exposed, nothing is deployed. The payment platform of the NEW website (6tofit.com) is not
 * verified; the WooCommerce REST contract used here is the documented one and is Unknown for that site.
 */
export type OrderStatus = "pending" | "processing" | "on-hold" | "completed" | "cancelled" | "refunded" | "failed" | "trash" | "unknown";

/** What a server-to-server read of the order says. The webhook payload itself is never trusted. */
export type VerifiedOrder = {
  orderId: string;
  status: OrderStatus;
  /** Money received: status processing/completed AND a paid date is set. */
  paid: boolean;
  /** Fully refunded (refund total >= order total) or status refunded. */
  refunded: boolean;
  /** Some money was refunded but not all (a product decision). */
  partialRefund: boolean;
  total: string;
  currency: string;
  datePaid: string | null;
  gateway: string;
  transactionId: string | null;
  productSkus: string[];
};

export interface OrderVerifier {
  /** Reads the order from the payment platform. Throws `PaymentError` (UNAVAILABLE) when it cannot be read: never guess. */
  verify(orderId: string): Promise<VerifiedOrder>;
}

/**
 * The Deal created for a verified order, plus what the Deal says about the product. `scope` is `null` when the product
 * cannot be mapped to a form scope: the order then goes to manual review instead of being guessed.
 */
export type ResolvedDeal = {
  dealId: string;
  contactId: string;
  scope: "Diet" | "Training" | "Combo" | "CIP" | null;
  entitlements: string[];
  isFirstRequest?: boolean | undefined;
  productRelatedTo?: string | undefined;
  /** CRM Product id of the Deal (recorded in the link registry so the manual issuer reuses this very link). */
  productId?: string | undefined;
};

/** Finds the CRM Deal created for a verified order. `null` = not (yet) there: CRM synchronisation can lag. */
export interface DealResolver {
  /** `"ambiguous"`: more than one Deal claims the order (known legacy duplicate-Deal behaviour): never guessed, goes to review. */
  findByOrder(order: VerifiedOrder): Promise<ResolvedDeal | "ambiguous" | null>;
}

export class DeliveryError extends Error {
  /** `definite`: the provider refused, nothing was sent. `ambiguous`: it may have been sent (timeout, unreadable answer). */
  constructor(public readonly kind: "definite" | "ambiguous", public readonly code: string) {
    super(`delivery ${kind}: ${code}`);
    this.name = "DeliveryError";
  }
}

/** Sends the individual link (e-mail / WhatsApp). The channel and provider are a product decision (D-PAY-7). */
export interface LinkDelivery {
  send(input: { dealId: string; contactId: string; orderId: string; link: string; attempt: number }): Promise<void>;
}

export class PaymentError extends Error {
  constructor(public readonly code: "UNAVAILABLE" | "INVALID_ORDER_ID" | "NOT_CONFIGURED" | "SIGNATURE" | "CORRUPT", message?: string) {
    super(message ?? code);
    this.name = "PaymentError";
  }
}

/** WooCommerce order ids are positive integers. */
export const ORDER_ID_PATTERN = /^[1-9]\d{0,11}$/;
