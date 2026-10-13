import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEPS, validate } from "@/components/onboarding/steps";
import { isActive } from "@/lib/onboarding/data";
import { fileOf, isFileMeta, rememberFile } from "@/lib/onboarding/files";
import { submitOnboarding, type OnboardingBootstrap } from "@/lib/onboarding/integration";

const bootstrap: OnboardingBootstrap = { form_session_token: "synthetic-token-0123456789-abcdefghijklmnop", scope: "Combo", entitlements: [], prefill: {}, expires_at: "2099-01-01T00:00:00.000Z" };

describe("browser submission", () => {
  let sent: Array<{ form: FormData; headers: Record<string, string> }>;
  let failures = 0;
  beforeEach(() => {
    sessionStorage.clear();
    sent = [];
    failures = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: FormData; headers: Record<string, string> }) => {
      sent.push({ form: init.body, headers: init.headers });
      if (failures > 0) {
        failures -= 1;
        return new Response("{}", { status: 503 });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the real file bytes as a file part (it used to send the text '[object Object]')", async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "front.jpg", { type: "image/jpeg" });
    const meta = { name: "front.jpg", size: file.size, type: "image/jpeg", status: "uploaded" as const };
    rememberFile(meta, file);
    expect(fileOf(meta)).toBe(file);
    await submitOnboarding(bootstrap, { "ON-01": "Ali", "NU-19": ["time"], "MS-05.front": meta }, {});
    const form = sent[0]!.form;
    expect(form.get("answer:ON-01")).toBe("Ali");
    expect(form.get("answer:NU-19")).toBe('["time"]');
    const part = form.get("file:MS-05.front");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("front.jpg");
    expect(form.get("answer:MS-05.front")).toBeNull();
  });

  it("never sends restored file metadata (no bytes) as text", async () => {
    const restored = JSON.parse(JSON.stringify({ name: "front.jpg", size: 10, type: "image/jpeg", status: "uploaded" }));
    expect(isFileMeta(restored)).toBe(true);
    expect(fileOf(restored)).toBeUndefined();
    await submitOnboarding(bootstrap, { "ON-01": "Ali", "MS-05.front": restored }, {});
    const form = sent[0]!.form;
    expect(form.get("answer:MS-05.front")).toBeNull();
    expect(form.get("file:MS-05.front")).toBeNull();
  });

  it("a retry after a failure reuses the same submission id and Idempotency-Key until it succeeds", async () => {
    failures = 1;
    await expect(submitOnboarding(bootstrap, { "ON-01": "Ali" }, {})).rejects.toThrow("SUBMISSION_FAILED");
    await submitOnboarding(bootstrap, { "ON-01": "Ali" }, {});
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["Idempotency-Key"]).toBe(sent[1]!.headers["Idempotency-Key"]);
    expect(sent[0]!.form.get("submission_id")).toBe(sent[1]!.headers["Idempotency-Key"]);
    await submitOnboarding(bootstrap, { "ON-01": "Ali" }, {}); // success forgot the id: a new submission gets a new id
    expect(sent[2]!.headers["Idempotency-Key"]).not.toBe(sent[0]!.headers["Idempotency-Key"]);
  });

  it("maps 401, 409 and 422 to distinct errors", async () => {
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    for (const [status, msg] of [[401, "SESSION_EXPIRED"], [409, "SUBMISSION_CONFLICT"], [422, "SUBMISSION_INVALID"]] as const) {
      f.mockResolvedValueOnce(new Response("{}", { status }));
      await expect(submitOnboarding(bootstrap, { "ON-01": "Ali" }, {})).rejects.toThrow(msg);
    }
  });
});

describe("form validation additions", () => {
  it("requires the phone country code (the server cannot interpret a number without it)", () => {
    const a = { "ON-01": "Ali", "ON-06.n": "9121234567" } as Record<string, unknown>;
    const errs = validate(STEPS[0]!, a, (k) => isActive(k, a, "Combo"), {});
    expect(errs["ON-06.cc"]).toBeTruthy();
  });
});
