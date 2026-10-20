import { WdHttpError, type WdItem, type WorkDriveApi } from "./api";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

export type HttpWorkDriveDeps = {
  fetch: FetchLike;
  /** Returns a short-lived access token. Supplied by the credential layer; never logged, never stored here. */
  accessToken: () => Promise<string>;
  /** API base, e.g. the US data-center WorkDrive API root. Pinned by configuration. */
  baseUrl: string;
  timeoutMs?: number;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Live WorkDrive client (verified shapes from the 2026-10-17 manual test: list/get/create-folder/upload/download on the
 * API host). NOT exercised against the live service by the test suite; response parsing is covered with fixtures only.
 * Transport failures, timeouts and unreadable bodies are `WdHttpError(0)` (the request may have been applied).
 */
export class HttpWorkDriveApi implements WorkDriveApi {
  constructor(private readonly deps: HttpWorkDriveDeps) {}

  private async send(method: string, path: string, opts: { body?: unknown; json?: boolean; headers?: Record<string, string> } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.deps.timeoutMs ?? 20_000);
    try {
      const token = await this.deps.accessToken();
      const res = await this.deps.fetch(`${this.deps.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/vnd.api+json", ...(opts.headers ?? {}) },
        body: opts.body,
        signal: ctl.signal,
      });
      if (res.status < 200 || res.status >= 300) throw new WdHttpError(res.status);
      return res;
    } catch (e) {
      if (e instanceof WdHttpError) throw e;
      throw new WdHttpError(0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async body(res: Awaited<ReturnType<HttpWorkDriveApi["send"]>>): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new WdHttpError(0);
    }
  }

  private item(raw: unknown): WdItem {
    if (!isObj(raw) || typeof raw["id"] !== "string" || !isObj(raw["attributes"])) throw new WdHttpError(0);
    const a = raw["attributes"];
    const type = String(a["type"] ?? "");
    const info = isObj(a["storage_info"]) ? a["storage_info"] : {};
    // `size` is a display string ("1008 bytes", "2.00 KB": rounded, not usable for integrity); only `size_in_bytes` is exact (verified live 2026-10-17).
    const exact = info["size_in_bytes"];
    const kind = type === "folder" || type === "workspace" || a["is_folder"] === true ? "folder" : "file";
    if (kind === "file" && !(typeof exact === "number" && Number.isInteger(exact) && exact >= 0)) throw new WdHttpError(0);
    return {
      id: raw["id"],
      name: String(a["name"] ?? ""),
      parent_id: String(a["parent_id"] ?? ""),
      kind,
      size: typeof exact === "number" ? exact : 0,
    };
  }

  async getItem(id: string): Promise<WdItem> {
    const j = await this.body(await this.send("GET", `/files/${encodeURIComponent(id)}`));
    return this.item(isObj(j) ? j["data"] : null);
  }

  async list(parentId: string): Promise<WdItem[]> {
    const out: WdItem[] = [];
    const page = 50;
    for (let offset = 0; offset < 5000; offset += page) {
      const j = await this.body(await this.send("GET", `/files/${encodeURIComponent(parentId)}/files?page%5Blimit%5D=${page}&page%5Boffset%5D=${offset}`));
      const data = isObj(j) && Array.isArray(j["data"]) ? j["data"] : null;
      if (!data) throw new WdHttpError(0);
      out.push(...data.map((d) => this.item(d)));
      if (data.length < page) return out;
    }
    throw new WdHttpError(0);
  }

  async createFolder(parentId: string, name: string): Promise<WdItem> {
    const j = await this.body(
      await this.send("POST", "/files", { headers: { "Content-Type": "application/vnd.api+json" }, body: JSON.stringify({ data: { attributes: { name, parent_id: parentId }, type: "files" } }) }),
    );
    return this.item(isObj(j) ? j["data"] : null);
  }

  async upload(parentId: string, name: string, bytes: Uint8Array): Promise<WdItem> {
    const form = new FormData();
    form.append("parent_id", parentId);
    form.append("override-name-exist", "false");
    form.append("content", new Blob([bytes as BlobPart]), name);
    const j = await this.body(await this.send("POST", "/upload", { body: form }));
    const first = isObj(j) && Array.isArray(j["data"]) ? j["data"][0] : null;
    const rid = isObj(first) && isObj(first["attributes"]) ? first["attributes"]["resource_id"] : null;
    if (typeof rid !== "string") throw new WdHttpError(0);
    // The upload is committed at this point: a failing read-back (e.g. not visible yet) is an AMBIGUOUS outcome, never a plain refusal.
    return this.getItem(rid).catch((e: unknown) => {
      throw e instanceof WdHttpError && e.status !== 401 && e.status !== 403 ? new WdHttpError(0) : e;
    });
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.send("GET", `/download/${encodeURIComponent(id)}`);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new WdHttpError(0);
    }
  }
}
