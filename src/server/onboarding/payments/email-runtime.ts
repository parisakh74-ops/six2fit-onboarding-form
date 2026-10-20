import { ZohoClient, type ClientDeps } from "../crm/client";
import { loadCrmConfig } from "../crm/config";
import { StoreError } from "../errors";
import { createCrmReader } from "../links/crm-reader";
import type { CrmDealReader } from "../links/types";
import { ZohoCrmSendMail } from "./crm-send-mail";
import { EmailDelivery, RecipientAllowlist, isPlausibleEmail } from "./email-delivery";
import { renderInvitation } from "./invitation-email";

/**
 * Builds the e-mail delivery of the first invitation from the environment. REAL SENDING IS OFF BY DEFAULT: the function returns
 * `null` unless `SIX2FIT_EMAIL_DELIVERY_MODE=crm-send-mail`. When it is on, everything below is mandatory (fail closed):
 *
 *   SIX2FIT_EMAIL_FROM / SIX2FIT_EMAIL_FROM_NAME          the sender (must be an address the CRM allows: unverified, see docs)
 *   SIX2FIT_EMAIL_ALLOWED_RECIPIENTS                      comma list of exact addresses or @domain entries; at least one.
 *                                                         The runtime is Sandbox-only, so nobody else can ever be mailed.
 *   SIX2FIT_ZOHO_MAILER_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN   a grant that has ONLY the send-mail scope
 *                                                         (`ZohoCRM.send_mail.deals.CREATE`); never the writer or reader grant
 *   SIX2FIT_EMAIL_ORG_EMAIL                               "true" = send through the CRM server instead of the sender's own SMTP
 *   SIX2FIT_FORM_BASE_URL                                 the origin every link must have
 */
export function buildEmailDelivery(env: Record<string, string | undefined>, overrides: Partial<ClientDeps> & { reader?: CrmDealReader } = {}): EmailDelivery | null {
  const get = (k: string) => (env[k] ?? "").trim();
  const mode = get("SIX2FIT_EMAIL_DELIVERY_MODE").toLowerCase();
  if (mode === "" || mode === "disabled") return null;
  const bad = (what: string): never => {
    throw new StoreError("NOT_CONFIGURED", `email: ${what}`, "EMAIL_NOT_CONFIGURED");
  };
  if (mode !== "crm-send-mail") return bad("unknown delivery mode");

  const from = get("SIX2FIT_EMAIL_FROM");
  const fromName = get("SIX2FIT_EMAIL_FROM_NAME");
  if (!isPlausibleEmail(from)) bad("sender address missing or invalid");
  if (fromName === "" || fromName.length > 80) bad("sender name missing or too long");
  const entries = get("SIX2FIT_EMAIL_ALLOWED_RECIPIENTS").split(",").map((e) => e.trim()).filter(Boolean);
  let allowlist: RecipientAllowlist;
  try {
    allowlist = new RecipientAllowlist(entries);
  } catch {
    return bad("allowed recipients invalid");
  }
  if (allowlist.size === 0) bad("allowed recipients are required (sandbox)");

  const id = get("SIX2FIT_ZOHO_MAILER_CLIENT_ID");
  const secret = get("SIX2FIT_ZOHO_MAILER_CLIENT_SECRET");
  const refresh = get("SIX2FIT_ZOHO_MAILER_REFRESH_TOKEN");
  if (!id || !secret || !refresh) bad("mailer grant missing");
  if (refresh === get("SIX2FIT_ZOHO_REFRESH_TOKEN") || refresh === get("SIX2FIT_ZOHO_READER_REFRESH_TOKEN")) bad("the mailer grant must be separate from the writer and reader grants");
  const config = loadCrmConfig({ ...env, SIX2FIT_ZOHO_CLIENT_ID: id, SIX2FIT_ZOHO_CLIENT_SECRET: secret, SIX2FIT_ZOHO_REFRESH_TOKEN: refresh });

  let origin: string;
  try {
    const u = new URL(get("SIX2FIT_FORM_BASE_URL"));
    if (u.protocol !== "https:") throw new Error("scheme");
    origin = u.origin;
  } catch {
    return bad("form base url missing or not https");
  }

  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as ClientDeps["fetch"] | undefined);
  if (!fetchImpl) return bad("fetch unavailable");
  const client = new ZohoClient(config, { fetch: fetchImpl, now: overrides.now ?? (() => Date.now()), sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) });
  const reader = overrides.reader ?? createCrmReader(env, overrides).reader;
  return new EmailDelivery({
    provider: new ZohoCrmSendMail(client, { name: fromName, email: from }, get("SIX2FIT_EMAIL_ORG_EMAIL") === "true"),
    recipient: async (contactId) => (await reader.getContact(contactId))?.email ?? null,
    render: renderInvitation,
    linkOrigin: origin,
    allowlist,
  });
}
