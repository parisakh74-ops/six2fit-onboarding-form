// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONSULT_ID, DEAL_ID, NOW_MS, SECRET, consultToken, dealToken } from "./fixtures";
import { MAX_LINK_LIFETIME_S, TokenError, signLinkToken, subjectKey, uniqueFormKey, verifyLinkToken } from "./tokens";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TokenError ? e.code : "OTHER";
  }
  return "NONE";
};

describe("onboarding link tokens", () => {
  it("v2: verifies a Deal-bound link and returns the signed claims only", () => {
    const c = verifyLinkToken(dealToken({ scope: "CIP", entitlements: ["cellulite"] }), SECRET, NOW_MS);
    expect(c).toMatchObject({ v: 2, subject: { kind: "deal", dealId: DEAL_ID }, scope: "CIP", entitlements: ["cellulite"], isFirstRequest: true, productRelatedTo: "Fitness and Nutrition" });
  });

  it("v1: the existing Consultation hand-off token still verifies (contract compatibility)", () => {
    const c = verifyLinkToken(consultToken({ scope: "Training" }), SECRET, NOW_MS);
    expect(c).toMatchObject({ v: 1, subject: { kind: "consult", consultSubmissionId: CONSULT_ID }, scope: "Training", entitlements: [] });
  });

  it("rejects tampered payloads, tampered signatures, a wrong secret and a short secret", () => {
    const t = dealToken();
    const [p, s] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), scope: "CIP" })).toString("base64url");
    expect(code(() => verifyLinkToken(`${forged}.${s}`, SECRET, NOW_MS))).toBe("SIGNATURE");
    expect(code(() => verifyLinkToken(`${p}.${s}x`, SECRET, NOW_MS))).toBe("SIGNATURE");
    expect(code(() => verifyLinkToken(t, `${SECRET}-other`, NOW_MS))).toBe("SIGNATURE");
    expect(code(() => verifyLinkToken(t, "short", NOW_MS))).toBe("SECRET");
  });

  it("rejects malformed tokens", () => {
    for (const t of ["", "x", "a.b.c", ".", "a.", ".b", "x".repeat(5000)]) expect(code(() => verifyLinkToken(t, SECRET, NOW_MS))).toBe("MALFORMED");
    expect(code(() => verifyLinkToken(signLinkToken({}, SECRET).replace(/\..*$/, ".AAAA"), SECRET, NOW_MS))).toBe("SIGNATURE");
  });

  it("rejects expired links and links valid for longer than the maximum lifetime", () => {
    expect(code(() => verifyLinkToken(dealToken({ exp: Math.floor(NOW_MS / 1000) - 1 }), SECRET, NOW_MS))).toBe("EXPIRED");
    expect(code(() => verifyLinkToken(dealToken({ exp: Math.floor(NOW_MS / 1000) }), SECRET, NOW_MS))).toBe("EXPIRED");
    expect(code(() => verifyLinkToken(dealToken({ exp: Math.floor(NOW_MS / 1000) + MAX_LINK_LIFETIME_S + 10 }), SECRET, NOW_MS))).toBe("CLAIMS");
    expect(code(() => verifyLinkToken(dealToken({ exp: "tomorrow" }), SECRET, NOW_MS))).toBe("CLAIMS");
  });

  it("rejects invalid claims: scope, entitlement, deal id, link id, version", () => {
    for (const over of [{ scope: "Everything" }, { entitlements: ["free_gift"] }, { entitlements: "cellulite" }, { deal_id: "abc" }, { deal_id: "12" }, { jti: "short" }, { jti: "has space in it here" }, { v: 3 }, { is_first_request: "yes" }]) {
      expect(code(() => verifyLinkToken(dealToken(over), SECRET, NOW_MS))).toBe("CLAIMS");
    }
    expect(code(() => verifyLinkToken(consultToken({ consult_submission_id: "../etc/passwd" }), SECRET, NOW_MS))).toBe("CLAIMS");
  });

  it("derives a stable, file-safe subject key and a collision-proof CRM unique key", () => {
    const a = verifyLinkToken(dealToken(), SECRET, NOW_MS);
    const b = verifyLinkToken(dealToken({ exp: Math.floor(NOW_MS / 1000) + 7200 }), SECRET, NOW_MS);
    const other = verifyLinkToken(dealToken({ jti: "link_ffffffffffffffffffff" }), SECRET, NOW_MS);
    expect(subjectKey(a)).toMatch(/^onb_[0-9a-f]{40}$/);
    expect(subjectKey(a)).toBe(subjectKey(b)); // same link, different expiry
    expect(subjectKey(a)).not.toBe(subjectKey(other));
    expect(uniqueFormKey(a)).toBe(`onb2_${DEAL_ID}_link_0123456789abcdef0123`);
    expect(uniqueFormKey(verifyLinkToken(consultToken(), SECRET, NOW_MS))).toBe(`onb1_${CONSULT_ID}`);
    expect(uniqueFormKey(a).length).toBeLessThanOrEqual(255);
  });

  it("a Consultation hand-off keeps one onboarding per Consultation submission even though its token is re-issued", () => {
    const x = verifyLinkToken(consultToken({ exp: Math.floor(NOW_MS / 1000) + 100 }), SECRET, NOW_MS);
    const y = verifyLinkToken(consultToken({ exp: Math.floor(NOW_MS / 1000) + 90_000 }), SECRET, NOW_MS);
    expect(subjectKey(x)).toBe(subjectKey(y));
  });
});
