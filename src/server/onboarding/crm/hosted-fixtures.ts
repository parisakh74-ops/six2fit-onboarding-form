import { sha256Hex } from "../canonical";
import { signLinkToken, uniqueFormKey, verifyLinkToken } from "../tokens";
import { MULTIFILE_ENTITLEMENTS, LIVE_MARK, buildMultiFileRequest, liveSubmissionId, syntheticFiles, syntheticMultiFileAnswers } from "./live-fixtures";

/**
 * Request construction for the HOSTED Onboarding Staging smoke test (operator-run, `hosted-multifile.live.test.ts`). Pure: no
 * network, no secret of its own. The token secret is supplied by the caller at execution time and is never logged or returned
 * in any result structure other than the signed token itself (which the live test must not print).
 */
export const HOSTED_STAGING_HOST = "https://onboarding-staging.6tofit.com";
export const HOSTED_CONFIRM = `${LIVE_MARK}-HOSTED`;

/** Only the one approved Staging origin is accepted: no other host, scheme, port, path, credentials or Production-looking name. */
export function assertHostedTarget(host: string): void {
  if (host !== HOSTED_STAGING_HOST) throw new Error("HOSTED_TARGET_REFUSED");
}

/** Synthetic Sandbox ids only (the Sandbox organisation's record-id prefix; Production ids start 6067417000). */
export function assertSandboxId(id: string): void {
  if (!/^6223361000\d{9}$/.test(id)) throw new Error("NOT_A_SANDBOX_ID");
}

export type HostedMultiFile = { request: Request; token: string; submissionId: string; formKey: string; files: number };

/** One seven-file Combo + cellulite submission for the synthetic Sandbox Deal, with a freshly signed link token (1 h). */
export function hostedMultiFileRequest(opts: { secret: string; dealId: string; stamp: string; host?: string; nowSeconds?: number }): HostedMultiFile {
  const host = opts.host ?? HOSTED_STAGING_HOST;
  assertHostedTarget(host);
  assertSandboxId(opts.dealId);
  if (opts.secret.length < 32) throw new Error("TOKEN_SECRET_TOO_SHORT");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const jti = `s2fhosted-${sha256Hex(`hosted:${opts.stamp}`).slice(0, 20)}`; // 30 chars, [A-Za-z0-9_-]: within the 16-64 claim rule for any stamp
  const token = signLinkToken(
    { v: 2, deal_id: opts.dealId, jti, scope: "Combo", entitlements: [...MULTIFILE_ENTITLEMENTS], exp: now + 3600, is_first_request: true, product_related_to: LIVE_MARK },
    opts.secret,
  );
  const files = syntheticFiles();
  const submissionId = liveSubmissionId("H", opts.stamp);
  const formKey = uniqueFormKey(verifyLinkToken(token, opts.secret, now * 1000));
  const request = buildMultiFileRequest({ token, submissionId, answers: syntheticMultiFileAnswers(), files, host });
  return { request, token, submissionId, formKey, files: Object.keys(files).length };
}
