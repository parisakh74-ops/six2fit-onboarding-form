import { join } from "node:path";
import { StoreError } from "../errors";
import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import type { FileSink, OnboardingStore } from "../ports";
import type { WorkDriveApi } from "../workdrive/api";
import { loadWorkDriveConfig, type WorkDriveConfig } from "../workdrive/config";
import { HttpWorkDriveApi } from "../workdrive/http-api";
import { DeferredFileSink, WorkDriveStagingWriter, WorkDriveSubmissionStorage } from "../workdrive/storage";
import { FileTokenCache, WorkDriveTokenProvider } from "../workdrive/token-provider";
import { loadCrmConfig, type CrmConfig } from "./config";
import { createRequestsStore, createRequestsWriter, ledgerDirOf, ledgerOptionsFrom, type Overrides } from "./factory";

export type CrmRuntimeOverrides = Overrides & {
  /** Tests: a ready WorkDrive client (skips OAuth and HTTP). */
  workdriveApi?: WorkDriveApi;
  /** Tests: `fetch` for the WorkDrive token endpoint and API. */
  workdriveFetch?: typeof fetch;
};

export type CrmRuntime = {
  store: OnboardingStore;
  /** Where uploaded files go: the local staging sink in `raw-field` mode, the deferred (WorkDrive) sink otherwise. */
  sink: FileSink;
  persistence: CrmConfig["persistence"];
  config: CrmConfig;
  ledgerDir: string;
  ledgerLeaseMs: number | undefined;
  /** The raw CRM writer (lookups only are used by operations). */
  lookup?: { lookupId(uniqueFormKey: string): Promise<string | null> };
  workdrive?: { config: WorkDriveConfig; api: WorkDriveApi; storage: WorkDriveSubmissionStorage };
};

/** Per-call worst case of the CRM side of one create (verification, POST attempts, one lookup and read-back), see docs. */
export const crmWindowMs = (c: CrmConfig): number => (c.maxAttempts + 3) * c.requestTimeoutMs;

/** Worst case of the staging window: the staging budget plus the longest single file step (list, upload, list, get, download). */
export const stagingWindowMs = (w: WorkDriveConfig): number => w.stagingDeadlineMs + 5 * w.timeoutMs;

const SAFETY_MARGIN_MS = 30_000;

/**
 * THE composition root of the persistence side of the submission runtime.
 *
 *   raw-field:               LocalFileSink -> LedgerOnboardingStore -> RequestsStore (unchanged behaviour)
 *   workdrive-key / -ref:    DeferredFileSink (uploads stay in memory) ->
 *                            LedgerOnboardingStore -> WorkDriveStagingWriter -> RequestsStore
 *                                                     |-> WorkDriveSubmissionStorage -> HttpWorkDriveApi -> WorkDriveTokenProvider
 *
 * Fails closed with `NOT_CONFIGURED` before any network call when the configuration is incomplete or inconsistent. No
 * upload ever touches the local disk in a WorkDrive mode.
 */
export function createCrmRuntime(env: Record<string, string | undefined>, storageDir: string, localSink: FileSink, overrides: CrmRuntimeOverrides = {}): CrmRuntime {
  const config = loadCrmConfig(env);
  const ledgerDir = ledgerDirOf(env, join(storageDir, "onboarding-ledger"));
  if (config.persistence === "raw-field") {
    return { store: createRequestsStore(env, join(storageDir, "onboarding-ledger"), overrides), sink: localSink, persistence: config.persistence, config, ledgerDir, ledgerLeaseMs: undefined };
  }

  const wd = loadWorkDriveConfig(env, config);
  const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = overrides.now ?? (() => Date.now());
  let api = overrides.workdriveApi;
  if (!api) {
    const fetchImpl = overrides.workdriveFetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!fetchImpl) throw new StoreError("NOT_CONFIGURED", "workdrive: fetch unavailable", "WORKDRIVE_NOT_CONFIGURED");
    const tokens = new WorkDriveTokenProvider(
      { accountsDomain: wd.accountsDomain, clientId: wd.clientId, clientSecret: wd.clientSecret, refreshToken: wd.refreshToken, dc: wd.dc },
      {
        fetch: fetchImpl as never,
        now,
        sleep,
        ...(wd.tokenCacheDir ? { cache: new FileTokenCache(wd.tokenCacheDir, `${wd.clientId}:${wd.refreshToken}`) } : {}),
        ...(overrides.log ? { log: overrides.log } : {}),
      },
    );
    api = new HttpWorkDriveApi({ fetch: fetchImpl as never, accessToken: () => tokens.accessToken(), invalidateToken: (t) => tokens.invalidate(t), baseUrl: wd.apiBase, timeoutMs: wd.timeoutMs });
  }
  const storage = new WorkDriveSubmissionStorage(api, { rootFolderId: wd.rootFolderId, rootFolderName: wd.rootFolderName, deadlineMs: wd.stagingDeadlineMs, now });

  // Lease consistency (T08): a ledger claim must outlive the slowest legitimate staging or CRM window, otherwise a second
  // worker could take over while the first is still writing.
  const needed = Math.max(stagingWindowMs(wd), crmWindowMs(config)) + SAFETY_MARGIN_MS;
  const options = ledgerOptionsFrom(env, overrides, { leaseMs: needed });
  const lease = options.leaseMs ?? needed;
  if (lease < needed) throw new StoreError("NOT_CONFIGURED", "ledger lease is shorter than the staging and CRM time budget", "LEASE_TOO_SHORT");

  const writer = createRequestsWriter(env, {
    ...overrides,
    documentIdentityByKey: (key) => storage.readDocumentIdentityByKey(key),
    documentIdentity: (permalink, key) => storage.readDocumentIdentity(permalink, key),
  });
  const store = new LedgerOnboardingStore(new WorkDriveStagingWriter(writer, storage), new IdempotencyLedger(ledgerDir), options);
  return { store, sink: new DeferredFileSink(), persistence: config.persistence, config, ledgerDir, ledgerLeaseMs: lease, lookup: writer, workdrive: { config: wd, api, storage } };
}
