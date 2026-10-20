/**
 * Staging-only, read-only "which build is this process running" probe.
 *
 *   GET /__s2f/runtime        (also GET /?six2fit_runtime=1 for hosts that rewrite sub-paths)
 *
 * Answers with the build id baked in at build time (`VITE_BUILD_ID`, e.g. the git commit), the real start time of the
 * Node process and its pid. Comparing `build` with the deployed artifact proves which code a RUNNING process uses, and a
 * changed `startedAt` proves a restart actually happened. No secrets, no environment values, no side effects, no CRM.
 * Only answered when `SIX2FIT_STAGING_MODE=true` and the host name contains "staging"; otherwise it is not handled.
 */
export type RuntimeInfoDeps = {
  env?: Record<string, string | undefined>;
  build?: string;
  now?: () => number;
  uptimeSec?: () => number;
  pid?: number;
  nodeVersion?: string;
};

const buildFromBundle = (): string => {
  const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.["VITE_BUILD_ID"];
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : "unknown";
};

export function matchRuntimeInfo(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  return url.pathname === "/__s2f/runtime" || (url.pathname === "/" && url.searchParams.get("six2fit_runtime") === "1");
}

export function handleRuntimeInfo(request: Request, deps: RuntimeInfoDeps = {}): Response | null {
  if (!matchRuntimeInfo(request)) return null;
  const env = deps.env ?? process.env;
  if ((env["SIX2FIT_STAGING_MODE"] ?? "").trim() !== "true") return null;
  if (!new URL(request.url).hostname.toLowerCase().includes("staging")) return null;
  const now = (deps.now ?? Date.now)();
  const uptime = (deps.uptimeSec ?? (() => process.uptime()))();
  return Response.json(
    {
      ok: true,
      build: deps.build ?? buildFromBundle(),
      startedAt: new Date(now - uptime * 1000).toISOString(),
      uptimeSec: Math.round(uptime),
      pid: deps.pid ?? process.pid,
      node: deps.nodeVersion ?? process.version,
    },
    { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } },
  );
}
