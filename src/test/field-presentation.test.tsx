import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialSelect } from "@/components/onboarding/fields";
import { STEPS, validate } from "@/components/onboarding/steps";
import { isActive } from "@/lib/onboarding/data";

afterEach(cleanup);

describe("country code selection and preserved validation", () => {
  it("does not select a country until the user chooses one", () => {
    const onChange = vi.fn();
    render(<DialSelect onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /کانادا/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ iso: "CA", dial: "1" }));
  });

  it("still rejects missing required fields without requiring optional referral contact", () => {
    const personal = STEPS.find((step) => step.id === "personal");
    if (!personal) throw new Error("Missing personal step");
    const answers = { "ON-027": "yes" };
    const errors = validate(personal, answers, (key) => isActive(key, answers, "Combo"), {});
    expect(errors).toHaveProperty("ON-01");
    expect(errors).toHaveProperty("ON-06.n");
    expect(errors).not.toHaveProperty("ON-027.phone");
  });
});