import { StoreError } from "../errors";
import { dcOfAccountsDomain, dcOfProductionApiDomain, dcOfSandboxApiDomain } from "../zoho-dc";

/**
 * Configuration contract of the Zoho CRM adapter for the Onboarding `Requests` module (server-side only).
 * CRM mode is OFF unless `SIX2FIT_ONBOARDING_STORE=crm` AND `SIX2FIT_ONBOARDING_CRM_ENABLED=true`. The Zoho environment is
 * EXPLICIT (`sandbox` or `production`, no default, never inferred): host, accounts domain, organisation identity and module id
 * prefix must all match it, and organisation zgid + api id + type are verified before the first write. A missing, malformed or
 * cross-environment value fails closed with `NOT_CONFIGURED`. Error messages never contain configuration values.
 *
 *   SIX2FIT_ONBOARDING_CRM_ENABLED        "true"
 *   SIX2FIT_ZOHO_ENVIRONMENT              "sandbox" | "production" (required)
 *   SIX2FIT_ZOHO_ORG_ZGID                 expected organisation zgid (digits)
 *   SIX2FIT_ZOHO_ORG_API_ID               expected organisation API id; REQUIRED in production (must start with the Production prefix),
 *                                         optional in sandbox (must not)
 *   SIX2FIT_ZOHO_API_DOMAIN               sandbox: https://sandbox.zohoapis.<dc>   production: https://www.zohoapis.<dc>
 *   SIX2FIT_ZOHO_ACCOUNTS_DOMAIN          https://accounts.zoho.<dc> (same data centre as the API domain)
 *   SIX2FIT_ZOHO_MODULE_ID_PREFIX         expected id prefix of the organisation (production: 6067417000...; sandbox: never that)
 *   SIX2FIT_ZOHO_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN   grant of the SAME environment only
 *   SIX2FIT_ONBOARDING_RAW_FIELD          API name of the large-text field that receives the COMPLETE answers (REQUIRED:
 *                                         the Requests module has no such field today; creating it is a schema decision)
 *   SIX2FIT_ONBOARDING_RAW_MAX_CHARS      capacity of that field (default 31000)
 *   SIX2FIT_ONBOARDING_CRM_PERSISTENCE    "raw-field" (default: complete answers in RAW_FIELD), "workdrive-ref" or "workdrive-key".
 *                                         "workdrive-key" (MVP): the complete answers and files live ONLY in WorkDrive; the CRM Request
 *                                         carries no raw JSON and no document reference. The link is the existing `uniqueformkey`
 *                                         (= WorkDrive submission folder name). RAW_FIELD and DOC_REF_FIELD must both be unset, and
 *                                         SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID / _NAME (the approved root Team Folder) are REQUIRED.
 *                                         In "workdrive-ref" mode: the complete
 *                                         answers live in WorkDrive and the CRM stores ONLY the private WorkDrive permalink of
 *                                         the canonical JSON document. RAW_FIELD must then be unset (no raw JSON reaches the CRM).
 *   SIX2FIT_ONBOARDING_DOC_REF_FIELD      API name of the Requests field that receives the permalink. REQUIRED in "workdrive-ref"
 *                                         mode, deliberately has NO default: the field choice is a Product decision.
 *   SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS "true" lets CRM workflows run on the new Request (default: suppressed with
 *                                         `trigger: []`; the Sandbox still has active rules that point at Production Flow)
 *   SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG "true" sets Is_New_Record_Created (gate of `RequestOnCreateUpdate`); default off
 *   SIX2FIT_ZOHO_TIMEOUT_MS / _MAX_ATTEMPTS
 */
export type CrmConfig = {
  environment: "sandbox" | "production";
  orgZgid: string;
  orgApiId: string | undefined;
  apiDomain: string;
  accountsDomain: string;
  moduleIdPrefix: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  moduleApiName: string;
  persistence: "raw-field" | "workdrive-ref" | "workdrive-key";
  /** Raw-field mode only. */
  rawField: string | undefined;
  /** WorkDrive-reference mode only. */
  docRefField: string | undefined;
  /** WorkDrive persistence modes: the one approved root Team Folder (id and expected title). */
  workdriveRootFolderId: string | undefined;
  workdriveRootFolderName: string | undefined;
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


const notConfigured = (what: string): never => {
  throw new StoreError("NOT_CONFIGURED", `requests store: ${what}`, "CRM_NOT_CONFIGURED");
};

const positiveInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return notConfigured("invalid numeric limit");
  return n;
};

/** Fields that must never receive the document reference: core keys of this adapter and fields owned by other integrations. */
const DOC_REF_FIELD_DENYLIST = new Set(["id", "Name", "Owner", "uniqueformkey", "Deal", "Contact", "Product", "Request_Status", "Submission_Id", "Form_Version", "Submitted_At", "Onboarding_Scope", "Form_Complete", "Form_Completion_Date", "Is_New_Record_Created", "Is_First_Request", "Product_Related_To", "Email", "Document_Reference", "Medical_Documents", "Onboarding_Raw_JSON"]);

/** Returns why a field name cannot hold the document reference, or null. Mapped structured fields are checked in `requests-mapping`. */
export function docRefFieldProblem(name: string): string | null {
  if (DOC_REF_FIELD_DENYLIST.has(name)) return "reserved by this adapter or by another integration";
  if (/^Trello_/i.test(name)) return "belongs to the Trello integration";
  return null;
}

export function loadCrmConfig(env: Record<string, string | undefined>): CrmConfig {
  const get = (k: string) => (env[k] ?? "").trim();
  if (get("SIX2FIT_ONBOARDING_CRM_ENABLED") !== "true") notConfigured("CRM mode is not enabled");
  // The environment is ALWAYS explicit: never inferred from a token, a host name or an id prefix, and there is no default.
  const envRaw = get("SIX2FIT_ZOHO_ENVIRONMENT").toLowerCase();
  if (envRaw !== "sandbox" && envRaw !== "production") notConfigured("SIX2FIT_ZOHO_ENVIRONMENT must be explicitly 'sandbox' or 'production'");
  const environment: "sandbox" | "production" = envRaw === "production" ? "production" : "sandbox";
  const production = environment === "production";
  const orgZgid = get("SIX2FIT_ZOHO_ORG_ZGID");
  if (!/^\d{6,20}$/.test(orgZgid)) notConfigured("organisation zgid missing or malformed");
  const orgApiIdRaw = get("SIX2FIT_ZOHO_ORG_API_ID");
  if (orgApiIdRaw !== "" && !/^\d{6,25}$/.test(orgApiIdRaw)) notConfigured("organisation api id malformed");
  // Production: the organisation API id is mandatory (a second, independent identity pin) and carries the Production prefix;
  // Sandbox: it must not carry the Production prefix.
  if (production && orgApiIdRaw === "") notConfigured("organisation api id is required in production");
  if (orgApiIdRaw !== "" && orgApiIdRaw.startsWith(PRODUCTION_ID_PREFIX) !== production) notConfigured("organisation api id does not belong to the configured environment");
  const apiDomain = get("SIX2FIT_ZOHO_API_DOMAIN").replace(/\/+$/, "");
  const apiDc = production ? dcOfProductionApiDomain(apiDomain) : dcOfSandboxApiDomain(apiDomain);
  if (!apiDc) notConfigured(production ? "api domain must be a Zoho production domain (https://www.zohoapis.<dc>)" : "api domain must be a Zoho sandbox domain");
  const accountsDomain = get("SIX2FIT_ZOHO_ACCOUNTS_DOMAIN").replace(/\/+$/, "");
  const accountsDc = dcOfAccountsDomain(accountsDomain);
  if (!accountsDc) notConfigured("accounts domain missing or invalid");
  // A token request must never go to a different data centre than the API it authorises (credentials would leave the DC).
  if (apiDc !== accountsDc) notConfigured("accounts and api domains belong to different data centres");
  const moduleIdPrefix = get("SIX2FIT_ZOHO_MODULE_ID_PREFIX");
  if (!/^\d{6,20}$/.test(moduleIdPrefix)) notConfigured("expected module id prefix missing or malformed");
  // Sandbox must never carry the Production prefix; Production must carry exactly the Production organisation's prefix.
  if (production ? !moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX) : moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX)) {
    notConfigured(production ? "expected id prefix is not the Production prefix" : "expected sandbox id prefix refers to Production");
  }
  const clientId = get("SIX2FIT_ZOHO_CLIENT_ID");
  const clientSecret = get("SIX2FIT_ZOHO_CLIENT_SECRET");
  const refreshToken = get("SIX2FIT_ZOHO_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) notConfigured("credentials missing");
  // The REST API addresses a module by its API name. A renamed custom module keeps its original API name: the Sandbox Setup UI
  // (observed 2026-10-20) lists the module displayed as "Requests" under the module name `CustomModule3`, and the Trello discovery
  // doc says the same for Production. The default below is therefore NOT trusted for a live Sandbox: set the real API name
  // explicitly (readiness reports a mismatch as ENV_UNVERIFIED / missing Requests fields).
  const moduleApiName = get("SIX2FIT_ONBOARDING_REQUESTS_MODULE") || REQUESTS_MODULE;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(moduleApiName)) notConfigured("requests module api name is invalid");
  const modeRaw = get("SIX2FIT_ONBOARDING_CRM_PERSISTENCE") || "raw-field";
  if (modeRaw !== "raw-field" && modeRaw !== "workdrive-ref" && modeRaw !== "workdrive-key") notConfigured("unknown persistence mode");
  const mode: "raw-field" | "workdrive-ref" | "workdrive-key" = modeRaw === "workdrive-ref" ? "workdrive-ref" : modeRaw === "workdrive-key" ? "workdrive-key" : "raw-field";
  const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
  let rawField: string | undefined;
  let docRefField: string | undefined;
  if (mode === "raw-field") {
    rawField = get("SIX2FIT_ONBOARDING_RAW_FIELD");
    if (!FIELD_NAME.test(rawField)) notConfigured("complete-answers field is not configured (COMPLETE_PERSISTENCE_UNAVAILABLE)");
    if (get("SIX2FIT_ONBOARDING_DOC_REF_FIELD") !== "") notConfigured("document reference field is only valid in workdrive-ref mode");
  } else if (mode === "workdrive-key") {
    // No CRM field is configured or written for the document: the correlation key is `uniqueformkey` itself.
    if (get("SIX2FIT_ONBOARDING_RAW_FIELD") !== "") notConfigured("raw answers field must be unset in workdrive-key mode");
    if (get("SIX2FIT_ONBOARDING_DOC_REF_FIELD") !== "") notConfigured("document reference field must be unset in workdrive-key mode");
  } else {
    docRefField = get("SIX2FIT_ONBOARDING_DOC_REF_FIELD");
    if (!FIELD_NAME.test(docRefField)) notConfigured("document reference field is not configured (DOC_REF_FIELD_REQUIRED)");
    const reason = docRefFieldProblem(docRefField);
    if (reason) notConfigured(`document reference field is not usable (${reason})`);
    // Never let the complete answers reach the CRM in this mode.
    if (get("SIX2FIT_ONBOARDING_RAW_FIELD") !== "") notConfigured("raw answers field must be unset in workdrive-ref mode");
  }
  let workdriveRootFolderId: string | undefined;
  let workdriveRootFolderName: string | undefined;
  if (mode === "workdrive-key") {
    workdriveRootFolderId = get("SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID");
    workdriveRootFolderName = get("SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME");
    if (!/^[A-Za-z0-9]{20,64}$/.test(workdriveRootFolderId)) notConfigured("WorkDrive root folder id is not configured (WORKDRIVE_ROOT_REQUIRED)");
    if (workdriveRootFolderName === "" || workdriveRootFolderName.length > 100) notConfigured("WorkDrive root folder name is not configured (WORKDRIVE_ROOT_REQUIRED)");
  }

  return {
    environment,
    orgZgid,
    orgApiId: orgApiIdRaw === "" ? undefined : orgApiIdRaw,
    apiDomain,
    accountsDomain,
    moduleIdPrefix,
    clientId,
    clientSecret,
    refreshToken,
    moduleApiName,
    persistence: mode,
    rawField,
    docRefField,
    workdriveRootFolderId,
    workdriveRootFolderName,
    maxRawPayloadChars: positiveInt(env["SIX2FIT_ONBOARDING_RAW_MAX_CHARS"], RAW_FIELD_DEFAULT_CAPACITY, 1000, 1_000_000),
    triggerAutomations: get("SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS") === "true",
    setNewRecordFlag: get("SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG") === "true",
    requestTimeoutMs: positiveInt(env["SIX2FIT_ZOHO_TIMEOUT_MS"], 10_000, 1, 60_000),
    maxAttempts: positiveInt(env["SIX2FIT_ZOHO_MAX_ATTEMPTS"], 3, 1, 6),
    retryBaseMs: 500,
    verifyTtlMs: 15 * 60 * 1000,
  };
}
