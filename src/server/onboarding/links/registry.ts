import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "../errors";
import { KNOWN_ENTITLEMENTS } from "../tokens";
import type { IssuedLinkRecord, IssuedLinkStore } from "./types";

const DEAL_ID = /^\d{6,25}$/;
const GEN_FILE = /^g(\d{1,9})\.json$/;
const SCOPES = new Set(["Diet", "Training", "Combo", "CIP"]);
const isErrno = (e: unknown, ...codes: string[]) => typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");

/**
 * DURABLE registry of issued Onboarding links (P2-03): per Deal an append-only sequence of generation files
 * `g1.json`, `g2.json`, ... Each generation is created with temp file + hard link, so exactly one process wins each
 * generation and a file is always complete (same primitive as the idempotency ledger and the payment FactStore).
 * `tryRecord` is compare-and-set on the newest link id: two simultaneous issuances cannot both succeed, also across
 * worker processes and restarts. Nothing is ever rewritten or deleted (the sequence is the audit history).
 *
 * A record holds ids, claims and timestamps only: NO token, name, e-mail or phone. The token is re-derived from the
 * claims by the issuer (deterministic signing), so a lost token is never needed.
 * Needs a local filesystem with hard links; without it the store refuses (it never falls back to a non-atomic write).
 */
export class FileIssuedLinkStore implements IssuedLinkStore {
  constructor(private readonly baseDir: string) {}

  private dir(dealId: string): string {
    if (!DEAL_ID.test(dealId)) throw new StoreError("UNAVAILABLE", "invalid deal id", "INVALID_ID");
    return join(this.baseDir, `deal_${dealId}`);
  }

  private parse(raw: string, dealId: string): IssuedLinkRecord {
    try {
      const r = JSON.parse(raw) as IssuedLinkRecord;
      const ok =
        r && r.deal_id === dealId && typeof r.jti === "string" && r.jti.length >= 8 && r.jti.length <= 100 && SCOPES.has(r.scope) &&
        Array.isArray(r.entitlements) && r.entitlements.every((e) => typeof e === "string" && KNOWN_ENTITLEMENTS.has(e)) &&
        Number.isInteger(r.iat) && Number.isInteger(r.exp) && r.exp > r.iat && typeof r.product_id === "string" && DEAL_ID.test(r.product_id) && typeof r.is_first_request === "boolean";
      if (!ok) throw new Error("shape");
      return r;
    } catch {
      throw new StoreError("CORRUPT", "issued link record is not readable", "REGISTRY_CORRUPT");
    }
  }

  private async top(dealId: string): Promise<{ gen: number; record: IssuedLinkRecord } | null> {
    const dir = this.dir(dealId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "registry read failed", "REGISTRY_IO");
    }
    let gen = 0;
    for (const n of names) {
      const m = GEN_FILE.exec(n);
      if (m) gen = Math.max(gen, Number(m[1]));
    }
    if (gen === 0) return null;
    try {
      return { gen, record: this.parse(await readFile(join(dir, `g${gen}.json`), "utf8"), dealId) };
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError("UNAVAILABLE", "registry read failed", "REGISTRY_IO");
    }
  }

  async latestFor(dealId: string): Promise<IssuedLinkRecord | null> {
    return (await this.top(dealId))?.record ?? null;
  }

  /** Newest-first history of a Deal (audit; revoked or expired links stay visible). */
  async history(dealId: string): Promise<IssuedLinkRecord[]> {
    const dir = this.dir(dealId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isErrno(e, "ENOENT")) return [];
      throw new StoreError("UNAVAILABLE", "registry read failed", "REGISTRY_IO");
    }
    const gens = names.map((n) => GEN_FILE.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => b - a);
    const out: IssuedLinkRecord[] = [];
    for (const g of gens) out.push(this.parse(await readFile(join(dir, `g${g}.json`), "utf8"), dealId));
    return out;
  }

  async tryRecord(record: IssuedLinkRecord, expectedLatestJti: string | null): Promise<boolean> {
    const dir = this.dir(record.deal_id);
    this.parse(JSON.stringify(record), record.deal_id); // refuse a malformed record before touching the disk
    const current = await this.top(record.deal_id);
    if ((current?.record.jti ?? null) !== expectedLatestJti) return false;
    const gen = (current?.gen ?? 0) + 1;
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new StoreError("UNAVAILABLE", "registry write failed", "REGISTRY_IO");
    }
    try {
      await link(temp, join(dir, `g${gen}.json`));
      return true;
    } catch (e) {
      if (isErrno(e, "EEXIST")) return false; // lost the race to a concurrent issuance
      throw new StoreError("UNAVAILABLE", "registry claim failed", isErrno(e, "EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP") ? "REGISTRY_NO_HARDLINK" : "REGISTRY_IO");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
