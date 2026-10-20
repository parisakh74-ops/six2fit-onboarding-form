import { DeliveryError, type LinkDelivery } from "./types";

/**
 * Provider-independent e-mail delivery adapter for the first Onboarding invitation (ONB-DELIVERY-01).
 * It resolves the recipient, applies the safety guards and hands one message to a `MailProvider`. It never logs or stores the
 * address, the link or the message body. "Accepted by the provider" is the strongest thing it can report: it is NOT proof that
 * the message reached an inbox.
 */
export type MailMessage = { dealId: string; toEmail: string; subject: string; html: string };
export interface MailProvider {
  /** Resolves with an opaque provider reference only when the provider ACCEPTED the message. Throws `DeliveryError` otherwise. */
  send(message: MailMessage): Promise<{ reference: string }>;
}

/** Looks up the recipient address of a CRM Contact (read-only). `null` = the Contact has no address. */
export type RecipientLookup = (contactId: string) => Promise<string | null>;

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isPlausibleEmail = (v: string): boolean => v.length <= 254 && EMAIL.test(v);

/** Exact addresses or `@domain` entries. An EMPTY allowlist allows nobody. */
export class RecipientAllowlist {
  private readonly exact = new Set<string>();
  private readonly domains = new Set<string>();

  constructor(entries: readonly string[]) {
    for (const raw of entries) {
      const e = raw.trim().toLowerCase();
      if (e.startsWith("@") && /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) this.domains.add(e.slice(1));
      else if (isPlausibleEmail(e)) this.exact.add(e);
      else throw new Error("ALLOWLIST_ENTRY_INVALID");
    }
  }

  get size(): number {
    return this.exact.size + this.domains.size;
  }

  allows(email: string): boolean {
    const e = email.trim().toLowerCase();
    const at = e.lastIndexOf("@");
    return this.exact.has(e) || (at > 0 && this.domains.has(e.slice(at + 1)));
  }
}

export type EmailDeliveryDeps = {
  provider: MailProvider;
  recipient: RecipientLookup;
  /** Builds the message from the link. Pure; the link is the only variable content. */
  render: (link: string) => { subject: string; html: string };
  /** Origin the link must have (the onboarding form). Anything else is refused. */
  linkOrigin: string;
  /** Required in the Sandbox: only these recipients can ever be mailed. */
  allowlist?: RecipientAllowlist;
};

export class EmailDelivery implements LinkDelivery {
  constructor(private readonly deps: EmailDeliveryDeps) {}

  async send(input: { dealId: string; contactId: string; orderId: string; link: string; attempt: number }): Promise<{ reference: string }> {
    let link: URL;
    try {
      link = new URL(input.link);
    } catch {
      throw new DeliveryError("permanent", "LINK_INVALID");
    }
    if (link.origin !== this.deps.linkOrigin || link.protocol !== "https:" || link.username !== "" || link.password !== "") throw new DeliveryError("permanent", "LINK_INVALID");

    let email: string | null;
    try {
      email = await this.deps.recipient(input.contactId);
    } catch {
      throw new DeliveryError("definite", "RECIPIENT_LOOKUP_UNAVAILABLE"); // nothing was sent; the CRM could not be read
    }
    if (!email || email.trim() === "") throw new DeliveryError("permanent", "NO_RECIPIENT");
    email = email.trim();
    if (!isPlausibleEmail(email)) throw new DeliveryError("permanent", "INVALID_RECIPIENT");
    if (this.deps.allowlist && !this.deps.allowlist.allows(email)) throw new DeliveryError("permanent", "RECIPIENT_NOT_ALLOWED");

    const { subject, html } = this.deps.render(input.link);
    return this.deps.provider.send({ dealId: input.dealId, toEmail: email, subject, html });
  }
}
