import { KEY_PROPERTY, NotionHttpError, type NotionApi, type NotionFileUpload, type NotionPage } from "./api";

export type HttpNotionOptions = {
  fetch: typeof fetch;
  token: string;
  baseUrl: string;
  version: string;
  timeoutMs: number;
  maxAttempts: number;
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

type Options = { json?: unknown; form?: FormData; /** The request is safe to repeat after a lost answer. */ idempotent: boolean };

/**
 * Notion REST client. Behaviour:
 *  - requests are spaced (default 350 ms, the documented average is 3 per second); a 429 waits for `Retry-After` and repeats
 *    (a 429 was not applied, so repeating is always safe);
 *  - a lost answer (timeout / network / 5xx) is repeated only for operations that are safe to repeat; `createPage` is NOT: the
 *    caller looks the page up by `S2F Key` instead, so a lost answer can never create a second page;
 *  - the token is only ever placed in the Authorization header; errors carry the HTTP status and Notion's error `code`, never the
 *    response message (which may echo submitted data) and never the request.
 */
export class HttpNotionApi implements NotionApi {
  private lastAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: HttpNotionOptions) {
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Serialises the spacing decision so concurrent callers share the rate budget. */
  private async pace(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.lastAt + this.o.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();
    });
    this.queue = turn.catch(() => undefined);
    await turn;
  }

  private async request(method: string, path: string, opts: Options): Promise<unknown> {
    let lastError: NotionHttpError | undefined;
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      await this.pace();
      try {
        return await this.once(method, path, opts);
      } catch (e) {
        if (!(e instanceof NotionHttpError)) throw e;
        lastError = e;
        if (e.rateLimited) {
          this.o.log?.("notion.rate_limited", { attempt });
          if (attempt < this.o.maxAttempts) await this.sleep(e.retryAfterMs ?? 1_000);
          continue;
        }
        if (e.ambiguous && opts.idempotent && attempt < this.o.maxAttempts) {
          this.o.log?.("notion.retry", { attempt, status: e.status });
          await this.sleep(Math.min(250 * 2 ** (attempt - 1), 4_000));
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new NotionHttpError(0, "no_attempt");
  }

  private async once(method: string, path: string, opts: Options): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          "Notion-Version": this.o.version,
          ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : null),
      });
    } catch {
      throw new NotionHttpError(0, "network");
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok) throw new NotionHttpError(0, "unreadable_body");
    }
    if (!res.ok) {
      const code = typeof (body as { code?: unknown } | null)?.code === "string" ? ((body as { code: string }).code) : "error";
      const ra = Number(res.headers.get("retry-after"));
      throw new NotionHttpError(res.status, code, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : undefined);
    }
    return body;
  }

  async queryByKey(databaseId: string, key: string): Promise<NotionPage[]> {
    const r = (await this.request("POST", `/v1/databases/${databaseId}/query`, {
      json: { filter: { property: KEY_PROPERTY, rich_text: { equals: key } }, page_size: 3 },
      idempotent: true,
    })) as { results?: NotionPage[] };
    return (r.results ?? []).filter((p) => !p.archived);
  }

  async createPage(databaseId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return (await this.request("POST", "/v1/pages", { json: { parent: { database_id: databaseId }, properties }, idempotent: false })) as NotionPage;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return (await this.request("PATCH", `/v1/pages/${pageId}`, { json: { properties }, idempotent: true })) as NotionPage;
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return (await this.request("GET", `/v1/pages/${pageId}`, { idempotent: true })) as NotionPage;
  }

  async createFileUpload(filename: string, contentType: string): Promise<NotionFileUpload> {
    // An upload that is created twice only leaves an unattached object that Notion expires; repeating is harmless.
    const r = (await this.request("POST", "/v1/file_uploads", { json: { mode: "single_part", filename, content_type: contentType }, idempotent: true })) as NotionFileUpload;
    return { id: r.id, status: r.status };
  }

  async sendFileUpload(id: string, filename: string, contentType: string, bytes: Uint8Array): Promise<NotionFileUpload> {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: contentType }), filename);
    const r = (await this.request("POST", `/v1/file_uploads/${id}/send`, { form, idempotent: true })) as NotionFileUpload;
    return { id: r.id, status: r.status };
  }
}
