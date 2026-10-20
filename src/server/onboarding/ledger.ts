import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "./errors";
import type { CreateResult, CrmWriter, OnboardingStore, StoredRef, SubmissionExtras, SubmissionRecord } from "./ports";

/** Ledger ids are subject keys (`onb_<hex>`): safe file names, no path traversal. */
const LEDGER_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Persistent idempotency ledger + serialized writer in front of the CRM `Requests` writer.
 * VENDORED from the Consultation backend (`src/server/consult/crm/ledger.ts`, branch work/consult-crm-store), made generic:
 * the ledger id is the onboarding SUBJECT key (one onboarding per signed link), the CRM key is `uniqueformkey`.
 * Keep both copies in step until a shared package exists (see the change plan).
 *
 * Why: Zoho's unique-field check is not atomic across concurrent inserts (observed: two simultaneous
 * identical creates both succeeded) and search lags ~20 s behind a create, so neither the CRM nor a lookup can
 * arbitrate. The ledger does, on the host's local filesystem, which is shared by every worker process the hosting
 * stack may start (Passenger or otherwise) and survives restarts.
 *
 * Mechanism (no locks, no stale-lock deletion): per submission id a directory holds generation files `g1.json`,
 * `g2.json`, ... A generation is created with a temp file + hard link (`link` fails with EEXIST), so exactly one
 * process wins each generation and the file is always complete. The highest generation is the current state.
 * Only the owner of a generation rewrites it (temp file + atomic rename). Taking over is only possible by
 * creating the NEXT generation, again with exactly one winner.
 *
 * States: in_progress (a writer owns it) | created (CRM id known) | unknown (a write may have happened) |
 * needs_review (unknown, and a lookup after the quiescence window still found nothing) |
 * released (definitely nothing written) | integrity (more than one CRM record exists: never resolved silently).
 * The ledger holds no answers: ids, the payload fingerprint, the CRM record id, state and timestamps only.
 *
 * Rules:
 *  - Only a writer holding the newest generation sends a POST, and only once per attempt (no blind retry).
 *  - A search that finds nothing is NEVER proof of absence (index lag, no authoritative negative read exists).
 *    An unknown outcome is therefore never turned into a second POST automatically. It is re-examined by lookup
 *    after a quiescence window (default 120 s): a hit settles it (`created`); no hit leaves it `needs_review`
 *    (503 for the client) until a hit appears later or an operator decides (`resolveManually`, audited).
 *  - The only automatic path back to a write is proof that no POST was ever started: the writer records
 *    `phase: "sending"` in the ledger BEFORE the POST, so a dead writer still in `phase: "claimed"` never sent one.
 *  - Anything that is not a confirmed create/exists answer is an error (HTTP 503), never a success.
 */

export type LedgerState = "in_progress" | "created" | "unknown" | "needs_review" | "released" | "integrity";

export type LedgerEntry = {
  v: 1;
  id: string;
  gen: number;
  /** Canonical fingerprint of the first accepted payload (not the answers themselves). */
  fp: string;
  /** CRM unique key (`uniqueformkey`) used for lookups; never contains answers. */
  uk: string;
  state: LedgerState;
  /** in_progress only: "claimed" = no POST started yet; "sending" = a POST may be in flight; "reconciling" = lookup in progress. */
  phase?: "claimed" | "sending" | "reconciling";
  /** Set when an operator settled the entry (audit trail). */
  manual?: boolean;
  note?: string;
  crm_id?: string;
  code?: string;
  attempts: number;
  started: number;
  updated: number;
};

const STATES = new Set<LedgerState>(["in_progress", "created", "unknown", "needs_review", "released", "integrity"]);
const GEN_FILE = /^g(\d{1,9})\.json$/;
const isErrno = (e: unknown, ...codes: string[]) =>
  typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");

export class IdempotencyLedger {
  constructor(private readonly baseDir: string) {}

  private dirFor(id: string): string {
    if (!LEDGER_ID_PATTERN.test(id)) throw new StoreError("UNAVAILABLE", "invalid id", "INVALID_ID");
    return join(this.baseDir, id);
  }

  private parse(raw: string, id: string, gen: number): LedgerEntry {
    try {
      const e = JSON.parse(raw) as LedgerEntry;
      if (!e || e.v !== 1 || e.id !== id || e.gen !== gen || typeof e.fp !== "string" || typeof e.uk !== "string" || !STATES.has(e.state) || typeof e.updated !== "number") throw new Error("shape");
      return e;
    } catch {
      throw new StoreError("CORRUPT", "idempotency ledger entry is not readable", "LEDGER_CORRUPT");
    }
  }

  /** The newest generation, or null when the id was never seen. */
  async current(id: string): Promise<LedgerEntry | null> {
    const dir = this.dirFor(id);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "ledger read failed", "LEDGER_IO");
    }
    let top = 0;
    for (const n of names) {
      const m = GEN_FILE.exec(n);
      if (m) top = Math.max(top, Number(m[1]));
    }
    if (top === 0) return null;
    try {
      return this.parse(await readFile(join(dir, `g${top}.json`), "utf8"), id, top);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError("UNAVAILABLE", "ledger read failed", "LEDGER_IO");
    }
  }

  /** Atomically creates generation `entry.gen`. Returns false if another process created it first. */
  async claim(entry: LedgerEntry): Promise<boolean> {
    const dir = this.dirFor(entry.id);
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new StoreError("UNAVAILABLE", "ledger write failed", "LEDGER_IO");
    }
    try {
      await link(temp, join(dir, `g${entry.gen}.json`));
      return true;
    } catch (e) {
      if (isErrno(e, "EEXIST")) return false;
      // No hard links on this filesystem: refuse (a non-atomic fallback would defeat the purpose).
      throw new StoreError("UNAVAILABLE", "ledger claim failed", isErrno(e, "EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP") ? "LEDGER_NO_HARDLINK" : "LEDGER_IO");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Rewrites a generation this process owns (temp file + atomic rename). */
  async update(entry: LedgerEntry): Promise<void> {
    const dir = this.dirFor(entry.id);
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600, flag: "wx" });
      // POSIX rename-over is atomic and never blocked by readers; Windows can refuse while a reader has the file open.
      for (let i = 0; ; i += 1) {
        try {
          await rename(temp, join(dir, `g${entry.gen}.json`));
          break;
        } catch (e) {
          if (i >= 20 || !isErrno(e, "EPERM", "EACCES", "EBUSY")) throw e;
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new StoreError("UNAVAILABLE", "ledger write failed", "LEDGER_IO");
    }
  }
}

export type LedgerStoreOptions = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  /** An in_progress entry older than this has no live writer (crash/restart). Must exceed the worst-case CRM call time. */
  leaseMs?: number;
  /** An unknown outcome is not re-examined before this much time has passed (index lag measured ~21-24 s). */
  quiesceMs?: number;
  /** How long a request waits for another writer of the same submission before answering 503. */
  waitMs?: number;
  pollMs?: number;
};

const stub = (e: LedgerEntry, atMs: number): StoredRef => ({
  fingerprint: e.fp,
  submitted_at: new Date(atMs).toISOString(),
  ...(e.crm_id ? { record_ref: e.crm_id } : {}),
});

/** `OnboardingStore` = ledger (arbiter) + `CrmWriter` (Requests). Create-only, never overwrites. */
export class LedgerOnboardingStore implements OnboardingStore {
  private readonly lease: number;
  private readonly quiesce: number;
  private readonly wait: number;
  private readonly poll: number;

  constructor(
    private readonly inner: CrmWriter,
    private readonly ledger: IdempotencyLedger,
    private readonly opts: LedgerStoreOptions,
  ) {
    this.lease = opts.leaseMs ?? 150_000;
    this.quiesce = opts.quiesceMs ?? 120_000;
    this.wait = opts.waitMs ?? 20_000;
    this.poll = opts.pollMs ?? 250;
  }

  private log(event: string, fields: Record<string, string | number | boolean> = {}) {
    this.opts.log?.(event, fields);
  }

  async get(id: string): Promise<StoredRef | null> {
    const e = await this.ledger.current(id);
    if (!e) return null; // never seen here: create() arbitrates (CRM unique key protects non-concurrent repeats)
    if (e.state === "integrity") throw new StoreError("CORRUPT", "more than one record for a submission", "DUPLICATE_RECORDS");
    if (e.state === "created") return stub(e, e.updated);
    // in_progress / unknown / released: the service goes on to create(), which arbitrates through the ledger.
    return null;
  }

  async create(id: string, record: SubmissionRecord, extras?: SubmissionExtras): Promise<CreateResult> {
    const fp = record.fingerprint;
    const uk = record.unique_form_key;
    const now = this.opts.now;
    for (let round = 0; round < 8; round += 1) {
      const cur = await this.ledger.current(id);
      if (cur === null) {
        const mine: LedgerEntry = { v: 1, id, gen: 1, fp, uk, state: "in_progress", phase: "claimed", attempts: 1, started: now(), updated: now() };
        if (await this.ledger.claim(mine)) return this.write(mine, record, extras);
        continue; // lost the race: re-read
      }
      if (cur.state === "integrity") throw new StoreError("CORRUPT", "more than one record for a submission", "DUPLICATE_RECORDS");
      if (cur.state === "created") return { status: "exists", record: stub(cur, cur.updated) };
      if (cur.state === "released") {
        const mine: LedgerEntry = { v: 1, id, gen: cur.gen + 1, fp, uk, state: "in_progress", phase: "claimed", attempts: cur.attempts + 1, started: now(), updated: now() };
        if (await this.ledger.claim(mine)) return this.write(mine, record, extras);
        continue;
      }
      // in_progress or unknown from here on.
      if (cur.fp !== fp) {
        // Same id, different answers while the first outcome is still open: the first one wins (409 via the service).
        this.log("ledger.conflict");
        return { status: "exists", record: stub(cur, cur.updated) };
      }
      const age = now() - cur.updated;
      if (cur.state === "in_progress" && age < this.lease) {
        await this.waitForChange(id, cur.gen);
        continue;
      }
      if (cur.state === "in_progress" && cur.phase === "claimed") {
        // The writer died before it ever recorded `sending`: no POST was started, so a fresh attempt is safe.
        const mine: LedgerEntry = { v: 1, id, gen: cur.gen + 1, fp, uk, state: "in_progress", phase: "claimed", attempts: cur.attempts + 1, started: now(), updated: now() };
        if (await this.ledger.claim(mine)) {
          this.log("ledger.takeover_unsent", { attempts: mine.attempts });
          return this.write(mine, record, extras);
        }
        continue;
      }
      // unknown / needs_review, or a writer that may have sent a POST and is gone: the outcome is UNKNOWN.
      // No automatic write from here on. Only a lookup, and only after the quiescence window.
      if (age < this.quiesce) throw new StoreError("UNAVAILABLE", "outcome of an earlier attempt is still unknown", "OUTCOME_UNKNOWN");
      const mine: LedgerEntry = { v: 1, id, gen: cur.gen + 1, fp: cur.fp, uk, state: "in_progress", phase: "reconciling", attempts: cur.attempts, started: cur.started, updated: now() };
      if (!(await this.ledger.claim(mine))) continue;
      this.log("ledger.reconcile", { attempts: mine.attempts });
      return this.reconcileOnly(mine, cur);
    }
    throw new StoreError("UNAVAILABLE", "could not settle idempotency state", "LEDGER_CONTENDED");
  }

  /** Waits for the owner of generation `gen` to finish; throws IN_PROGRESS (503, safe to retry) if it does not. */
  private async waitForChange(id: string, gen: number): Promise<void> {
    const t0 = this.opts.now();
    for (;;) {
      await this.opts.sleep(this.poll);
      const e = await this.ledger.current(id);
      if (!e || e.gen !== gen || e.state !== "in_progress") return;
      if (this.opts.now() - t0 >= this.wait) throw new StoreError("UNAVAILABLE", "another request for this submission is in progress", "IN_PROGRESS");
    }
  }

  /**
   * Lookup only. A hit is positive evidence and settles the entry. No hit is NOT evidence that the original write
   * failed, so the entry stays unresolved (`needs_review`) and the client gets a 503; it is never a fresh submission.
   */
  private async reconcileOnly(mine: LedgerEntry, previous: LedgerEntry): Promise<CreateResult> {
    const back = (state: LedgerState, extra: Partial<LedgerEntry> = {}): LedgerEntry => {
      const { phase: _phase, ...rest } = mine;
      return { ...rest, state, ...extra };
    };
    const unchanged: LedgerState = previous.state === "in_progress" ? "unknown" : previous.state;
    let found: string | null;
    try {
      found = await this.inner.lookupId(mine.uk);
    } catch (e) {
      // Lookup failed: nothing learned. Hand the state back unchanged (original timestamp, original state).
      const corrupt = e instanceof StoreError && e.kind === "CORRUPT";
      await this.settle(back(corrupt ? "integrity" : unchanged, { updated: corrupt ? this.opts.now() : previous.updated, ...(e instanceof StoreError && e.code ? { code: e.code } : {}) }));
      throw e;
    }
    if (found === null) {
      this.log("ledger.needs_review", { attempts: mine.attempts });
      await this.settle(back("needs_review", { updated: this.opts.now(), code: "UNRESOLVED_OUTCOME" }));
      throw new StoreError("UNAVAILABLE", "outcome of an earlier attempt could not be confirmed", "UNRESOLVED_OUTCOME");
    }
    try {
      const view = await this.inner.readRecord(found, mine.uk);
      await this.settle(back("created", { fp: view.fingerprint, crm_id: found, updated: this.opts.now() }));
      return { status: "exists", record: view };
    } catch (e) {
      const corrupt = e instanceof StoreError && e.kind === "CORRUPT";
      await this.settle(back(corrupt ? "integrity" : unchanged, { updated: corrupt ? this.opts.now() : previous.updated, crm_id: found }));
      throw e;
    }
  }

  /** The single place where a POST can happen: the caller owns the newest generation. */
  private async write(mine: LedgerEntry, record: SubmissionRecord, extras?: SubmissionExtras): Promise<CreateResult> {
    let result: CreateResult;
    try {
      // Durable "a POST may start now" marker BEFORE the request: if this process dies from here on, the outcome is unknown.
      await this.ledger.update({ ...mine, phase: "sending", updated: this.opts.now() });
    } catch (e) {
      await this.settle({ ...mine, state: "released", updated: this.opts.now(), code: "LEDGER_IO" });
      throw e;
    }
    try {
      result = await this.inner.create(record, extras);
    } catch (e) {
      const store = e instanceof StoreError ? e : null;
      const state: LedgerState = store?.kind === "CORRUPT" ? "integrity" : store?.notWritten === true ? "released" : "unknown";
      await this.settle({ ...mine, state, updated: this.opts.now(), ...(store?.code ? { code: store.code } : {}) });
      throw e;
    }
    const id = result.record.record_ref;
    // A ledger failure after a confirmed CRM answer must not turn a true success into an error: the entry stays
    // in_progress and is reconciled (lookup first) by the next request.
    await this.settle({ ...mine, fp: result.record.fingerprint, state: "created", ...(id ? { crm_id: id } : {}), updated: this.opts.now() });
    return result;
  }

  private async settle(entry: LedgerEntry): Promise<void> {
    try {
      await this.ledger.update(entry);
    } catch {
      this.log("ledger.update_failed", { state: entry.state });
    }
  }
}

export type ManualDecision =
  | { decision: "created"; crmRecordId: string; note: string }
  /** The operator verified in the CRM, by an authoritative view and after the index lag, that no record exists, and accepts that a late commit of the first request is still possible. */
  | { decision: "released"; note: string };

/**
 * Operator action for an entry that automation must not settle (`unknown`, `needs_review`, or an `in_progress`
 * entry whose writer is gone after a POST may have started). Creates the next generation (earlier generations are
 * kept as the audit trail) and never touches the CRM. Refuses entries that are settled or have a live writer.
 */
export async function resolveManually(ledger: IdempotencyLedger, id: string, d: ManualDecision, now: number, leaseMs = 150_000): Promise<LedgerEntry> {
  const cur = await ledger.current(id);
  if (!cur) throw new StoreError("REJECTED", "no ledger entry", "LEDGER_NOT_FOUND");
  const open = cur.state === "unknown" || cur.state === "needs_review" || (cur.state === "in_progress" && cur.phase !== "claimed" && now - cur.updated >= leaseMs);
  if (!open) throw new StoreError("REJECTED", `entry is ${cur.state}; nothing to resolve`, "LEDGER_NOT_RESOLVABLE");
  if (d.note.trim().length < 8) throw new StoreError("REJECTED", "a note describing the evidence is required", "LEDGER_NOTE_REQUIRED");
  if (d.decision === "created" && !/^\d{6,25}$/.test(d.crmRecordId)) throw new StoreError("REJECTED", "invalid CRM record id", "INVALID_RECORD_ID");
  const next: LedgerEntry = {
    v: 1,
    id,
    gen: cur.gen + 1,
    fp: cur.fp,
    uk: cur.uk,
    state: d.decision,
    attempts: cur.attempts,
    started: cur.started,
    updated: now,
    manual: true,
    note: d.note.slice(0, 300),
    ...(d.decision === "created" ? { crm_id: d.crmRecordId } : {}),
  };
  if (!(await ledger.claim(next))) throw new StoreError("UNAVAILABLE", "entry changed concurrently; re-read and retry", "LEDGER_CONTENDED");
  return next;
}
