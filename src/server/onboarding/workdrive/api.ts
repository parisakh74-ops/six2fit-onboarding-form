/** Minimal WorkDrive surface the adapter needs. Implemented by `HttpWorkDriveApi` (live, not yet exercised by tests) and `MockWorkDrive`. */
export type WdItem = { id: string; name: string; parent_id: string; kind: "folder" | "file"; size: number };

export interface WorkDriveApi {
  getItem(id: string): Promise<WdItem>;
  /** Direct children of a folder (all pages). */
  list(parentId: string): Promise<WdItem[]>;
  createFolder(parentId: string, name: string): Promise<WdItem>;
  /** Never overwrites: a same-name upload creates a SECOND item (observed live), so callers must check first. */
  upload(parentId: string, name: string, bytes: Uint8Array): Promise<WdItem>;
  download(id: string): Promise<Uint8Array>;
}

/**
 * `status` 0 = no answer (timeout / network / unreadable body): the request MAY have been applied.
 * Any other status is a definitive answer from WorkDrive.
 */
export class WdHttpError extends Error {
  constructor(
    public readonly status: number,
    message = `workdrive http ${status}`,
  ) {
    super(message);
    this.name = "WdHttpError";
  }

  get ambiguous(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}
