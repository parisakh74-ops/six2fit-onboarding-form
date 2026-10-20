import { StoreError } from "../errors";
import type { CrmConfig } from "../crm/config";
import { assertSameDc, dcOfAccountsDomain, dcOfWorkDriveApiBase, type Dc } from "../zoho-dc";

/**
 * WorkDrive runtime configuration (server-side only). Required only when the CRM persistence mode is `workdrive-key` or
 * `workdrive-ref`. WorkDrive has its OWN OAuth grant (least privilege): the CRM refresh token is never reused, and the
 * grant must be created with file scopes only (see docs/onboarding/WORKDRIVE_OAUTH_SETUP.md). Error messages never
 * contain configured values.
 *
 *   SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN   https://accounts.zoho.<dc> (Canada: https://accounts.zohocloud.ca)
 *   SIX2FIT_WORKDRIVE_API_BASE          https://www.zohoapis.<dc>/workdrive/api/v1
 *   SIX2FIT_WORKDRIVE_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN
 *   SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID / _NAME   (validated by the CRM config; the approved root Team Folder)
 *   SIX2FIT_WORKDRIVE_ALLOW_CROSS_DC    "true" only if the WorkDrive team really lives in another data centre than the CRM
 *   SIX2FIT_WORKDRIVE_TIMEOUT_MS        per WorkDrive call (default 20000)
 *   SIX2FIT_WORKDRIVE_STAGING_DEADLINE_MS  budget for staging one submission (default 90000)
 *   SIX2FIT_WORKDRIVE_TOKEN_CACHE_DIR   optional private directory shared by worker processes for the short-lived access token
 */
export type WorkDriveConfig = {
  dc: Dc;
  accountsDomain: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId: string;
  rootFolderName: string;
  timeoutMs: number;
  stagingDeadlineMs: number;
  tokenCacheDir: string | undefined;
};

const notConfigured = (what: string, code = "WORKDRIVE_NOT_CONFIGURED"): never => {
  throw new StoreError("NOT_CONFIGURED", `workdrive: ${what}`, code);
};

const intIn = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return notConfigured("invalid numeric limit");
  return n;
};

export function loadWorkDriveConfig(env: Record<string, string | undefined>, crm: CrmConfig): WorkDriveConfig {
  const get = (k: string) => (env[k] ?? "").trim();
  const accountsDomain = get("SIX2FIT_WORKDRIVE_ACCOUNTS_DOMAIN").replace(/\/+$/, "");
  const apiBase = get("SIX2FIT_WORKDRIVE_API_BASE").replace(/\/+$/, "");
  const accountsDc = dcOfAccountsDomain(accountsDomain);
  const apiDc = dcOfWorkDriveApiBase(apiBase);
  if (!accountsDc) notConfigured("accounts domain missing or invalid");
  if (!apiDc) notConfigured("api base must be https://www.zohoapis.<dc>/workdrive/api/v1");
  const dc = assertSameDc("workdrive", accountsDc, apiDc);
  const crmDc = dcOfAccountsDomain(crm.accountsDomain);
  if (get("SIX2FIT_WORKDRIVE_ALLOW_CROSS_DC") !== "true") assertSameDc("workdrive and crm", dc, crmDc);

  const clientId = get("SIX2FIT_WORKDRIVE_CLIENT_ID");
  const clientSecret = get("SIX2FIT_WORKDRIVE_CLIENT_SECRET");
  const refreshToken = get("SIX2FIT_WORKDRIVE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) notConfigured("credentials missing");
  // Least privilege: the CRM grant must not double as the WorkDrive grant.
  if (refreshToken === crm.refreshToken) notConfigured("the workdrive grant must be separate from the crm grant", "WORKDRIVE_GRANT_SHARED");

  if (!crm.workdriveRootFolderId || !crm.workdriveRootFolderName) notConfigured("root folder is not configured", "WORKDRIVE_ROOT_REQUIRED");

  const cacheDir = get("SIX2FIT_WORKDRIVE_TOKEN_CACHE_DIR");
  return {
    dc,
    accountsDomain,
    apiBase,
    clientId,
    clientSecret,
    refreshToken,
    rootFolderId: crm.workdriveRootFolderId as string,
    rootFolderName: crm.workdriveRootFolderName as string,
    timeoutMs: intIn(env["SIX2FIT_WORKDRIVE_TIMEOUT_MS"], 20_000, 1, 60_000),
    stagingDeadlineMs: intIn(env["SIX2FIT_WORKDRIVE_STAGING_DEADLINE_MS"], 90_000, 1_000, 600_000),
    tokenCacheDir: cacheDir === "" ? undefined : cacheDir,
  };
}
