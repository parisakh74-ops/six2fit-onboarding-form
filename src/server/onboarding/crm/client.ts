import { StoreError } from "../errors";
import type { CrmConfig } from "./config";
import { PRODUCTION_ID_PREFIX } from "./config";

/**
 * VENDORED from the Consultation backend (`src/server/consult/crm/client.ts`): keep both copies in step until a shared package exists.
 * Minimal Zoho CRM v8 HTTP client (no business logic). `fetch`, the clock and the sleeper are
 * injected so the whole adapter runs against a deterministic mock without any network access.
 * Secrets (client secret, refresh token, access token) are only held in memory, only sent to the
 * configured Zoho hosts, and never appear in errors or logs.
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export type ClientDeps = {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** Transport-level failure: the request may or may not have reached Zoho. */
export class ZohoTransportError extends Error {
  constructor(public readonly reason: "timeout" | "network") {
    super(`zoho transport failure: ${reason}`);
    this.name = "ZohoTransportError";
  }
}

export type ZohoResponse = {
  status: number;
  /** Parsed JSON body; `null` for an empty body (HTTP 204); `INVALID` when the body is not JSON. */
  json: unknown | null | typeof INVALID;
  retryAfterMs: number | undefined;
};
export const INVALID = Symbol("invalid-json");

type Token = { value: string; expiresAt: number };

const TOKEN_SAFETY_MS = 5 * 60 * 1000;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Sandbox: the configured `sandbox.zohoapis.<dc>` host or the generic `www.zohoapis.<dc>` of the same data centre (observed for
 * Sandbox grants). Production: exactly the configured `www.zohoapis.<dc>` host, never a Sandbox host.
 */
const sameDataCentre = (returnedHost: string, configuredHost: string, environment: CrmConfig["environment"]): boolean => {
  if (environment === "production") return /^www\.zohoapis\.[a-z.]+$/.test(configuredHost) && returnedHost === configuredHost;
  const m = /^sandbox\.zohoapis\.(.+)$/.exec(configuredHost);
  if (!m) return false;
  return returnedHost === configuredHost || returnedHost === `www.zohoapis.${m[1]}`;
};

export class ZohoClient {
  private token: Token | null = null;
  private refreshing: Promise<Token> | null = null;
  private verifiedAt = 0;
  private verifying: Promise<void> | null = null;

  constructor(
    private readonly config: CrmConfig,
    private readonly deps: ClientDeps,
  ) {}

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<ZohoResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ZohoTransportError("timeout"));
      }, this.config.requestTimeoutMs);
    });
    try {
      const response = await Promise.race([this.deps.fetch(url, { ...init, signal: controller.signal }), timeout]);
      const text = await Promise.race([response.text(), timeout]);
      let json: unknown | null | typeof INVALID;
      if (text.trim() === "") json = null;
      else {
        try {
          json = JSON.parse(text);
        } catch {
          json = INVALID;
        }
      }
      const retryHeader = response.headers.get("retry-after");
      const seconds = retryHeader === null ? NaN : Number(retryHeader);
      return {
        status: response.status,
        json,
        retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : undefined,
      };
    } catch (e) {
      if (e instanceof ZohoTransportError) throw e;
      throw new ZohoTransportError("network");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refreshToken(): Promise<Token> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }).toString();
        let res: ZohoResponse;
        try {
          res = await this.send(`${this.config.accountsDomain}/oauth/v2/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          });
        } catch (e) {
          if (e instanceof ZohoTransportError) throw new StoreError("UNAVAILABLE", "token endpoint unreachable", "TOKEN_TRANSPORT");
          throw e;
        }
        const j = res.json as { access_token?: unknown; api_domain?: unknown; expires_in?: unknown; error?: unknown } | null | typeof INVALID;
        if (res.status !== 200 || j === null || j === INVALID || typeof j !== "object" || typeof j.access_token !== "string" || j.access_token === "") {
          throw new StoreError("UNAVAILABLE", "token refresh failed", "AUTH_FAILED");
        }
        // Fail closed: the returned api_domain must be the Sandbox host or the generic host of the SAME data centre
        // (observed: a Sandbox grant returns https://www.zohoapis.<dc>). It is never used for requests; the configured
        // Sandbox host is. Sandbox identity is proven by the organisation zgid + type (verifyEnvironment).
        if (typeof j.api_domain !== "string" || !isHttps(j.api_domain) || !sameDataCentre(hostOf(j.api_domain), hostOf(this.config.apiDomain), this.config.environment)) {
          throw new StoreError("NOT_CONFIGURED", "token api_domain does not belong to the configured data centre", "ENV_MISMATCH");
        }
        const lifetime = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
        this.token = { value: j.access_token, expiresAt: this.deps.now() + lifetime * 1000 };
        return this.token;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.deps.now() < this.token.expiresAt - TOKEN_SAFETY_MS) return this.token.value;
    return (await this.refreshToken()).value;
  }

  /** Authenticated API call. One transparent token refresh on HTTP 401. */
  async request(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<ZohoResponse> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const url = `${this.config.apiDomain}/crm/v8${path}${qs}`;
    const attempt = async (): Promise<ZohoResponse> => {
      const headers: Record<string, string> = {
        authorization: `Zoho-oauthtoken ${await this.accessToken()}`,
        accept: "application/json",
      };
      const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      return this.send(url, init);
    };
    const first = await attempt();
    if (first.status !== 401) return first;
    // Missing scope also arrives as 401 but a new token cannot fix it.
    if (first.json && first.json !== INVALID && typeof first.json === "object" && (first.json as { code?: unknown }).code === "OAUTH_SCOPE_MISMATCH") return first;
    this.token = null;
    return attempt();
  }

  /** A token without the needed scope is answered with HTTP 401 `OAUTH_SCOPE_MISMATCH` (documented): not an expired token. */
  private assertScope(res: ZohoResponse): void {
    const j = res.json;
    if (res.status === 401 && j && j !== INVALID && typeof j === "object" && (j as { code?: unknown }).code === "OAUTH_SCOPE_MISMATCH") {
      throw new StoreError("NOT_CONFIGURED", "oauth scope missing", "SCOPE_MISSING");
    }
  }

  /**
   * Environment guard, run before the first write and again after `verifyTtlMs`:
   *  - the organisation behind the token must be the configured Sandbox organisation,
   *  - the target module (Requests) must exist and carry an id of the expected Sandbox prefix
   *    (never the Production prefix).
   * Any missing or mismatching answer fails closed with NOT_CONFIGURED (nothing is written).
   */
  async verifyEnvironment(): Promise<void> {
    if (this.verifiedAt && this.deps.now() - this.verifiedAt < this.config.verifyTtlMs) return;
    if (this.verifying) return this.verifying;
    this.verifying = (async () => {
      try {
        const org = await this.request("GET", "/org");
        this.assertScope(org);
        const orgs = (org.json as { org?: Array<{ id?: unknown; zgid?: unknown; type?: unknown }> } | null | typeof INVALID);
        const orgList = org.status === 200 && orgs && orgs !== INVALID && Array.isArray(orgs.org) ? orgs.org : [];
        if (orgList.length > 1) throw new StoreError("NOT_CONFIGURED", "organisation is ambiguous", "ENV_UNVERIFIED");
        const first = orgList[0];
        const zgid = first?.zgid;
        const apiId = first?.id;
        const present = (v: unknown) => (typeof v === "string" && v !== "") || typeof v === "number";
        if (!present(zgid) || !present(apiId)) {
          throw new StoreError("NOT_CONFIGURED", "organisation could not be verified", "ENV_UNVERIFIED");
        }
        // Observed contract: the CRM UI "Org ID" is the API `zgid`; the API `id` is a different number.
        if (String(zgid) !== this.config.orgZgid) {
          throw new StoreError("NOT_CONFIGURED", "organisation mismatch", "ENV_MISMATCH");
        }
        if (this.config.orgApiId !== undefined && String(apiId) !== this.config.orgApiId) {
          throw new StoreError("NOT_CONFIGURED", "organisation api id mismatch", "ENV_MISMATCH");
        }
        // Documented `type` of GET /org: production | sandbox | bigin | developer.
        // The organisation type must equal the explicitly configured environment (never the other way round).
        if (first?.type !== this.config.environment) {
          throw new StoreError("NOT_CONFIGURED", `organisation type does not match the configured environment (${this.config.environment})`, "ENV_MISMATCH");
        }
        // The organisation api id must also carry the environment's prefix (a second identity check besides the configured pin).
        if (String(apiId).startsWith(PRODUCTION_ID_PREFIX) !== (this.config.environment === "production")) {
          throw new StoreError("NOT_CONFIGURED", "organisation api id does not belong to the configured environment", "ENV_MISMATCH");
        }
        // Documented list endpoint (the single-module endpoint is not documented in the v8 pages reviewed).
        const mod = await this.request("GET", "/settings/modules");
        this.assertScope(mod);
        const mj = mod.json as { modules?: Array<{ api_name?: unknown; id?: unknown }> } | null | typeof INVALID;
        const matches = mod.status === 200 && mj && mj !== INVALID && Array.isArray(mj.modules) ? mj.modules.filter((x) => x.api_name === this.config.moduleApiName) : [];
        if (matches.length > 1) throw new StoreError("NOT_CONFIGURED", "module is ambiguous", "ENV_UNVERIFIED");
        const m = matches[0];
        const id = m && typeof m.id === "string" ? m.id : "";
        if (!m || m.api_name !== this.config.moduleApiName || id === "") {
          throw new StoreError("NOT_CONFIGURED", "module could not be verified", "ENV_UNVERIFIED");
        }
        if (id.startsWith(PRODUCTION_ID_PREFIX) !== (this.config.environment === "production") || !id.startsWith(this.config.moduleIdPrefix)) {
          throw new StoreError("NOT_CONFIGURED", "module id does not belong to the expected organisation of the configured environment", "ENV_MISMATCH");
        }
        this.verifiedAt = this.deps.now();
      } catch (e) {
        this.verifiedAt = 0;
        if (e instanceof StoreError) throw e;
        if (e instanceof ZohoTransportError) throw new StoreError("UNAVAILABLE", "environment verification unreachable", "VERIFY_TRANSPORT");
        throw new StoreError("UNAVAILABLE", "environment verification failed", "VERIFY_FAILED");
      } finally {
        this.verifying = null;
      }
    })();
    return this.verifying;
  }
}
