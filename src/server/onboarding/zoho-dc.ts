import { StoreError } from "./errors";

/**
 * Zoho data-centre (DC) table. One place decides which hosts a credential or a customer payload may be sent to.
 *
 * Verified against Zoho's multi-DC page (https://www.zoho.com/accounts/protocol/oauth/multi-dc.html):
 *   accounts hosts: .com, .eu, .in, .com.au, .jp, .sa, zohocloud.ca (Canada is NOT `accounts.zoho.ca`), .uk
 * `sandbox.zohoapis.<dc>` and `www.zohoapis.<dc>/workdrive/api/v1` follow Zoho's `zohoapis.<dc>` pattern; only the `.com`
 * (live tests) and `.com.au` (community example) WorkDrive bases were seen in evidence, the others are pattern-derived
 * and must be confirmed in the Sandbox before use (see docs/onboarding/ZOHO_DATA_CENTRES.md).
 * UK is deliberately not accepted: no Sandbox API host for it is documented.
 */
export type Dc = "com" | "eu" | "in" | "com.au" | "jp" | "sa" | "ca";

const ACCOUNTS: Record<Dc, string> = {
  com: "accounts.zoho.com",
  eu: "accounts.zoho.eu",
  in: "accounts.zoho.in",
  "com.au": "accounts.zoho.com.au",
  jp: "accounts.zoho.jp",
  sa: "accounts.zoho.sa",
  ca: "accounts.zohocloud.ca",
};

const strip = (v: string): string => v.trim().replace(/\/+$/, "");
const dcOfKey = (k: string): Dc | null => (k in ACCOUNTS ? (k as Dc) : null);
const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `https://accounts.zoho.<dc>` (Canada: `https://accounts.zohocloud.ca`) -> DC, or null. */
export function dcOfAccountsDomain(url: string): Dc | null {
  const u = strip(url);
  for (const dc of Object.keys(ACCOUNTS) as Dc[]) if (u === `https://${ACCOUNTS[dc]}`) return dc;
  return null;
}

/** `https://sandbox.zohoapis.<dc>` -> DC, or null. */
export function dcOfSandboxApiDomain(url: string): Dc | null {
  const m = new RegExp(`^https://sandbox\\.zohoapis\\.(${(Object.keys(ACCOUNTS) as Dc[]).map(ESC).join("|")})$`).exec(strip(url));
  return m ? dcOfKey(m[1] as string) : null;
}

/** `https://www.zohoapis.<dc>` (the Production CRM API host, no path) -> DC, or null. */
export function dcOfProductionApiDomain(url: string): Dc | null {
  const m = new RegExp(`^https://www\\.zohoapis\\.(${(Object.keys(ACCOUNTS) as Dc[]).map(ESC).join("|")})$`).exec(strip(url));
  return m ? dcOfKey(m[1] as string) : null;
}

/** `https://www.zohoapis.<dc>/workdrive/api/v1` -> DC, or null. Nothing else is accepted as a WorkDrive API base. */
export function dcOfWorkDriveApiBase(url: string): Dc | null {
  const m = new RegExp(`^https://www\\.zohoapis\\.(${(Object.keys(ACCOUNTS) as Dc[]).map(ESC).join("|")})/workdrive/api/v1$`).exec(strip(url));
  return m ? dcOfKey(m[1] as string) : null;
}

/** Host of a token response's `api_domain` (`https://www.zohoapis.<dc>` or the sandbox host) -> DC, or null. */
export function dcOfApiDomain(url: string): Dc | null {
  const m = new RegExp(`^https://(?:www|sandbox)\\.zohoapis\\.(${(Object.keys(ACCOUNTS) as Dc[]).map(ESC).join("|")})$`).exec(strip(url));
  return m ? dcOfKey(m[1] as string) : null;
}

export const accountsDomainOf = (dc: Dc): string => `https://${ACCOUNTS[dc]}`;
export const workDriveApiBaseOf = (dc: Dc): string => `https://www.zohoapis.${dc}/workdrive/api/v1`;

/** Throws NOT_CONFIGURED unless every given DC is defined and identical. Messages never contain configured values. */
export function assertSameDc(what: string, ...dcs: Array<Dc | null>): Dc {
  const first = dcs[0];
  if (!first || dcs.some((d) => d !== first)) throw new StoreError("NOT_CONFIGURED", `${what}: data centres are missing or do not match`, "DC_MISMATCH");
  return first;
}
