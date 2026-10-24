/** Minimal Notion surface the sync needs. Implemented by `HttpNotionApi` (live) and `MockNotion` (tests). */
export type NotionPage = { id: string; properties: Record<string, unknown>; archived?: boolean };
export type NotionFileUpload = { id: string; status: "pending" | "uploaded" | "expired" | "failed" };

export const KEY_PROPERTY = "S2F Key";

export interface NotionApi {
  /** Pages whose `S2F Key` equals the key (at most a few are returned; more than one is an integrity state). */
  queryByKey(databaseId: string, key: string): Promise<NotionPage[]>;
  createPage(databaseId: string, properties: Record<string, unknown>): Promise<NotionPage>;
  updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage>;
  getPage(pageId: string): Promise<NotionPage>;
  createFileUpload(filename: string, contentType: string): Promise<NotionFileUpload>;
  sendFileUpload(id: string, filename: string, contentType: string, bytes: Uint8Array): Promise<NotionFileUpload>;
}

/**
 * `status` 0 = no answer (timeout / network): the request MAY have been applied.
 * `retryAfterMs` is set for 429. `code` is Notion's error code (never a message that could echo user data).
 */
export class NotionHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`notion http ${status} ${code}`);
    this.name = "NotionHttpError";
  }

  get ambiguous(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}
