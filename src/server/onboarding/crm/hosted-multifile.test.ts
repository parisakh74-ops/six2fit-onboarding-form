// @vitest-environment node
// Local tests (no network) for the hosted smoke-test request construction and its safeguards.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SUBMISSION_ID_PATTERN } from "../service";
import { verifyLinkToken } from "../tokens";
import { HOSTED_CONFIRM, HOSTED_STAGING_HOST, assertHostedTarget, assertSandboxId, hostedMultiFileRequest } from "./hosted-fixtures";

const SECRET = "synthetic-test-secret-0123456789abcdef-hosted";
const DEAL = "6223361000127334002";
const NOW = 1_800_000_000;
const build = (over: Partial<Parameters<typeof hostedMultiFileRequest>[0]> = {}) => hostedMultiFileRequest({ secret: SECRET, dealId: DEAL, stamp: "abc123", nowSeconds: NOW, ...over });

describe("hosted target safeguards", () => {
  it("accepts only the exact Staging origin", () => {
    expect(() => assertHostedTarget(HOSTED_STAGING_HOST)).not.toThrow();
    for (const bad of [
      "https://six2fit.com", "https://www.six2fit.com", "https://onboarding.6tofit.com", "https://consult-staging.6tofit.com",
      "http://onboarding-staging.6tofit.com", "https://onboarding-staging.6tofit.com/", "https://onboarding-staging.6tofit.com:8443",
      "https://onboarding-staging.6tofit.com.evil.example", "https://user@onboarding-staging.6tofit.com", "http://localhost:3000", "",
    ]) expect(() => assertHostedTarget(bad)).toThrow("HOSTED_TARGET_REFUSED");
  });
  it("accepts only Sandbox record ids (never the Production prefix)", () => {
    expect(() => assertSandboxId(DEAL)).not.toThrow();
    for (const bad of ["6067417000130227003", "6067417000000220306", "123", "", "6223361000"]) expect(() => assertSandboxId(bad)).toThrow("NOT_A_SANDBOX_ID");
  });
  it("refuses to build a request for another host, a Production Deal id or a short secret", () => {
    expect(() => build({ host: "https://six2fit.com" })).toThrow("HOSTED_TARGET_REFUSED");
    expect(() => build({ dealId: "6067417000130227003" })).toThrow("NOT_A_SANDBOX_ID");
    expect(() => build({ secret: "short" })).toThrow("TOKEN_SECRET_TOO_SHORT");
  });
  it("the confirmation string is explicit and specific to the hosted test", () => {
    expect(HOSTED_CONFIRM).toBe("S2F-TEST-ONBOARDING-20261021-HOSTED");
  });
});

describe("hosted request construction", () => {
  it("is a POST to the Staging submit route with the idempotency key equal to the submission id", () => {
    const m = build();
    expect(m.request.method).toBe("POST");
    expect(m.request.url).toBe(`${HOSTED_STAGING_HOST}/api/onboarding/submit`);
    expect(m.request.headers.get("idempotency-key")).toBe(m.submissionId);
    expect(SUBMISSION_ID_PATTERN.test(m.submissionId)).toBe(true);
  });
  it("carries seven distinct synthetic files in the accepted fields and the synthetic answers", async () => {
    const m = build();
    const form = await m.request.formData();
    const keys = [...form.keys()].filter((k) => k.startsWith("file:")).sort();
    expect(keys).toEqual(["file:HL-09", "file:MS-05.back", "file:MS-05.front", "file:MS-05.side", "file:MS-05.side_forward", "file:MS-06.photo", "file:TR-06.other_photo"]);
    const hashes = new Set<string>();
    for (const k of keys) {
      const f = form.get(k) as File;
      hashes.add(createHash("sha256").update(Buffer.from(await f.arrayBuffer())).digest("hex"));
    }
    expect(hashes.size).toBe(7);
    expect(form.get("answer:MS-06.consent")).toBe("true");
    expect(String(form.get("answer:ON-07"))).toMatch(/@s2f-test\.example\.invalid$/);
    expect(form.get("submission_id")).toBe(m.submissionId);
    expect(m.files).toBe(7);
  });
  it("signs a Combo + cellulite deal link for the synthetic Deal, valid for one hour, and never contains the secret", async () => {
    const m = build();
    const claims = verifyLinkToken(m.token, SECRET, NOW * 1000);
    expect(claims.scope).toBe("Combo");
    expect([...claims.entitlements]).toEqual(["cellulite"]);
    expect(claims.subject).toMatchObject({ kind: "deal", dealId: DEAL });
    expect(claims.exp).toBe(NOW + 3600);
    expect(() => verifyLinkToken(m.token, "another-secret-0123456789abcdef-0123456", NOW * 1000)).toThrow();
    expect(() => verifyLinkToken(m.token, SECRET, (NOW + 3601) * 1000)).toThrow();
    const wire = JSON.stringify([...(await m.request.formData()).entries()].map(([k, v]) => (typeof v === "string" ? [k, v] : [k, "file"])));
    expect(wire).not.toContain(SECRET);
    expect(m.token).not.toContain(SECRET);
  });
  it("is deterministic for the same inputs (the replay carries the identical token and ids) and distinct per stamp", () => {
    const a = build(), b = build(), c = build({ stamp: "other99" });
    expect(a.token).toBe(b.token);
    expect(a.submissionId).toBe(b.submissionId);
    expect(a.formKey).toBe(b.formKey);
    expect(c.submissionId).not.toBe(a.submissionId);
    expect(c.formKey).not.toBe(a.formKey);
  });
});
