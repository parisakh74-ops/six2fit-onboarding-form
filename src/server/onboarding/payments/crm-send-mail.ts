import { StoreError } from "../errors";
import { INVALID, ZohoTransportError, type ZohoClient } from "../crm/client";
import { DeliveryError } from "./types";
import type { MailMessage, MailProvider } from "./email-delivery";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DEAL_ID = /^\d{6,25}$/;

/** Documented error codes of `POST /crm/v8/{module}/{id}/actions/send_mail` (Zoho CRM v8 Send Mail API). */
const PERMANENT = new Set(["MANDATORY_NOT_FOUND", "NOT_ALLOWED", "NO_PERMISSION", "INVALID_DATA", "FEATURE_NOT_SUPPORTED", "FILE_SIZE_EXCEEDS"]);
const TRY_LATER = new Set(["LIMIT_EXCEEDED", "CUSTOM_ERROR", "RECORD_LOCKED"]);

/**
 * `MailProvider` over the Zoho CRM Send Mail API (a CANDIDATE provider, not an approved one). The message is sent from the Deal
 * record with an explicit subject and content, so no CRM e-mail template is needed. Facts from the API documentation:
 *  - the response carries only a `message_id` (acceptance); there is no delivery, open or bounce status;
 *  - the sender must be one of the org's allowed "from" addresses; edition limits apply (the page cites 100/day as an example);
 *  - recipients who opted out or whose address is blocked by bounces are refused (`NOT_ALLOWED`).
 * No idempotency key exists, so an unreadable answer or a timeout is AMBIGUOUS and is never resent automatically.
 * Sandbox only: the client's environment guard (organisation, sandbox type, module id prefix) runs before the first send.
 */
export class ZohoCrmSendMail implements MailProvider {
  constructor(
    private readonly client: ZohoClient,
    private readonly sender: { name: string; email: string },
    private readonly orgEmail = false,
  ) {}

  async send(m: MailMessage): Promise<{ reference: string }> {
    if (!DEAL_ID.test(m.dealId)) throw new DeliveryError("permanent", "INVALID_RECORD");
    try {
      await this.client.verifyEnvironment();
    } catch (e) {
      // Nothing has been sent: a failed guard is a definite, retryable-later refusal (the configuration needs a human if it persists).
      throw new DeliveryError("definite", e instanceof StoreError && e.code ? e.code : "ENV_UNVERIFIED");
    }
    let res;
    try {
      res = await this.client.request("POST", `/Deals/${m.dealId}/actions/send_mail`, {
        body: { data: [{ from: { user_name: this.sender.name, email: this.sender.email }, to: [{ email: m.toEmail }], subject: m.subject, content: m.html, mail_format: "html", org_email: this.orgEmail }] },
      });
    } catch (e) {
      // A token failure happens before any request leaves; a transport failure after the request left is ambiguous.
      if (e instanceof ZohoTransportError) throw new DeliveryError("ambiguous", e.reason === "timeout" ? "TIMEOUT" : "NETWORK");
      if (e instanceof StoreError) throw new DeliveryError("definite", e.code ?? "AUTH_FAILED");
      throw new DeliveryError("ambiguous", "UNEXPECTED");
    }
    const j = res.json;
    const item = isObj(j) && Array.isArray(j["data"]) && isObj((j["data"] as unknown[])[0]) ? ((j["data"] as unknown[])[0] as Record<string, unknown>) : null;
    const code = typeof item?.["code"] === "string" ? (item["code"] as string) : typeof (isObj(j) ? j["code"] : undefined) === "string" ? ((j as Record<string, unknown>)["code"] as string) : undefined;
    const s = res.status;
    if (s >= 200 && s < 300 && code === "SUCCESS" && isObj(item?.["details"]) && typeof (item["details"] as Record<string, unknown>)["message_id"] === "string") {
      return { reference: (item["details"] as Record<string, string>)["message_id"] as string };
    }
    if (s === 401 || (s === 403 && code !== "NO_PERMISSION")) throw new DeliveryError("definite", s === 401 ? "AUTH_FAILED" : "FORBIDDEN");
    if (s === 429) throw new DeliveryError("definite", "RATE_LIMITED");
    if (s >= 500) throw new DeliveryError("ambiguous", "UPSTREAM_5XX");
    if (j === INVALID || j === null || code === undefined) throw new DeliveryError("ambiguous", "INVALID_RESPONSE");
    if (s >= 400 && s < 500) {
      if (PERMANENT.has(code)) throw new DeliveryError("permanent", code);
      if (TRY_LATER.has(code)) throw new DeliveryError("definite", code);
      return failUnknown4xx(code);
    }
    // 2xx without the documented SUCCESS shape: the provider may have accepted it.
    throw new DeliveryError("ambiguous", "INVALID_RESPONSE");
  }
}

/** An undocumented 4xx code: nothing was accepted by a 4xx, but it is not a code we can reason about: stop for a human. */
function failUnknown4xx(code: string): never {
  throw new DeliveryError("permanent", `UNKNOWN_${code}`.slice(0, 60));
}
