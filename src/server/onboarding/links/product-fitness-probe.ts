import { StoreError } from "../errors";
import type { ZohoResponse } from "../crm/client";
import { INVALID } from "../crm/client";

/**
 * Test-harness support for the READ-ONLY Product.Fitness probe (`product-fitness.live.test.ts`). Not used by the application.
 *
 * `PROBE_ENV` is the non-secret Sandbox configuration the operator script must supply besides the three OAuth values. It is the
 * configuration of the already working Sandbox tests (`tools/s2f-sandbox-first-write.ps1`): the persistence mode MUST be named
 * (the default `raw-field` demands a complete-answers field), which in `workdrive-key` mode only requires a root folder id/name;
 * the probe never contacts WorkDrive. Production validation is NOT weakened: this only fills in values the validator demands.
 */
export const PROBE_ENV: Readonly<Record<string, string>> = {
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: "850673613",
  SIX2FIT_ZOHO_API_DOMAIN: "https://sandbox.zohoapis.com",
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: "https://accounts.zoho.com",
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_TIMEOUT_MS: "20000",
  SIX2FIT_ONBOARDING_CRM_PERSISTENCE: "workdrive-key",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: "76a80aad8e6f6764944278234c783ad4a4f95",
  SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: "S2F-ONBOARDING-TEST",
};

export type ProbeCategory =
  | "SUCCESS"
  | "CONFIGURATION_FAILURE"
  | "AUTHENTICATION_FAILURE"
  | "ENVIRONMENT_MISMATCH"
  | "CRM_UNREACHABLE"
  | "DEAL_NOT_READABLE"
  | "INSUFFICIENT_PRODUCT_READ_PERMISSION"
  | "PRODUCTS_MODULE_MISSING"
  | "FITNESS_FIELD_MISSING"
  | "PRODUCT_NOT_FOUND"
  | "UNEXPECTED_RESPONSE";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Maps a failure while building the config or verifying the environment/token to its category (never the message). */
export function classifyStoreError(e: unknown): ProbeCategory {
  if (!(e instanceof StoreError)) return "UNEXPECTED_RESPONSE";
  if (e.code === "AUTH_FAILED") return "AUTHENTICATION_FAILURE";
  if (e.code === "TOKEN_TRANSPORT" || e.kind === "UNAVAILABLE") return "CRM_UNREACHABLE";
  if (e.code === "SCOPE_MISSING") return "INSUFFICIENT_PRODUCT_READ_PERMISSION"; // the grant lacks a scope the first call needs
  if (e.code === "ENV_MISMATCH" || e.code === "ENV_UNVERIFIED") return "ENVIRONMENT_MISMATCH";
  if (e.kind === "NOT_CONFIGURED") return "CONFIGURATION_FAILURE";
  return "UNEXPECTED_RESPONSE";
}

/** Classifies the raw answer of `GET /Products/{id}?fields=id,Fitness`. */
export function classifyProductResponse(res: ZohoResponse, productId: string): ProbeCategory {
  const j = res.json;
  const code = isObj(j) && typeof j["code"] === "string" ? j["code"] : "";
  const details = isObj(j) && isObj(j["details"]) ? j["details"] : {};
  if (res.status === 401 || res.status === 403 || code === "OAUTH_SCOPE_MISMATCH" || code === "NO_PERMISSION") return "INSUFFICIENT_PRODUCT_READ_PERMISSION";
  if (res.status === 204 || res.status === 404) return "PRODUCT_NOT_FOUND";
  if (res.status === 400) {
    if (code === "INVALID_MODULE") return "PRODUCTS_MODULE_MISSING";
    if (code === "INVALID_DATA" && details["api_name"] === "id") return "PRODUCT_NOT_FOUND";
    if (code === "INVALID_DATA" || code === "INVALID_QUERY") return "FITNESS_FIELD_MISSING";
    return "UNEXPECTED_RESPONSE";
  }
  if (res.status === 200 && j !== INVALID && isObj(j) && Array.isArray(j["data"])) {
    const row = j["data"].find(isObj);
    if (!row || row["id"] !== productId) return "PRODUCT_NOT_FOUND";
    return Object.hasOwn(row, "Fitness") ? "SUCCESS" : "FITNESS_FIELD_MISSING";
  }
  return "UNEXPECTED_RESPONSE";
}

export const CATEGORY_MESSAGE: Readonly<Record<ProbeCategory, string>> = {
  SUCCESS: "Product.Fitness is readable with the current Sandbox credentials.",
  CONFIGURATION_FAILURE: "The probe configuration is incomplete or invalid; no CRM request was made. This says nothing about permissions.",
  AUTHENTICATION_FAILURE: "The Sandbox refresh token or client could not obtain an access token (revoked, expired or wrong client). A new grant is needed.",
  ENVIRONMENT_MISMATCH: "The token does not belong to the configured Sandbox organisation/data centre; nothing was read.",
  CRM_UNREACHABLE: "Zoho could not be reached (network/proxy/timeout); no conclusion about permissions.",
  DEAL_NOT_READABLE: "The synthetic Deal could not be read (missing Deal read scope or the Deal does not exist).",
  INSUFFICIENT_PRODUCT_READ_PERMISSION: "The grant lacks permission to READ Products: add scope ZohoCRM.modules.products.READ (new grant code, same Self Client).",
  PRODUCTS_MODULE_MISSING: "The Products module is not available through the API in this Sandbox.",
  FITNESS_FIELD_MISSING: "The Products module has no readable field `Fitness` in this Sandbox (field absent or not API-visible).",
  PRODUCT_NOT_FOUND: "The Deal's product was not found when read.",
  UNEXPECTED_RESPONSE: "Zoho answered in an unexpected way; see the status category in the result file.",
};
