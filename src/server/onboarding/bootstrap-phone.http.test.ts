// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsultHandoffDirectory, FileOnboardingStore, LocalFileSink } from "./file-store";
import { CONSULT_ID, NOW_MS, SECRET, consultToken } from "./fixtures";
import { handleBootstrap, type Deps } from "./http";
import { createOnboardingService } from "./service";

// DEF-01 at the HTTP boundary: a synthetic Consultation record (E.164 phone with matching ISO/dial code, the shape
// Consultation writes) must reach the browser as the national number, with the signed session resolved correctly.
// Nothing here may reach the network (no CRM, WorkDrive, payment or messaging call).

const HOST = "https://onboarding-staging.6tofit.com";
const EXP = Math.floor(NOW_MS / 1000) + 3600;

const consultRecord = (over: Record<string, unknown>) => ({
  version: 2,
  submission_id: CONSULT_ID,
  payload: {
    submission_id: CONSULT_ID,
    whatsapp_phone_normalized: "+14165550100",
    whatsapp_dial_code: "+1",
    whatsapp_country: "CA",
    onboarding_prefill: {
      "ON-01": "Synthetic Tester",
      "ON-03": "female",
      "ON-06.iso": "CA",
      "ON-06.cc": "+1",
      "ON-06.n": "+14165550100",
      "ON-07": "synthetic@example.test",
      "ON-08": 170,
      "ON-09.kg": 70,
      timezone: "America/Toronto",
      ...over,
    },
  },
});

let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("network call attempted");
  });
  dir = await mkdtemp(join(tmpdir(), "s2f-onbboot-"));
  await mkdir(join(dir, "consult"), { recursive: true });
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

const writeRecord = (over: Record<string, unknown> = {}, id = CONSULT_ID) =>
  writeFile(join(dir, "consult", `${id}.json`), JSON.stringify(consultRecord(over)));

const deps = (): Deps => ({
  runtime: () => ({
    maxBodyBytes: 1024,
    service: createOnboardingService({
      store: new FileOnboardingStore(dir),
      directory: new ConsultHandoffDirectory(dir),
      sink: new LocalFileSink(dir),
      secret: SECRET,
      // O1: the Consultation hand-off is refused by default; this test covers the legacy dev/staging hand-off explicitly.
      acceptConsultHandoff: true,
      now: () => NOW_MS,
    }),
  }),
});

const bootstrap = (token: string | null, init: RequestInit = {}, host = HOST) =>
  handleBootstrap(
    new Request(
      `${host}/api/onboarding/bootstrap${token === null ? "" : `?session=${encodeURIComponent(token)}`}`,
      init,
    ),
    deps(),
  );

type Body = {
  scope?: string;
  entitlements?: unknown;
  expires_at?: string;
  form_session_token?: string;
  prefill?: Record<string, unknown>;
  error_code?: string;
};

describe("HTTP bootstrap: Consultation record with an E.164 phone", () => {
  it("resolves the signed session and returns the national number with a consistent ISO and dial code", async () => {
    await writeRecord();
    for (const method of ["GET", "POST"]) {
      const res = await bootstrap(consultToken({ scope: "Training" }), { method });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Body;
      expect(body.scope).toBe("Training");
      expect(body.entitlements).toEqual([]);
      expect(body.expires_at).toBe(new Date(EXP * 1000).toISOString());
      expect(typeof body.form_session_token).toBe("string");
      expect(body.prefill).toEqual({
        "ON-01": "Synthetic Tester",
        "ON-03": "female",
        "ON-06.iso": "CA",
        "ON-06.cc": "+1",
        "ON-06.n": "4165550100", // national number, no plus and no dial code
        "ON-07": "synthetic@example.test",
        "ON-08": 170,
        "ON-09.kg": 70,
        timezone: "America/Toronto",
      });
      // joined back it is exactly the Consultation E.164 value
      expect(`${body.prefill?.["ON-06.cc"]}${body.prefill?.["ON-06.n"]}`).toBe("+14165550100");
      expect(JSON.stringify(body)).not.toContain("+14165550100");
    }
  });

  it("converts an Iranian record (+98, typed with a leading zero in Consultation) and keeps ISO IR", async () => {
    await writeRecord({ "ON-06.iso": "IR", "ON-06.cc": "+98", "ON-06.n": "+989123456789" });
    const body = (await (await bootstrap(consultToken())).json()) as Body;
    expect(body.prefill).toMatchObject({
      "ON-06.iso": "IR",
      "ON-06.cc": "+98",
      "ON-06.n": "9123456789",
    });
  });

  it("leaves a record that already holds a national number unchanged (backward compatible)", async () => {
    await writeRecord({ "ON-06.iso": "IR", "ON-06.cc": "+98", "ON-06.n": "9123456789" });
    const body = (await (await bootstrap(consultToken())).json()) as Body;
    expect(body.prefill?.["ON-06.n"]).toBe("9123456789");
  });

  it("keeps a mismatching record visible instead of guessing (other dial code)", async () => {
    await writeRecord({ "ON-06.iso": "CA", "ON-06.cc": "+1", "ON-06.n": "+989123456789" });
    const body = (await (await bootstrap(consultToken())).json()) as Body;
    expect(body.prefill?.["ON-06.n"]).toBe("+989123456789");
  });
});

describe("HTTP bootstrap: token, expiry and error behaviour is unchanged", () => {
  const errorOf = async (res: Response) => ((await res.json()) as Body).error_code;

  it("rejects a missing, malformed, expired, tampered or wrongly signed session with 401", async () => {
    await writeRecord();
    expect((await bootstrap(null)).status).toBe(401);
    expect((await bootstrap("abc")).status).toBe(401);

    const expired = await bootstrap(consultToken({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(expired.status).toBe(401);
    expect(await errorOf(expired)).toBe("INVALID_OR_EXPIRED_SESSION");

    const good = consultToken();
    const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`;
    expect((await bootstrap(tampered)).status).toBe(401);

    const wrongSecret = await bootstrap(
      consultToken({}, "another-secret-0123456789-abcdefghijkl-xyz"),
    );
    expect(wrongSecret.status).toBe(401);
    expect(JSON.stringify(await wrongSecret.json())).not.toContain("ON-06");
  });

  it("keeps 404 for an unknown consultation, 403 outside staging and 405 for other methods", async () => {
    await writeRecord();
    const unknown = consultToken({
      consult_submission_id: "cns_ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect((await bootstrap(unknown)).status).toBe(404);
    expect((await bootstrap(consultToken(), {}, "https://six2fit.com")).status).toBe(403);
    expect((await bootstrap(consultToken(), { method: "DELETE" })).status).toBe(405);
  });

  it("does not convert anything else in the record (unmapped and nested keys are still dropped)", async () => {
    await writeRecord({ evil: "x", "ON-03": { nested: true } });
    const body = (await (await bootstrap(consultToken())).json()) as Body;
    expect(Object.keys(body.prefill ?? {})).not.toContain("evil");
    expect(Object.keys(body.prefill ?? {})).not.toContain("ON-03");
    expect(body.prefill?.["ON-06.n"]).toBe("4165550100");
  });
});
