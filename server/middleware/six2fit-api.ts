import { handleOnboardingBootstrap } from "../../src/routes/api/onboarding/bootstrap";
import { handleOnboardingSubmission } from "../../src/routes/api/onboarding/submit";

export default async function six2fitApiMiddleware(event: {
  req: Request;
  url: URL;
}) {
  const action = event.url.searchParams.get("six2fit_api");
  const isBootstrap =
    (event.req.method === "GET" && event.url.pathname === "/api/onboarding/bootstrap") ||
    (event.req.method === "POST" && action === "bootstrap");
  const isSubmission = event.req.method === "POST" && (
    event.url.pathname === "/api/onboarding/submit" || action === "submit"
  );

  if (isBootstrap) return handleOnboardingBootstrap(event.req);
  if (isSubmission) return handleOnboardingSubmission(event.req);
}
