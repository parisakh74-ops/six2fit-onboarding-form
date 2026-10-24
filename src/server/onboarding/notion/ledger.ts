import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable Notion sync ledger: one small JSON file per submission (`uniqueformkey`) under a private directory.
 * It never holds answers, names, file names or file bytes: only the submission key, the Notion ids, content hashes, states and
 * counters, so it may live next to the existing onboarding ledger.
 *
 *   pending   created, the Notion page does not exist yet (or is not confirmed)
 *   partial   the page exists; properties and/or some files are still missing
 *   complete  page, properties and every file are attached and recorded
 *   blocked   an integrity state (e.g. more than one page for the key); never retried automatically
 *
 * Concurrency: a per-key lock directory (`mkdir` is atomic) with a lease; a lock older than the lease belongs to a dead worker
 * and is taken over. Writes are atomic (temp file + rename).
 */
export type FileState = { sha256: string; uploadId?: string; uploadedAt?: number; sent?: boolean; attached: boolean };
export type SyncState = "pending" | "partial" | "complete" | "blocked";
export type SyncEntry = {
  v: 1;
  key: string;
  state: SyncState;
  fingerprint: string;
  pageId?: string;
  /** A `createPage` whose answer was lost: no second page is created until this has aged (the first may still appear). */
  createAmbiguousAt?: number;
  propertiesWritten: boolean;
  /** `WorkDrive Link` is set once it is known (it is part of the first property write only when available then). */
  linkWritten?: boolean;
  /** Product.Fitness read from the CRM (null = the product has none); resolved once, before the page is created. */
  fitnessResolved?: boolean;
  fitness?: string | null;
  files: Record<string, FileState>;
  attempts: number;
  lastErrorCode?: string;
  nextAttemptAt?: number;
  createdAt: number;
  updatedAt: number;
};

const KEY = /^onb2_[A-Za-z0-9_-]{8,200}$/;

export class NotionSyncLedger {
  constructor(
    private readonly dir: string,
    private readonly leaseMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error("NOTION_LEDGER_KEY_INVALID");
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<SyncEntry | null> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as SyncEntry;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  /**
   * Durably records "this submission still has to reach Notion" (create-only, atomic: an existing entry is never touched).
   * Called BEFORE the HTTP success is returned, so a crash or a dead worker afterwards cannot lose the sync.
   */
  async register(key: string, fingerprint: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const t = this.now();
    const entry: SyncEntry = { v: 1, key, state: "pending", fingerprint, propertiesWritten: false, files: {}, attempts: 0, createdAt: t, updatedAt: t };
    try {
      await writeFile(this.path(key), JSON.stringify(entry), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }

  async write(entry: SyncEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.path(entry.key);
    const tmp = `${target}.${process.pid}.${this.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...entry, updatedAt: this.now() }), { mode: 0o600 });
    await rename(tmp, target);
  }

  /** Keys that are not complete or blocked, due for a retry. */
  async due(limit = 50): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
      const e = await this.read(n.slice(0, -5)).catch(() => null);
      if (e && (e.state === "pending" || e.state === "partial") && (e.nextAttemptAt ?? 0) <= this.now()) out.push(e.key);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Runs `fn` while holding the key's lock; `null` when another live worker holds it. */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = `${this.path(key)}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = this.now() - (await stat(lock).then((s) => s.mtimeMs).catch(() => this.now()));
        if (attempt === 0 && age > this.leaseMs) {
          await rmdir(lock).catch(() => undefined); // the owner is gone; the next mkdir arbitrates between takers
          continue;
        }
        return { ran: false };
      }
    }
    try {
      return { ran: true, value: await fn() };
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }
}
