// @vitest-environment node
// The cron helper signs exactly what the ops endpoint verifies, and refuses any target other than the Staging origin.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyIssuerRequest } from "../links/auth";
import { NOTION_RECONCILE_PATH, opsKindOf } from "./ops";

const { buildSignedRequest } = createRequire(import.meta.url)("../../../../scripts/notion-reconcile.cjs") as {
  buildSignedRequest: (secret: string, origin: string, body: string, nowSec: number) => { url: string; init: { method: string; body: string; headers: Record<string, string> } };
};
const SECRET = "ops-caller-secret-0123456789abcdef0123456";

describe("scripts/notion-reconcile.cjs", () => {
  it("builds a request the ops endpoint accepts (route alias + HMAC over the canonical path)", () => {
    const now = 1_790_000_000;
    const r = buildSignedRequest(SECRET, "https://onboarding-staging.6tofit.com", '{"limit":20}', now);
    expect(opsKindOf(new Request(r.url, { method: "POST" }))).toBe("notion-reconcile");
    expect(verifyIssuerRequest(SECRET, { timestamp: r.init.headers[TIMESTAMP_HEADER] as string, signature: r.init.headers[SIGNATURE_HEADER] as string, method: "POST", path: NOTION_RECONCILE_PATH, body: r.init.body }, now * 1000)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("refuses another origin, plain http, a path, and a short secret", () => {
    for (const o of ["https://6tofit.com", "http://onboarding-staging.6tofit.com", "https://evil.example", "https://onboarding-staging.6tofit.com/x"]) expect(() => buildSignedRequest(SECRET, o, "{}", 1)).toThrow();
    expect(() => buildSignedRequest("short", "https://onboarding-staging.6tofit.com", "{}", 1)).toThrow();
  });
});
