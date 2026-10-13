// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsultHandoffDirectory, FileOnboardingStore, LocalFileSink } from "./file-store";
import { CONSULT_ID, NOW_MS, SECRET, consultToken, dealToken, jpegFile, validAnswers } from "./fixtures";
import { handleBootstrap, handleSubmit, readLimited, runtimeFromEnv, type Deps } from "./http";
import { createOnboardingService } from "./service";
import { writeFile, mkdir } from "node:fs/promises";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-onbhttp-"));
  await mkdir(join(dir, "consult"), { recursive: true });
  await writeFile(
    join(dir, "consult", `${CONSULT_ID}.json`),
    JSON.stringify({ payload: { onboarding_prefill: { "ON-01": "Ali Rezaei", "ON-07": "ali.rezaei@example.test", "ON-08": 178, evil: "x", "ON-03": { nested: true } } } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const deps = (max = 80 * 1024 * 1024): Deps => ({
  runtime: () => ({
    maxBodyBytes: max,
    service: createOnboardingService({ store: new FileOnboardingStore(dir), directory: new ConsultHandoffDirectory(dir), sink: new LocalFileSink(dir), secret: SECRET, now: () => NOW_MS }),
  }),
});

const HOST = "https://onboarding-staging.6tofit.com";
const SID = "11111111-2222-4333-8444-555555555555";

function submitRequest(opts: { token?: string; answers?: Record<string, string>; files?: Record<string, ReturnType<typeof jpegFile>>; host?: string; key?: string | null; type?: "multipart" | "json" } = {}) {
  const host = opts.host ?? HOST;
  if (opts.type === "json") return new Request(`${host}/api/onboarding/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const form = new FormData();
  form.append("form_session_token", opts.token ?? consultToken());
  form.append("submission_id", SID);
  form.append("verification_state", JSON.stringify({ "ON-01": "confirmed" }));
  for (const [k, v] of Object.entries(opts.answers ?? validAnswers("Combo"))) form.append(`answer:${k}`, v);
  for (const [k, f] of Object.entries(opts.files ?? {})) form.append(`file:${k}`, new File([f.bytes as BlobPart], f.name, { type: f.type }));
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? SID;
  return new Request(`${host}/api/onboarding/submit`, { method: "POST", headers, body: form });
}

describe("HTTP layer: bootstrap", () => {
  it("GET and POST (Passenger root dispatch) return the contract; prefill is filtered to the mapped, scalar keys", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap?session=${encodeURIComponent(consultToken({ scope: "Diet" }))}`, { method }), deps());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ scope: "Diet", entitlements: [], prefill: { "ON-01": "Ali Rezaei", "ON-07": "ali.rezaei@example.test", "ON-08": 178 } });
      expect(Object.keys(body["prefill"] as object).sort()).toEqual(["ON-01", "ON-07", "ON-08"]); // `evil` and the nested object are dropped
    }
  });

  it("401 without or with a bad session, 404 for an unknown consultation, 503 for a Deal link without a resolver (fail closed), 403 outside staging", async () => {
    expect((await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap`), deps())).status).toBe(401);
    expect((await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap?session=abc`), deps())).status).toBe(401);
    const unknown = consultToken({ consult_submission_id: "cns_ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect((await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap?session=${encodeURIComponent(unknown)}`), deps())).status).toBe(404);
    const deal = await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap?session=${encodeURIComponent(dealToken())}`), deps());
    expect(deal.status).toBe(503);
    expect(((await deal.json()) as { error_code: string }).error_code).toBe("IDENTITY_UNAVAILABLE");
    expect((await handleBootstrap(new Request("https://six2fit.com/api/onboarding/bootstrap?session=x"), deps())).status).toBe(403);
    expect((await handleBootstrap(new Request(`${HOST}/api/onboarding/bootstrap`, { method: "DELETE" }), deps())).status).toBe(405);
  });
});

describe("HTTP layer: submit (multipart)", () => {
  it("accepts a complete submission end to end and deduplicates the retry", async () => {
    const first = await handleSubmit(submitRequest(), deps());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "completed", submission_id: SID, deduplicated: false });
    const retry = await handleSubmit(submitRequest(), deps());
    expect(((await retry.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
    expect(await readdir(join(dir, "onboarding-v2"))).toHaveLength(1);
  });

  it("receives real file parts and stores them", async () => {
    const answers = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    const res = await handleSubmit(submitRequest({ answers, files: { "MS-05.front": jpegFile("front.jpg", 5000) } }), deps());
    expect(res.status).toBe(200);
    expect(await readdir(join(dir, "uploads-v2"))).toHaveLength(1);
  });

  it("rejects wrong media type (415), oversize bodies (413), missing key (400), other hosts (403), other methods (405) and bad config (503)", async () => {
    expect((await handleSubmit(submitRequest({ type: "json" }), deps())).status).toBe(415);
    expect((await handleSubmit(submitRequest({ files: { "MS-05.front": jpegFile("a.jpg", 50_000) } }), deps(10_000))).status).toBe(413);
    expect((await handleSubmit(submitRequest({ key: null }), deps())).status).toBe(400);
    expect((await handleSubmit(submitRequest({ host: "https://six2fit.com" }), deps())).status).toBe(403);
    expect((await handleSubmit(new Request(`${HOST}/api/onboarding/submit`, { method: "GET" }), deps())).status).toBe(405);
    expect((await handleSubmit(submitRequest(), { runtime: () => runtimeFromEnv({}) })).status).toBe(503);
  });

  it("a text answer sent where a file belongs and non-file parts under file: are rejected", async () => {
    const form = new FormData();
    form.append("form_session_token", consultToken());
    form.append("submission_id", SID);
    form.append("file:MS-05.front", "not-a-file");
    const res = await handleSubmit(new Request(`${HOST}/api/onboarding/submit`, { method: "POST", headers: { "idempotency-key": SID }, body: form }), deps());
    expect(res.status).toBe(400);
  });

  it("error bodies never echo values", async () => {
    const res = await handleSubmit(submitRequest({ answers: validAnswers("Combo", { "ON-07": "super-secret-value@" }) }), deps());
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toMatch(/super-secret-value/);
  });
});

describe("runtime configuration", () => {
  it("is staging-only, needs a long secret and a storage directory, and CRM mode needs the explicit CRM configuration", () => {
    const ok = { SIX2FIT_STAGING_MODE: "true", SIX2FIT_STAGING_TOKEN_SECRET: SECRET, SIX2FIT_STAGING_STORAGE_DIR: dir };
    expect(() => runtimeFromEnv(ok)).not.toThrow();
    expect(() => runtimeFromEnv({ ...ok, SIX2FIT_STAGING_MODE: "false" })).toThrow();
    expect(() => runtimeFromEnv({ ...ok, SIX2FIT_STAGING_TOKEN_SECRET: "short" })).toThrow();
    expect(() => runtimeFromEnv({ ...ok, SIX2FIT_STAGING_STORAGE_DIR: "" })).toThrow();
    expect(() => runtimeFromEnv({ ...ok, SIX2FIT_ONBOARDING_STORE: "crm" })).toThrow(); // CRM not enabled/configured
    expect(() => runtimeFromEnv({ ...ok, SIX2FIT_ONBOARDING_STORE: "bogus" })).toThrow();
  });

  it("readLimited stops reading a body larger than the limit", async () => {
    const big = new Request(`${HOST}/x`, { method: "POST", body: new Uint8Array(5000) });
    expect(await readLimited(big, 1000)).toBeNull();
    const small = new Request(`${HOST}/x`, { method: "POST", body: new Uint8Array(500) });
    expect((await readLimited(small, 1000))?.byteLength).toBe(500);
  });
});
