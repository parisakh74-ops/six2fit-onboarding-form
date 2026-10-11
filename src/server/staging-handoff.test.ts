import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHandoff } from "./staging-handoff";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";

function token(exp: number) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    consult_submission_id: "cns_12345678-1234-1234-1234-123456789012",
    scope: "Training",
    entitlements: [],
    exp,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("onboarding handoff verification", () => {
  it("accepts a signed, unexpired token", () => {
    expect(verifyHandoff(token(Math.floor(Date.now() / 1000) + 60), secret).scope).toBe("Training");
  });

  it("rejects changed and expired tokens", () => {
    const valid = token(Math.floor(Date.now() / 1000) + 60);
    expect(() => verifyHandoff(`${valid}x`, secret)).toThrow(/signature/);
    expect(() => verifyHandoff(token(Math.floor(Date.now() / 1000) - 1), secret)).toThrow(/Expired/);
  });
});
