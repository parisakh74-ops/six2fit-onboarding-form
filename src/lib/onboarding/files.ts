/**
 * The form keeps only metadata (name, size, type) of a chosen file in its answers so the answers stay JSON-serialisable
 * (autosave). The real `File` is remembered here, keyed by that metadata object, and is NOT persisted: after a reload the
 * metadata is restored without bytes and the person must choose the file again. Without this the browser never sent the
 * photos (it sent the text "[object Object]").
 */
const FILES = new WeakMap<object, File>();

export function rememberFile(meta: object, file: File): void {
  FILES.set(meta, file);
}

export function fileOf(value: unknown): File | undefined {
  return value !== null && typeof value === "object" ? FILES.get(value as object) : undefined;
}

/** A restored/serialised file metadata object (has a name and size) without the bytes. */
export const isFileMeta = (value: unknown): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string" && typeof (value as { size?: unknown }).size === "number";
