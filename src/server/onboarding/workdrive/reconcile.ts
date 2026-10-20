import { StoreError } from "../errors";
import type { CrmWriter } from "../ports";
import type { WorkDriveSubmissionStorage } from "./storage";

/**
 * Read-only reconciliation of CRM Requests against WorkDrive submissions, joined by `uniqueformkey`.
 * It never writes, repairs, moves or deletes anything: every finding is a report line for a human decision.
 *
 *   matched                 CRM key listed, exactly one WorkDrive folder, exactly one canonical document, content verified
 *   crm_without_folder      CRM key listed, no WorkDrive folder (could also be a lagging listing: re-check before acting)
 *   crm_without_document    folder exists, no canonical document
 *   ambiguous_folder        more than one folder with the key (never resolved by picking one)
 *   ambiguous_document      more than one canonical document candidate
 *   integrity_failure       document unreadable, edited, or outside the approved folder
 *   workdrive_unavailable   WorkDrive could not be read for this key (retry later; says nothing about the submission)
 *   invalid_key             the listed CRM key is malformed
 *   orphan_workdrive        WorkDrive folder whose key the CRM lookup did not find. NOT proof of absence: the CRM search
 *                           index lags by ~20 s, and an empty search is never evidence, so confirm after the quiescence window
 *   crm_found_unlisted      WorkDrive folder not in the supplied key list, but the CRM lookup found its Request
 *   crm_lookup_failed       the CRM lookup itself failed for this WorkDrive folder
 *
 * The report carries keys, statuses and codes only: never answers, file contents, names, links or credentials.
 */
export type ReconcileStatus =
  | "matched"
  | "crm_without_folder"
  | "crm_without_document"
  | "ambiguous_folder"
  | "ambiguous_document"
  | "integrity_failure"
  | "workdrive_unavailable"
  | "invalid_key"
  | "orphan_workdrive"
  | "crm_found_unlisted"
  | "crm_lookup_failed";

export type ReconcileEntry = { key: string; status: ReconcileStatus; code?: string };
export type ReconcileReport = {
  entries: ReconcileEntry[];
  counts: Record<ReconcileStatus, number>;
  totals: { crm_keys: number; workdrive_folders: number };
};

const STATUSES: ReconcileStatus[] = ["matched", "crm_without_folder", "crm_without_document", "ambiguous_folder", "ambiguous_document", "integrity_failure", "workdrive_unavailable", "invalid_key", "orphan_workdrive", "crm_found_unlisted", "crm_lookup_failed"];

function classify(e: unknown): { status: ReconcileStatus; code?: string } {
  const code = e instanceof StoreError ? e.code : undefined;
  const withCode = (status: ReconcileStatus) => ({ status, ...(code ? { code } : {}) });
  switch (code) {
    case "WD_FOLDER_NOT_FOUND": return withCode("crm_without_folder");
    case "WD_DOCUMENT_MISSING": return withCode("crm_without_document");
    case "WD_AMBIGUOUS_FOLDER": return withCode("ambiguous_folder");
    case "WD_AMBIGUOUS_FILES": return withCode("ambiguous_document");
    case "WD_DOCUMENT_TAMPERED":
    case "WD_DOCUMENT_UNREADABLE":
    case "WD_INVALID_PARENT":
    case "WD_DOCUMENT_REF_INVALID": return withCode("integrity_failure");
    case "WD_INVALID_KEY": return withCode("invalid_key");
    default: return withCode("workdrive_unavailable");
  }
}

export type ReconcileDeps = {
  storage: WorkDriveSubmissionStorage;
  /** Only `lookupId` is used (positive hits are proof; an empty result proves nothing). */
  crm: Pick<CrmWriter, "lookupId">;
  /** `uniqueformkey` of the CRM Requests to check (e.g. from a CRM report); the CRM writer has no listing. */
  crmKeys: readonly string[];
};

/** Throws only when the WorkDrive root cannot be verified or listed at all; every per-key problem becomes a report entry. */
export async function reconcileSubmissions(deps: ReconcileDeps): Promise<ReconcileReport> {
  const folders = await deps.storage.listSubmissionFolders();
  const crmKeys = [...new Set(deps.crmKeys)];
  const entries: ReconcileEntry[] = [];

  for (const key of crmKeys) {
    try {
      await deps.storage.readDocumentIdentityByKey(key, { folders });
      entries.push({ key, status: "matched" });
    } catch (e) {
      entries.push({ key, ...classify(e) });
    }
  }

  const listed = new Set(crmKeys);
  const wdOnly = [...new Set(folders.map((f) => f.key))].filter((k) => !listed.has(k));
  for (const key of wdOnly) {
    if (folders.filter((f) => f.key === key).length > 1) {
      entries.push({ key, status: "ambiguous_folder", code: "WD_AMBIGUOUS_FOLDER" });
      continue;
    }
    try {
      const hit = await deps.crm.lookupId(key);
      entries.push({ key, status: hit === null ? "orphan_workdrive" : "crm_found_unlisted" });
    } catch (e) {
      entries.push({ key, status: "crm_lookup_failed", ...(e instanceof StoreError && e.code ? { code: e.code } : {}) });
    }
  }

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ReconcileStatus, number>;
  for (const e of entries) counts[e.status] += 1;
  return { entries, counts, totals: { crm_keys: crmKeys.length, workdrive_folders: folders.length } };
}
