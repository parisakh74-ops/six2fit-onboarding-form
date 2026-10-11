import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";
import { claimOnce, ensureStorage, payloadHash, persistFile, readJson, stagingConfig, verifyHandoff, writeJsonAtomic } from "@/server/staging-handoff";

type StoredSubmission = { payload_hash: string; status: "completed"; submission_id: string; created_at: string };
const ID = /^[0-9a-f-]{20,80}$/i;

function parseAnswer(value: FormDataEntryValue): unknown {
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") || value.startsWith("{")) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

export const Route = createFileRoute("/api/onboarding/submit")({
  server: {
    handlers: {
      POST: ({ request }) => handleOnboardingSubmission(request),
    },
  },
});

export async function handleOnboardingSubmission(request: Request) {
        try {
          if (!new URL(request.url).hostname.toLowerCase().includes("onboarding-staging")) return Response.json({ message: "Staging only" }, { status: 403 });
          const form = await request.formData();
          const token = String(form.get("form_session_token") ?? "");
          const submissionId = String(form.get("submission_id") ?? "");
          if (!ID.test(submissionId) || request.headers.get("idempotency-key") !== submissionId) return Response.json({ message: "Invalid submission" }, { status: 400 });
          const config = stagingConfig();
          const claims = verifyHandoff(token, config.secret);
          await ensureStorage(config.storageDir);
          if (!await readJson(join(config.storageDir, "consult", `${claims.consult_submission_id}.json`))) return Response.json({ message: "Session not found" }, { status: 404 });

          const answers: Record<string, unknown> = {};
          const files: Array<{ key: string; file: File }> = [];
          for (const [key, value] of form.entries()) {
            if (key.startsWith("answer:")) answers[key.slice(7)] = parseAnswer(value);
            if (key.startsWith("file:") && value instanceof File && value.size > 0) files.push({ key: key.slice(5), file: value });
          }
          const verificationStateRaw = String(form.get("verification_state") ?? "{}");
          let verificationState: Record<string, string>;
          try {
            verificationState = JSON.parse(verificationStateRaw) as Record<string, string>;
          } catch {
            return Response.json({ message: "Invalid verification state" }, { status: 400 });
          }
          const canonical = { consult_submission_id: claims.consult_submission_id, scope: claims.scope, answers, verification_state: verificationState, files: files.map(({ key, file }) => ({ key, name: file.name, type: file.type, size: file.size })) };
          const hash = payloadHash(canonical);
          const recordPath = join(config.storageDir, "onboarding", `${submissionId}.json`);
          const existing = await readJson<StoredSubmission>(recordPath);
          if (existing) {
            if (existing.payload_hash !== hash) return Response.json({ message: "Submission conflict" }, { status: 409 });
            return Response.json({ status: "completed", submission_id: submissionId, deduplicated: true });
          }
          if (!await claimOnce(join(config.storageDir, "claims", `onboarding-${submissionId}`), { hash, created_at: new Date().toISOString() })) return Response.json({ message: "Submission in progress" }, { status: 409 });
          const uploads = [];
          for (const { key, file } of files) uploads.push(await persistFile(config.storageDir, submissionId, key, file));
          await writeJsonAtomic(recordPath, { ...canonical, uploads, payload_hash: hash, status: "completed", submission_id: submissionId, created_at: new Date().toISOString() });
          return Response.json({ status: "completed", submission_id: submissionId, deduplicated: false });
        } catch (error) {
          console.error("Onboarding staging submission failed", error instanceof Error ? error.message : "Unknown error");
          return Response.json({ message: "Staging submission unavailable" }, { status: 503 });
        }
}
