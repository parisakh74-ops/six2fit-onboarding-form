import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Scope = "Diet" | "Training" | "Combo" | "CIP";
export type HandoffClaims = { v: 1; consult_submission_id: string; scope: Scope; entitlements: string[]; exp: number };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing staging configuration: ${name}`);
  return value;
}

export function stagingConfig() {
  if (required("SIX2FIT_STAGING_MODE") !== "true") throw new Error("Staging handoff is disabled");
  const secret = required("SIX2FIT_STAGING_TOKEN_SECRET");
  if (secret.length < 32) throw new Error("SIX2FIT_STAGING_TOKEN_SECRET must be at least 32 characters");
  return { storageDir: required("SIX2FIT_STAGING_STORAGE_DIR"), secret };
}

export function verifyHandoff(token: string, secret: string): HandoffClaims {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid handoff token");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Invalid handoff signature");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HandoffClaims;
  if (claims.v !== 1 || claims.exp <= Math.floor(Date.now() / 1000) || !claims.consult_submission_id) throw new Error("Expired or invalid handoff token");
  return claims;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function ensureStorage(storageDir: string) {
  for (const directory of ["consult", "onboarding", "claims", "uploads"]) await mkdir(join(storageDir, directory), { recursive: true });
}

export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function claimOnce(path: string, value: unknown): Promise<boolean> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

const ALLOWED_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
export async function persistFile(storageDir: string, submissionId: string, key: string, file: File) {
  if (file.size > 20 * 1024 * 1024 || !ALLOWED_FILE_TYPES.has(file.type)) throw new Error("Invalid upload");
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg";
  const filename = `${submissionId}-${randomUUID()}-${sha256.slice(0, 12)}.${extension}`;
  await writeFile(join(storageDir, "uploads", filename), bytes, { flag: "wx", mode: 0o600 });
  return { key, filename, original_name: file.name, content_type: file.type, size: file.size, sha256 };
}
