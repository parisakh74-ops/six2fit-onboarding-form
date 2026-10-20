import { IdempotencyLedger, LedgerOnboardingStore } from "../ledger";
import { StoreError } from "../errors";
import type { OnboardingStore } from "../ports";
import { ZohoClient, type ClientDeps } from "./client";
import { loadCrmConfig } from "./config";
import { RequestsStore, type RequestsStoreDeps } from "./requests-store";

type Overrides = Partial<ClientDeps> & { log?: (event: string, fields: Record<string, string | number | boolean>) => void; documentIdentity?: RequestsStoreDeps["documentIdentity"]; documentIdentityByKey?: RequestsStoreDeps["documentIdentityByKey"] };

/** Builds the raw CRM writer (no ledger). Pure configuration: no network until the first call. */
export function createRequestsWriter(env: Record<string, string | undefined>, overrides: Overrides = {}): RequestsStore {
  const config = loadCrmConfig(env);
  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as ClientDeps["fetch"] | undefined);
  if (!fetchImpl) throw new StoreError("NOT_CONFIGURED", "requests store: fetch unavailable", "CRM_NOT_CONFIGURED");
  const deps: ClientDeps = {
    fetch: fetchImpl,
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  return new RequestsStore({ client: new ZohoClient(config, deps), config, now: deps.now, sleep: deps.sleep, ...(overrides.log ? { log: overrides.log } : {}), ...(overrides.documentIdentity ? { documentIdentity: overrides.documentIdentity } : {}), ...(overrides.documentIdentityByKey ? { documentIdentityByKey: overrides.documentIdentityByKey } : {}) });
}

/** Production composition: CRM writer behind the persistent idempotency ledger (`ledgerDir` must be persistent, outside any web root). */
export function createRequestsStore(env: Record<string, string | undefined>, defaultLedgerDir: string, overrides: Overrides = {}): OnboardingStore {
  const inner = createRequestsWriter(env, overrides);
  const dir = (env["SIX2FIT_ONBOARDING_LEDGER_DIR"] ?? "").trim() || defaultLedgerDir;
  const num = (k: string): number | undefined => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const leaseMs = num("SIX2FIT_ONBOARDING_LEDGER_LEASE_MS");
  const quiesceMs = num("SIX2FIT_ONBOARDING_LEDGER_QUIESCE_MS");
  const waitMs = num("SIX2FIT_ONBOARDING_LEDGER_WAIT_MS");
  return new LedgerOnboardingStore(inner, new IdempotencyLedger(dir), {
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ...(overrides.log ? { log: overrides.log } : {}),
    ...(leaseMs ? { leaseMs } : {}),
    ...(quiesceMs ? { quiesceMs } : {}),
    ...(waitMs ? { waitMs } : {}),
  });
}
