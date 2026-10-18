// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsultHandoffDirectory, nationalPhoneFromPrefill } from "./file-store";
import { CONSULT_ID } from "./fixtures";

// Consultation stores `ON-06.n` as E.164 (`+<dial><local>`); Onboarding's `ON-06.n` is the national number.
describe("nationalPhoneFromPrefill (inverse of the Consultation E.164 join)", () => {
  it("removes the dial-code prefix of an E.164 value", () => {
    expect(nationalPhoneFromPrefill("+14165550100", "+1")).toBe("4165550100");
    expect(nationalPhoneFromPrefill("+989121234567", "+98")).toBe("9121234567");
    expect(nationalPhoneFromPrefill("+971501234567", "+971")).toBe("501234567");
  });

  it("does not strip a dial-code-looking start of an already national number (no leading plus)", () => {
    expect(nationalPhoneFromPrefill("9121234567", "+98")).toBe("9121234567");
    expect(nationalPhoneFromPrefill("14165550100", "+1")).toBe("14165550100");
  });

  it("leaves the value unchanged when it does not match the dial code or cannot be reduced to digits", () => {
    expect(nationalPhoneFromPrefill("+441234567890", "+1")).toBe("+441234567890"); // other dial code: stay visible
    expect(nationalPhoneFromPrefill("+1", "+1")).toBe("+1"); // nothing left
    expect(nationalPhoneFromPrefill("+1416 555 0100", "+1")).toBe("+1416 555 0100"); // not the Consultation format
    expect(nationalPhoneFromPrefill("+14165550100", undefined)).toBe("+14165550100");
    expect(nationalPhoneFromPrefill("+14165550100", "1")).toBe("+14165550100"); // dial code must carry the plus
    expect(nationalPhoneFromPrefill("+14165550100", "+12345")).toBe("+14165550100"); // not a valid dial code
  });
});

describe("ConsultHandoffDirectory.resolve: phone prefill", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "s2f-onbphone-"));
    await mkdir(join(dir, "consult"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (prefill: Record<string, unknown>) =>
    writeFile(
      join(dir, "consult", `${CONSULT_ID}.json`),
      JSON.stringify({ payload: { onboarding_prefill: prefill } }),
    );
  const resolve = () =>
    new ConsultHandoffDirectory(dir).resolve({ kind: "consult", consultSubmissionId: CONSULT_ID });

  it("returns the national number for a Consultation record that holds E.164", async () => {
    await write({
      "ON-01": "Synthetic Tester",
      "ON-06.iso": "CA",
      "ON-06.cc": "+1",
      "ON-06.n": "+14165550100",
      "ON-07": "synthetic@example.test",
    });
    const r = await resolve();
    expect(r?.prefill["ON-06.n"]).toBe("4165550100");
    expect(r?.prefill["ON-06.cc"]).toBe("+1");
    expect(r?.prefill["ON-06.iso"]).toBe("CA");
    expect(r?.prefill["ON-01"]).toBe("Synthetic Tester");
  });

  it("keeps an Iranian record consistent (+98)", async () => {
    await write({ "ON-06.iso": "IR", "ON-06.cc": "+98", "ON-06.n": "+989121234567" });
    expect((await resolve())?.prefill["ON-06.n"]).toBe("9121234567");
  });

  it("is idempotent for records that already carry a national number and does not touch other keys", async () => {
    await write({ "ON-06.cc": "+98", "ON-06.n": "9121234567", "ON-08": 178, evil: "x" });
    const r = await resolve();
    expect(r?.prefill["ON-06.n"]).toBe("9121234567");
    expect(r?.prefill["ON-08"]).toBe(178);
    expect(r?.prefill).not.toHaveProperty("evil");
  });

  it("does not invent a phone when the record has none", async () => {
    await write({ "ON-01": "Synthetic Tester" });
    expect((await resolve())?.prefill).not.toHaveProperty("ON-06.n");
  });
});
