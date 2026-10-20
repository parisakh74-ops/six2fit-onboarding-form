import { createFileRoute } from "@tanstack/react-router";
import { handleBootstrap } from "@/server/onboarding/http";

export const Route = createFileRoute("/api/onboarding/bootstrap")({
  server: {
    handlers: {
      GET: ({ request }) => handleOnboardingBootstrap(request),
    },
  },
});

/** Kept as the stable entry point used by `src/server.ts` and the root route (business logic: src/server/onboarding). */
export function handleOnboardingBootstrap(request: Request) {
  return handleBootstrap(request);
}
