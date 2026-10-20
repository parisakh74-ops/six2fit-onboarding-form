import { describe, expect, it } from "vitest";
import { handleRuntimeInfo, matchRuntimeInfo } from "./runtime-info";

const STAGING = { SIX2FIT_STAGING_MODE: "true" };
const req = (url: string, method = "GET") => new Request(url, { method });
const deps = { env: STAGING, build: "abc1234", now: () => Date.UTC(2026, 9, 13, 12, 0, 0), uptimeSec: () => 3600, pid: 4242, nodeVersion: "v22.23.3" };

describe("staging runtime probe", () => {
  it("reports build, real process start time, pid and node version", async () => {
    const res = handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime"), deps)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, build: "abc1234", startedAt: "2026-10-13T11:00:00.000Z", uptimeSec: 3600, pid: 4242, node: "v22.23.3" });
  });

  it("also answers on the sub-path-rewrite form", () => {
    expect(handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/?six2fit_runtime=1"), deps)?.status).toBe(200);
  });

  it("is not handled outside staging mode, on non-staging hosts, for other methods or other paths", () => {
    expect(handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime"), { ...deps, env: {} })).toBeNull();
    expect(handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime"), { ...deps, env: { SIX2FIT_STAGING_MODE: "false" } })).toBeNull();
    expect(handleRuntimeInfo(req("https://six2fit.com/__s2f/runtime"), deps)).toBeNull();
    expect(handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime", "POST"), deps)).toBeNull();
    expect(handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/other"), deps)).toBeNull();
    expect(matchRuntimeInfo(req("https://onboarding-staging.6tofit.com/?x=1"))).toBe(false);
  });

  it("never exposes environment values", async () => {
    const res = handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime"), { ...deps, env: { ...STAGING, SIX2FIT_STAGING_TOKEN_SECRET: "synthetic-secret-value-0123456789abcdef" } })!;
    expect(JSON.stringify(await res.json())).not.toMatch(/synthetic-secret|TOKEN|SECRET/);
  });

  it("falls back to 'unknown' when no build id was baked in", async () => {
    const { build: _unused, ...noBuild } = deps;
    const res = handleRuntimeInfo(req("https://onboarding-staging.6tofit.com/__s2f/runtime"), noBuild)!;
    expect((await res.json()).build).toMatch(/^(unknown|[A-Za-z0-9._-]+)$/);
  });
});
