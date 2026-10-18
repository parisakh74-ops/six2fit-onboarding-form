import { describe, expect, it } from "vitest";
import { STEPS, validate } from "@/components/onboarding/steps";
import { isActive } from "@/lib/onboarding/data";

// Step 1 phone validation as the person experiences it after the Consultation prefill is applied.
function personalErrors(answers: Record<string, unknown>) {
  const personal = STEPS.find((step) => step.id === "personal");
  if (!personal) throw new Error("Missing personal step");
  return validate(personal, answers, (key) => isActive(key, answers, "Combo"), {});
}

describe("prefilled phone passes the national-number validation", () => {
  it("accepts the national number produced from a Consultation E.164 value", () => {
    const errors = personalErrors({ "ON-06.iso": "CA", "ON-06.cc": "+1", "ON-06.n": "4165550100" });
    expect(errors).not.toHaveProperty("ON-06.n");
    expect(errors).not.toHaveProperty("ON-06.cc");
  });

  it("still rejects an E.164 value in the national field (guards the conversion at the bootstrap boundary)", () => {
    expect(personalErrors({ "ON-06.cc": "+1", "ON-06.n": "+14165550100" })).toHaveProperty("ON-06.n");
  });

  it("still requires the number and the dial code when nothing is prefilled", () => {
    const errors = personalErrors({});
    expect(errors).toHaveProperty("ON-06.cc");
    expect(errors).toHaveProperty("ON-06.n");
  });
});
