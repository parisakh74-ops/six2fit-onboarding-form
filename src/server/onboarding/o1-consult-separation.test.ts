// @vitest-environment node
// P2-05 / O1: Consultation can never open Onboarding. Synthetic data only; no network, no CRM, no WorkDrive.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsultHandoffDirectory } from "./file-store";
import { CONSULT_ID, DEAL_ID, NOW_MS, SECRET, consultToken, dealToken } from "./fixtures";
import { runtimeFromEnv } from "./http";
import { CompositeSubjectDirectory } from "./links/deal-directory";
import { handleIssueLinkFromEnv } from "./links/runtime";
import type { OnboardingStore } from "./ports";
import { createOnboardingService } from "./service";

const OTHER_SECRET = "consultation-side-secret-0123456789abcdefghij";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-o1-"));
  await mkdir(join(dir, "consult"), { recursive: true });
  await writeFile(join(dir, "consult", `${CONSULT_ID}.json`), JSON.stringify({ payload: { onboarding_prefill: { "ON-01": "Synthetic" } } }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const store: OnboardingStore = { get: async () => null, create: async () => { throw new Error("must not write"); } };
const svc = (acceptConsultHandoff?: boolean) =>
  createOnboardingService({ store, directory: new ConsultHandoffDirectory(dir), sink: { put: async () => "" }, secret: SECRET, now: () => NOW_MS, ...(acceptConsultHandoff === undefined ? {} : { acceptConsultHandoff }) });
const code = (r: { body: Record<string, unknown> }) => r.body["error_code"];

describe("O1: Consultation hand-off tokens (v1)", () => {
  it("N3: a valid v1 token is REFUSED by default at bootstrap, even though the consult record exists", async () => {
    const r = await svc().bootstrap(consultToken());
    expect([r.status, code(r)]).toEqual([401, "INVALID_OR_EXPIRED_SESSION"]);
    expect(JSON.stringify(r.body)).not.toContain("Synthetic");
  });

  it("N3: ...and at submit (no store access)", async () => {
    const r = await svc().submit({ token: consultToken(), submissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", answers: {}, verificationState: "{}", files: {} });
    expect([r.status, code(r)]).toEqual([401, "INVALID_OR_EXPIRED_SESSION"]);
  });

  it("the hand-off works only when explicitly enabled (development/staging, file mode)", async () => {
    expect((await svc(true).bootstrap(consultToken())).status).toBe(200);
  });

  it("N5: a token signed with the Consultation-side secret is refused, for v1 and for a forged Deal-bound v2", async () => {
    for (const t of [consultToken({}, OTHER_SECRET), dealToken({}, OTHER_SECRET)]) {
      expect((await svc(true).bootstrap(t)).status).toBe(401);
      expect((await svc().bootstrap(t)).status).toBe(401);
    }
  });

  it("a Deal-bound v2 token signed with the onboarding secret is unaffected by the flag", async () => {
    const directory = new CompositeSubjectDirectory(null, { resolve: async () => ({ prefill: {} }) });
    const s = createOnboardingService({ store, directory, sink: { put: async () => "" }, secret: SECRET, now: () => NOW_MS });
    expect((await s.bootstrap(dealToken())).status).toBe(200);
  });

  it("N7: with no hand-off resolver the composite directory refuses a Consultation subject and reads no file", async () => {
    const d = new CompositeSubjectDirectory(null, null);
    await expect(d.resolve({ kind: "consult", consultSubmissionId: CONSULT_ID })).rejects.toMatchObject({ code: "SUBJECT_NOT_ELIGIBLE" });
  });
});

describe("O1: separated secrets and runtime configuration", () => {
  const base = { SIX2FIT_STAGING_MODE: "true", SIX2FIT_STAGING_STORAGE_DIR: "" };
  it("production-like configuration needs the onboarding secret; the legacy shared variable is not enough", () => {
    const env = { ...base, SIX2FIT_STAGING_STORAGE_DIR: dir, SIX2FIT_STAGING_TOKEN_SECRET: SECRET };
    expect(() => runtimeFromEnv(env)).toThrow();
    expect(() => runtimeFromEnv({ ...env, SIX2FIT_ONBOARDING_TOKEN_SECRET: SECRET })).not.toThrow();
  });

  it("the legacy shared variable is honoured only while the hand-off is explicitly enabled, never with the CRM store", () => {
    const env = { ...base, SIX2FIT_STAGING_STORAGE_DIR: dir, SIX2FIT_STAGING_TOKEN_SECRET: SECRET, SIX2FIT_ACCEPT_CONSULT_HANDOFF: "true" };
    expect(() => runtimeFromEnv(env)).not.toThrow();
    expect(() => runtimeFromEnv({ ...env, SIX2FIT_ONBOARDING_STORE: "crm" })).toThrow(); // CRM mode: no hand-off, no shared secret (and CRM not configured here)
  });

  it("the issuer endpoint refuses to run on anything but the onboarding secret variable", async () => {
    const res = await handleIssueLinkFromEnv(new Request("https://onboarding-staging.6tofit.com/api/internal/onboarding-link", { method: "POST", body: "{}" }), { crm: {} as never, links: {} as never, submissions: {} as never }, { SIX2FIT_STAGING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir });
    expect(res.status).toBe(503);
  });
});
