import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";
import { ensureStorage, readJson, stagingConfig, verifyHandoff } from "@/server/staging-handoff";

type StoredConsult = { payload?: { onboarding_prefill?: Record<string, unknown> } };

export const Route = createFileRoute("/api/onboarding/bootstrap")({
  server: {
    handlers: {
      GET: ({ request }) => handleOnboardingBootstrap(request),
    },
  },
});

export async function handleOnboardingBootstrap(request: Request) {
        try {
          if (!new URL(request.url).hostname.toLowerCase().includes("onboarding-staging")) return Response.json({ message: "Staging only" }, { status: 403 });
          const token = new URL(request.url).searchParams.get("session") ?? "";
          const config = stagingConfig();
          const claims = verifyHandoff(token, config.secret);
          await ensureStorage(config.storageDir);
          const consult = await readJson<StoredConsult>(join(config.storageDir, "consult", `${claims.consult_submission_id}.json`));
          if (!consult?.payload) return Response.json({ message: "Session not found" }, { status: 404 });
          return Response.json({
            form_session_token: token,
            scope: claims.scope,
            entitlements: claims.entitlements,
            prefill: consult.payload.onboarding_prefill ?? {},
            expires_at: new Date(claims.exp * 1000).toISOString(),
          }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        } catch {
          return Response.json({ message: "Invalid or expired session" }, { status: 401, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        }
}
