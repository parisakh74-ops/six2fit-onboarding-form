import { sha256Hex } from "../canonical";
import { KEY_PROPERTY, NotionHttpError, type NotionApi, type NotionFileUpload, type NotionPage } from "./api";

type Op = "queryByKey" | "createPage" | "updatePage" | "getPage" | "createFileUpload" | "sendFileUpload";
export type MockFault = { op: Op; /** how many calls fail (default 1) */ times?: number; error: NotionHttpError; /** the write is applied, then the answer is lost */ applyThenFail?: boolean; /** skip this many matching calls first */ after?: number };

/** In-memory Notion: pages with a `S2F Key`, native file uploads (with status and expiry), fault injection. Test support only. */
export class MockNotion implements NotionApi {
  pages: Array<NotionPage & { properties: Record<string, any> }> = [];
  uploads = new Map<string, { filename: string; type: string; status: NotionFileUpload["status"]; sha?: string; size?: number; createdAt: number; attached: boolean }>();
  calls: Record<Op, number> = { queryByKey: 0, createPage: 0, updatePage: 0, getPage: 0, createFileUpload: 0, sendFileUpload: 0 };
  faults: MockFault[] = [];
  /** Optional hide of pages from queries (eventual consistency), per call count. */
  hideFromQueryCalls = 0;
  private seq = 0;
  constructor(private readonly now: () => number = () => Date.now(), private readonly uploadTtlMs = 60 * 60_000) {}

  private hit(op: Op): MockFault | null {
    this.calls[op] += 1;
    for (const f of this.faults) {
      if (f.op !== op) continue;
      if ((f.after ?? 0) > 0) {
        f.after = (f.after ?? 0) - 1;
        continue;
      }
      if ((f.times ?? 1) > 0) {
        f.times = (f.times ?? 1) - 1;
        return f;
      }
    }
    return null;
  }
  private fail(f: MockFault | null, apply: () => void): void {
    if (!f) return apply();
    if (f.applyThenFail) apply();
    throw f.error;
  }

  async queryByKey(_db: string, key: string): Promise<NotionPage[]> {
    this.fail(this.hit("queryByKey"), () => undefined);
    if (this.hideFromQueryCalls > 0) {
      this.hideFromQueryCalls -= 1;
      return [];
    }
    return this.pages.filter((p) => JSON.stringify(p.properties[KEY_PROPERTY]?.rich_text?.map((t: any) => t.text.content).join("")) === JSON.stringify(key)).slice(0, 3);
  }

  async createPage(_db: string, properties: Record<string, unknown>): Promise<NotionPage> {
    let page!: NotionPage & { properties: Record<string, any> };
    this.fail(this.hit("createPage"), () => {
      page = { id: `page${++this.seq}`.padEnd(32, "0"), properties: structuredClone(properties) as Record<string, any> };
      this.pages.push(page);
    });
    return page;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    const page = this.pages.find((p) => p.id === pageId);
    let out!: NotionPage;
    this.fail(this.hit("updatePage"), () => {
      if (!page) throw new NotionHttpError(404, "object_not_found");
      for (const [k, v] of Object.entries(properties)) {
        const files = (v as { files?: Array<{ name: string; type: string; file_upload: { id: string } }> }).files;
        if (files) {
          for (const f of files) {
            const u = this.uploads.get(f.file_upload.id);
            // Notion only accepts an upload that was sent (status uploaded) and has not expired.
            if (!u || u.status !== "uploaded" || this.now() - u.createdAt > this.uploadTtlMs) throw new NotionHttpError(400, "validation_error");
            u.attached = true;
          }
          page.properties[k] = { files: files.map((f) => ({ name: f.name, type: "file", file: { url: `https://files.invalid/${f.file_upload.id}` } })) };
        } else page.properties[k] = structuredClone(v);
      }
      out = page;
    });
    return out;
  }

  async getPage(pageId: string): Promise<NotionPage> {
    this.fail(this.hit("getPage"), () => undefined);
    const p = this.pages.find((x) => x.id === pageId);
    if (!p) throw new NotionHttpError(404, "object_not_found");
    return p;
  }

  async createFileUpload(filename: string, contentType: string): Promise<NotionFileUpload> {
    let id = "";
    this.fail(this.hit("createFileUpload"), () => {
      id = `upload${++this.seq}`.padEnd(32, "0");
      this.uploads.set(id, { filename, type: contentType, status: "pending", createdAt: this.now(), attached: false });
    });
    return { id, status: "pending" };
  }

  async sendFileUpload(id: string, filename: string, contentType: string, bytes: Uint8Array): Promise<NotionFileUpload> {
    const u = this.uploads.get(id);
    this.fail(this.hit("sendFileUpload"), () => {
      if (!u || u.status !== "pending") throw new NotionHttpError(400, "validation_error");
      if (filename !== u.filename || contentType !== u.type) throw new NotionHttpError(400, "validation_error");
      u.status = "uploaded";
      u.sha = sha256Hex(bytes);
      u.size = bytes.length;
    });
    return { id, status: "uploaded" };
  }

  /** Attached file entries of a page property: the names and the upload objects behind them (for assertions). */
  attached(pageId: string, property: string): Array<{ name: string; sha?: string; size?: number }> {
    const p = this.pages.find((x) => x.id === pageId);
    const files = (p?.properties[property]?.files ?? []) as Array<{ name: string; file: { url: string } }>;
    return files.map((f) => {
      const u = this.uploads.get(f.file.url.split("/").pop() as string);
      return { name: f.name, ...(u?.sha ? { sha: u.sha } : {}), ...(u?.size !== undefined ? { size: u.size } : {}) };
    });
  }
}
