import { StoreError } from "../errors";

/**
 * Configuration contract of the Zoho CRM Sandbox adapter for the Onboarding `Requests` module (server-side only).
 * CRM mode is OFF unless `SIX2FIT_ONBOARDING_STORE=crm` AND `SIX2FIT_ONBOARDING_CRM_ENABLED=true`. Only the Zoho SANDBOX is
 * supported (organisation zgid + type are verified before the first write); a missing or malformed value fails closed
 * with `NOT_CONFIGURED`. Error messages never contain configuration values.
 *
 *   SIX2FIT_ONBOARDING_CRM_ENABLED        "true"
 *   SIX2FIT_ZOHO_ENVIRONMENT              "sandbox"
 *   SIX2FIT_ZOHO_ORG_ZGID / _ORG_API_ID   expected Sandbox organisation (digits)
 *   SIX2FIT_ZOHO_API_DOMAIN               https://sandbox.zohoapis.<dc>
 *   SIX2FIT_ZOHO_ACCOUNTS_DOMAIN          https://accounts.zoho.<dc>
 *   SIX2FIT_ZOHO_MODULE_ID_PREFIX         expected id prefix of the Sandbox org
 *   SIX2FIT_ZOHO_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN   Sandbox grant only
 *   SIX2FIT_ONBOARDING_RAW_FIELD          API name of the large-text field that receives the COMPLETE answers (REQUIRED:
 *                                         the Requests module has no such field today; creating it is a schema decision)
 *   SIX2FIT_ONBOARDING_RAW_MAX_CHARS      capacity of that field (default 31000)
 *   SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS "true" lets CRM workflows run on the new Request (default: suppressed with
 *                                         `trigger: []`; the Sandbox still has active rules that point at Production Flow)
 *   SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG "true" sets Is_New_Record_Created (gate of `RequestOnCreateUpdate`); default off
 *   SIX2FIT_ZOHO_TIMEOUT_MS / _MAX_ATTEMPTS
 */
export type CrmConfig = {
  environment: "sandbox";
  orgZgid: string;
  orgApiId: string | undefined;
  apiDomain: string;
  accountsDomain: string;
  moduleIdPrefix: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  moduleApiName: string;
  rawField: string;
  maxRawPayloadChars: number;
  triggerAutomations: boolean;
  setNewRecordFlag: boolean;
  requestTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  verifyTtlMs: number;
};

/** Id prefix of the Production organisation: never accepted as the expected Sandbox prefix. */
export const PRODUCTION_ID_PREFIX = "6067417000";
export const REQUESTS_MODULE = "Requests";
export const RAW_FIELD_DEFAULT_CAPACITY = 31_000;

const DCS = "(com|eu|in|com\\.au|jp|com\\.cn|ca|sa)";
const API_DOMAIN = new RegExp(`^https://sandbox\\.zohoapis\\.${DCS}$`);
const ACCOUNTS_DOMAIN = new RegExp(`^https://accounts\\.zoho\\.${DCS}$`);

const notConfigured = (what: string): never => {
  throw new StoreError("NOT_CONFIGURED", `requests store: ${what}`, "CRM_NOT_CONFIGURED");
};

const positiveInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return notConfigured("invalid numeric limit");
  return n;
};

export function loadCrmConfig(env: Record<string, string | undefined>): CrmConfig {
  const get = (k: string) => (env[k] ?? "").trim();
  if (get("SIX2FIT_ONBOARDING_CRM_ENABLED") !== "true") notConfigured("CRM mode is not enabled");
  if (get("SIX2FIT_ZOHO_ENVIRONMENT").toLowerCase() !== "sandbox") notConfigured("only the sandbox environment is supported");
  const orgZgid = get("SIX2FIT_ZOHO_ORG_ZGID");
  if (!/^\d{6,20}$/.test(orgZgid)) notConfigured("organisation zgid missing or malformed");
  const orgApiIdRaw = get("SIX2FIT_ZOHO_ORG_API_ID");
  if (orgApiIdRaw !== "" && !/^\d{6,25}$/.test(orgApiIdRaw)) notConfigured("organisation api id malformed");
  const apiDomain = get("SIX2FIT_ZOHO_API_DOMAIN").replace(/\/+$/, "");
  if (!API_DOMAIN.test(apiDomain)) notConfigured("api domain must be a Zoho sandbox domain");
  const accountsDomain = get("SIX2FIT_ZOHO_ACCOUNTS_DOMAIN").replace(/\/+$/, "");
  if (!ACCOUNTS_DOMAIN.test(accountsDomain)) notConfigured("accounts domain missing or invalid");
  const moduleIdPrefix = get("SIX2FIT_ZOHO_MODULE_ID_PREFIX");
  if (!/^\d{6,20}$/.test(moduleIdPrefix) || moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX)) {
    notConfigured("expected sandbox id prefix missing or refers to Production");
  }
  const clientId = get("SIX2FIT_ZOHO_CLIENT_ID");
  const clientSecret = get("SIX2FIT_ZOHO_CLIENT_SECRET");
  const refreshToken = get("SIX2FIT_ZOHO_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) notConfigured("credentials missing");
  const rawField = get("SIX2FIT_ONBOARDING_RAW_FIELD");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(rawField)) notConfigured("complete-answers field is not configured (COMPLETE_PERSISTENCE_UNAVAILABLE)");

  return {
    environment: "sandbox",
    orgZgid,
    orgApiId: orgApiIdRaw === "" ? undefined : orgApiIdRaw,
    apiDomain,
    accountsDomain,
    moduleIdPrefix,
    clientId,
    clientSecret,
    refreshToken,
    moduleApiName: REQUESTS_MODULE,
    rawField,
    maxRawPayloadChars: positiveInt(env["SIX2FIT_ONBOARDING_RAW_MAX_CHARS"], RAW_FIELD_DEFAULT_CAPACITY, 1000, 1_000_000),
    triggerAutomations: get("SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS") === "true",
    setNewRecordFlag: get("SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG") === "true",
    requestTimeoutMs: positiveInt(env["SIX2FIT_ZOHO_TIMEOUT_MS"], 10_000, 1, 60_000),
    maxAttempts: positiveInt(env["SIX2FIT_ZOHO_MAX_ATTEMPTS"], 3, 1, 6),
    retryBaseMs: 500,
    verifyTtlMs: 15 * 60 * 1000,
  };
}
