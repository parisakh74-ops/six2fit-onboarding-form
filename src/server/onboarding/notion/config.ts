import { StoreError } from "../errors";

/**
 * Notion sync configuration (server-only environment). The sync is OFF unless `SIX2FIT_NOTION_SYNC=true`.
 *
 * Safety rules, all enforced here before any request can be built:
 *  - the target must be declared `SIX2FIT_NOTION_TARGET=test`; a `live` target is refused (the live cut-over is a separate,
 *    PM-approved change) and the legacy production database/data-source ids are refused even when the target says `test`;
 *  - the token is read from the environment only (private env file) and is never part of any structure that is logged.
 */
export const LIVE_NOTION_DATABASE_IDS: readonly string[] = ["1d4d73e99527802d920bd7f8da0a37bd", "1d4d73e9952781f7a40f000bb78ae018"];

export type NotionConfig = {
  token: string;
  databaseId: string;
  version: string;
  baseUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  /** Minimum spacing between requests (the documented average is 3 requests per second). */
  minIntervalMs: number;
  /** Lease of the per-submission sync lock; a crashed worker's lock is taken over after this time. */
  leaseMs: number;
  /** Uploads not attached within this window are re-created (Notion expires an unattached upload after one hour). */
  uploadMaxAgeMs: number;
  /** Time the request may wait for the first sync attempt (0 = none: the durable pending entry + reconciliation do the work). */
  inlineBudgetMs: number;
};

export const normalizeNotionId = (raw: string): string => raw.trim().replace(/-/g, "").toLowerCase();

const bad = (code: string): StoreError => new StoreError("NOT_CONFIGURED", "notion: invalid configuration", code);

export const notionSyncEnabled = (env: Record<string, string | undefined>): boolean => (env["SIX2FIT_NOTION_SYNC"] ?? "").trim().toLowerCase() === "true";

export function loadNotionConfig(env: Record<string, string | undefined>): NotionConfig {
  if ((env["SIX2FIT_NOTION_TARGET"] ?? "").trim().toLowerCase() !== "test") throw bad("NOTION_TARGET_NOT_TEST");
  const token = (env["SIX2FIT_NOTION_TOKEN"] ?? "").trim();
  if (token.length < 20) throw bad("NOTION_TOKEN_MISSING");
  const databaseId = normalizeNotionId(env["SIX2FIT_NOTION_DATABASE_ID"] ?? "");
  if (!/^[0-9a-f]{32}$/.test(databaseId)) throw bad("NOTION_DATABASE_ID_INVALID");
  if (LIVE_NOTION_DATABASE_IDS.includes(databaseId)) throw bad("NOTION_LIVE_DATABASE_REFUSED");
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw bad("NOTION_NUMBER_INVALID");
    return n;
  };
  return {
    token,
    databaseId,
    version: (env["SIX2FIT_NOTION_VERSION"] ?? "").trim() || "2022-06-28",
    baseUrl: (env["SIX2FIT_NOTION_API_BASE"] ?? "").trim() || "https://api.notion.com",
    timeoutMs: num("SIX2FIT_NOTION_TIMEOUT_MS", 30_000, 1_000, 120_000),
    maxAttempts: num("SIX2FIT_NOTION_MAX_ATTEMPTS", 4, 1, 8),
    minIntervalMs: num("SIX2FIT_NOTION_MIN_INTERVAL_MS", 350, 0, 5_000),
    leaseMs: num("SIX2FIT_NOTION_LEASE_MS", 10 * 60_000, 10_000, 3_600_000),
    uploadMaxAgeMs: num("SIX2FIT_NOTION_UPLOAD_MAX_AGE_MS", 45 * 60_000, 60_000, 55 * 60_000),
    inlineBudgetMs: num("SIX2FIT_NOTION_INLINE_BUDGET_MS", 20_000, 0, 120_000),
  };
}
