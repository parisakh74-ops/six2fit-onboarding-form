import { createFileRoute } from "@tanstack/react-router";
import { handleSubmit } from "@/server/onboarding/http";

export const Route = createFileRoute("/api/onboarding/submit")({
  server: {
    handlers: {
      POST: ({ request }) => handleOnboardingSubmission(request),
    },
  },
});

/** Kept as the stable entry point used by `src/server.ts` and the root route (business logic: src/server/onboarding). */
export function handleOnboardingSubmission(request: Request) {
  return handleSubmit(request);
}
