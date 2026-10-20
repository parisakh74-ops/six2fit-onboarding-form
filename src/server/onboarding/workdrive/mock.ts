import { WdHttpError, type WdItem, type WorkDriveApi } from "./api";

type Op = "getItem" | "list" | "createFolder" | "upload" | "download";
type Rule = { op: Op; /** 1-based call number of that operation (counted since construction) */ nth: number; status: number; /** true = the operation is applied, then the answer is lost / errors */ applied: boolean };

/** In-memory WorkDrive for tests: mimics the live behaviour observed on 2026-10-17 (same-name upload creates a second, timestamp-named item). */
export class MockWorkDrive implements WorkDriveApi {
  private seq = 0;
  private readonly items = new Map<string, WdItem & { bytes?: Uint8Array }>();
  private readonly rules: Rule[] = [];
  readonly calls: Record<Op, number> = { getItem: 0, list: 0, createFolder: 0, upload: 0, download: 0 };
  /** Every parent id any write was attempted under (to prove nothing leaves the approved root). */
  readonly writeParents: string[] = [];
  /** Names of every upload attempt, in order (failed attempts included). */
  readonly uploadLog: string[] = [];
  /** `unauthenticated` = every call answers 401; `readOnly` = writes answer 403. */
  mode: "ok" | "unauthenticated" | "readOnly" = "ok";

  constructor(readonly rootId = "root_test_folder_0001", rootName = "S2F-ONBOARDING-TEST") {
    this.items.set(rootId, { id: rootId, name: rootName, parent_id: "workspace", kind: "folder", size: 0 });
  }

  inject(rule: Rule): void {
    this.rules.push(rule);
  }

  /** Test helpers: plant items directly (e.g. a pre-existing duplicate). */
  plant(parentId: string, name: string, kind: "folder" | "file", bytes: Uint8Array = new Uint8Array(0)): WdItem {
    // 37 characters like real WorkDrive resource ids (the CRM reference validator requires 20-64 alphanumerics)
    const item = { id: `wd${(this.seq += 1).toString().padStart(35, "0")}`, name, parent_id: parentId, kind, size: bytes.length, bytes };
    this.items.set(item.id, item);
    return this.view(item);
  }

  /** Test helper: removes an item (simulates an external deletion). Not part of the WorkDriveApi surface. */
  drop(id: string): void {
    this.items.delete(id);
  }

  /** Test helper: replaces the stored bytes of a file (simulates an external edit). */
  tamper(id: string, bytes: Uint8Array): void {
    const i = this.items.get(id);
    if (i) {
      i.bytes = bytes;
      i.size = bytes.length;
    }
  }

  all(parentId: string): WdItem[] {
    return [...this.items.values()].filter((i) => i.parent_id === parentId).map((i) => this.view(i));
  }

  private view(i: WdItem): WdItem {
    return { id: i.id, name: i.name, parent_id: i.parent_id, kind: i.kind, size: i.size };
  }

  private enter(op: Op, write: boolean): Rule | undefined {
    this.calls[op] += 1;
    if (this.mode === "unauthenticated") throw new WdHttpError(401);
    if (this.mode === "readOnly" && write) throw new WdHttpError(403);
    const rule = this.rules.find((r) => r.op === op && r.nth === this.calls[op]);
    if (rule && !rule.applied) throw new WdHttpError(rule.status);
    return rule;
  }

  async getItem(id: string): Promise<WdItem> {
    this.enter("getItem", false);
    const i = this.items.get(id);
    if (!i) throw new WdHttpError(404);
    return this.view(i);
  }

  async list(parentId: string): Promise<WdItem[]> {
    this.enter("list", false);
    const p = this.items.get(parentId);
    if (!p || p.kind !== "folder") throw new WdHttpError(404);
    return this.all(parentId);
  }

  async createFolder(parentId: string, name: string): Promise<WdItem> {
    this.writeParents.push(parentId);
    const rule = this.enter("createFolder", true);
    const p = this.items.get(parentId);
    if (!p || p.kind !== "folder") throw new WdHttpError(404);
    const item = this.plant(parentId, name, "folder");
    if (rule) throw new WdHttpError(rule.status);
    return item;
  }

  async upload(parentId: string, name: string, bytes: Uint8Array): Promise<WdItem> {
    this.writeParents.push(parentId);
    this.uploadLog.push(name);
    const rule = this.enter("upload", true);
    const p = this.items.get(parentId);
    if (!p || p.kind !== "folder") throw new WdHttpError(404);
    const taken = this.all(parentId).some((i) => i.name === name);
    let stored = name;
    if (taken) {
      const dot = name.lastIndexOf(".");
      const stamp = `17-10-2026 00:54:${String(10 + this.seq).padStart(2, "0")}:912`;
      stored = dot > 0 ? `${name.slice(0, dot)} ${stamp}${name.slice(dot)}` : `${name} ${stamp}`;
    }
    const item = this.plant(parentId, stored, "file", new Uint8Array(bytes));
    if (rule) throw new WdHttpError(rule.status);
    return item;
  }

  async download(id: string): Promise<Uint8Array> {
    this.enter("download", false);
    const i = this.items.get(id);
    if (!i || i.kind !== "file" || !i.bytes) throw new WdHttpError(404);
    return new Uint8Array(i.bytes);
  }
}
