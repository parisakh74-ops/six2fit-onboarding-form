import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "../errors";
import { dcOfApiDomain, type Dc } from "../zoho-dc";

type Token = { value: string; expiresAt: number };

/** Optional shared cache so several worker processes do not each refresh (Zoho limits access-token generation per refresh token). */
export interface TokenCache {
  read(): Promise<Token | null>;
  write(token: Token): Promise<void>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type TokenProviderDeps = {
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: TokenCache;
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  timeoutMs?: number;
};

export type TokenProviderConfig = { accountsDomain: string; clientId: string; clientSecret: string; refreshToken: string; dc: Dc };

const SAFETY_MS = 5 * 60 * 1000;
const ATTEMPTS = 3;
const BACKOFF_MS = [300, 900];

/** Auth failures are DEFINITE (nothing was sent to WorkDrive); transport failures are retried and then reported as unavailable. */
const authFailed = (): StoreError => new StoreError("UNAVAILABLE", "workdrive token refresh failed", "WD_AUTH_FAILED");
const unreachable = (): StoreError => new StoreError("UNAVAILABLE", "workdrive token endpoint unreachable", "WD_TOKEN_TRANSPORT");

/**
 * WorkDrive access-token provider. Holds the access token in memory only (optionally a short-lived copy in a private
 * cache file), refreshes with the WorkDrive-specific refresh token before expiry, refreshes once at a time per process
 * and never logs or throws any credential. The accounts host is pinned by configuration (no redirect following to
 * another host: the token request goes exactly to `${accountsDomain}/oauth/v2/token`).
 */
export class WorkDriveTokenProvider {
  private token: Token | null = null;
  private refreshing: Promise<Token> | null = null;

  constructor(
    private readonly cfg: TokenProviderConfig,
    private readonly deps: TokenProviderDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  private fresh(t: Token | null): t is Token {
    return t !== null && this.now() < t.expiresAt - SAFETY_MS;
  }

  async accessToken(): Promise<string> {
    if (this.fresh(this.token)) return this.token.value;
    return (await this.refresh()).value;
  }

  /** Called after a 401: drops the token (and the shared copy is overwritten by the next refresh). */
  invalidate(value?: string): void {
    if (value === undefined || this.token?.value === value) this.token = null;
  }

  private refresh(): Promise<Token> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // Another worker may have refreshed already.
        const shared = await this.deps.cache?.read().catch(() => null);
        if (shared && this.fresh(shared)) {
          this.token = shared;
          return shared;
        }
        let lastTransport = false;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
          lastTransport = false;
          const outcome = await this.requestOnce();
          if (outcome.kind === "ok") {
            this.token = outcome.token;
            await this.deps.cache?.write(outcome.token).catch(() => undefined);
            return outcome.token;
          }
          if (outcome.kind === "auth") throw authFailed();
          lastTransport = true;
          this.deps.log?.("workdrive.token_retry", { attempt });
          if (attempt < ATTEMPTS) await (this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(BACKOFF_MS[attempt - 1] ?? 900);
        }
        throw lastTransport ? unreachable() : authFailed();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async requestOnce(): Promise<{ kind: "ok"; token: Token } | { kind: "auth" } | { kind: "transport" }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.deps.timeoutMs ?? 10_000);
    try {
      const res = await this.deps.fetch(`${this.cfg.accountsDomain}/oauth/v2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken }).toString(),
        signal: ctl.signal,
      });
      if (res.status === 429 || res.status >= 500) return { kind: "transport" };
      let j: { access_token?: unknown; api_domain?: unknown; expires_in?: unknown; error?: unknown } | null;
      try {
        j = JSON.parse(await res.text()) as typeof j;
      } catch {
        return { kind: "transport" };
      }
      // Zoho reports a bad grant as HTTP 200 with {"error": "..."} as well as 400/401.
      if (res.status !== 200 || !j || typeof j !== "object" || j.error !== undefined || typeof j.access_token !== "string" || j.access_token === "") return { kind: "auth" };
      // The token must belong to the pinned data centre: a mismatch means the grant (or the configuration) is wrong.
      if (typeof j.api_domain !== "string" || dcOfApiDomain(j.api_domain) !== this.cfg.dc) throw new StoreError("NOT_CONFIGURED", "workdrive token belongs to another data centre", "DC_MISMATCH");
      const lifetime = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
      return { kind: "ok", token: { value: j.access_token, expiresAt: this.now() + lifetime * 1000 } };
    } catch (e) {
      if (e instanceof StoreError) throw e;
      return { kind: "transport" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Private file cache: one small file per grant (named by a hash, never by the credential), atomic replace, best effort. */
export class FileTokenCache implements TokenCache {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    grantId: string,
  ) {
    this.file = join(dir, `wd-token-${createHash("sha256").update(grantId).digest("hex").slice(0, 16)}.json`);
  }

  async read(): Promise<Token | null> {
    try {
      const j = JSON.parse(await readFile(this.file, "utf8")) as Partial<Token>;
      return typeof j.value === "string" && j.value !== "" && typeof j.expiresAt === "number" ? { value: j.value, expiresAt: j.expiresAt } : null;
    } catch {
      return null;
    }
  }

  async write(token: Token): Promise<void> {
    const temp = join(this.dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(token), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, this.file);
    } catch {
      await unlink(temp).catch(() => undefined);
    }
  }
}
