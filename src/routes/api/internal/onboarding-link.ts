import { createFileRoute } from "@tanstack/react-router";
import { handleIssueLinkFromEnv } from "@/server/onboarding/links/runtime";

export const Route = createFileRoute("/api/internal/onboarding-link")({
  server: {
    handlers: {
      POST: ({ request }) => handleOnboardingLinkIssue(request),
    },
  },
});

/** Stable entry point used by `src/server.ts`. Answers 503 until the read-only CRM reader and link registry are configured. */
export function handleOnboardingLinkIssue(request: Request) {
  return handleIssueLinkFromEnv(request);
}
