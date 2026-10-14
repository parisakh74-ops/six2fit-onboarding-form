import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../canonical";
import { PaymentError, ORDER_ID_PATTERN } from "./types";

const isErrno = (e: unknown, ...codes: string[]) => typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");
const FACT_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}$/;

/** File-safe, one-way key of an order (the order id itself never becomes a path). */
export const orderKey = (orderId: string): string => {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new PaymentError("INVALID_ORDER_ID");
  return `ord_${sha256Hex(`order:${orderId}`).slice(0, 32)}`;
};

/**
 * Append-only, race-safe fact store: a fact is a small JSON file created with temp file + hard link, so exactly one
 * concurrent writer creates it (`put` returns false for everyone else) and it is always complete. Facts are never
 * rewritten or deleted. The state of an order is the fold of its facts, so there is no lock, no lease and no lost update.
 * Same primitive as the Consultation/Onboarding idempotency ledger; needs a local filesystem with hard links (see the
 * hosting self-test). Facts hold ids, states and timestamps only: no names, e-mail, phone, address or tokens.
 */
export class FactStore {
  constructor(private readonly baseDir: string) {}

  private dir(key: string): string {
    if (!/^(ord|evt|rev)_[0-9a-f]{32}$/.test(key)) throw new PaymentError("INVALID_ORDER_ID");
    return join(this.baseDir, key);
  }

  /** Creates the fact; returns false if it already exists. */
  async put(key: string, name: string, data: Record<string, unknown>): Promise<boolean> {
    if (!FACT_NAME.test(name)) throw new PaymentError("CORRUPT", "invalid fact name");
    const dir = this.dir(key);
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new PaymentError("UNAVAILABLE", "fact store write failed");
    }
    try {
      await link(temp, join(dir, `${name}.json`));
      return true;
    } catch (e) {
      if (isErrno(e, "EEXIST")) return false;
      throw new PaymentError("UNAVAILABLE", isErrno(e, "EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP") ? "no hard-link support" : "fact store link failed");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async get<T = Record<string, unknown>>(key: string, name: string): Promise<T | null> {
    if (!FACT_NAME.test(name)) throw new PaymentError("CORRUPT", "invalid fact name");
    try {
      return JSON.parse(await readFile(join(this.dir(key), `${name}.json`), "utf8")) as T;
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      if (e instanceof PaymentError) throw e;
      throw new PaymentError(e instanceof SyntaxError ? "CORRUPT" : "UNAVAILABLE", "fact store read failed");
    }
  }

  async names(key: string): Promise<string[]> {
    try {
      return (await readdir(this.dir(key))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    } catch (e) {
      if (isErrno(e, "ENOENT")) return [];
      if (e instanceof PaymentError) throw e;
      throw new PaymentError("UNAVAILABLE", "fact store read failed");
    }
  }

  /** Order keys that have any fact (for the reconciliation sweep). */
  async orders(): Promise<string[]> {
    try {
      return (await readdir(this.baseDir)).filter((n) => /^ord_[0-9a-f]{32}$/.test(n));
    } catch (e) {
      if (isErrno(e, "ENOENT")) return [];
      throw new PaymentError("UNAVAILABLE", "fact store read failed");
    }
  }
}

/** Key of the revocation record of a link id (`jti`): checked by the Onboarding API before it serves or accepts a link. */
export const revocationKey = (jti: string): string => `rev_${sha256Hex(`jti:${jti}`).slice(0, 32)}`;
/** Key of a webhook delivery id (cheap de-duplication of retried deliveries; correctness never depends on it). */
export const eventKey = (deliveryId: string): string => `evt_${sha256Hex(`event:${deliveryId}`).slice(0, 32)}`;
