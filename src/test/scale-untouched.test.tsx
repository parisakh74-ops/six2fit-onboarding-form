import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scale } from "@/components/onboarding/fields";
import { STEPS, validate } from "@/components/onboarding/steps";
import { isActive } from "@/lib/onboarding/data";

afterEach(cleanup);

const HINT = /برای ثبت پاسخ/;

describe("Scale: untouched state is explicit", () => {
  it("shows no value, announces 'not selected', explains the control and stores nothing on render", () => {
    const onChange = vi.fn();
    render(<Scale onChange={onChange} lo="بدون استرس" hi="بسیار زیاد" />);
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe("انتخاب نشده");
    expect(slider.getAttribute("data-untouched")).toBe("true");
    expect(screen.getByText("–")).toBeTruthy(); // the readout is a dash, not 5
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports the number the person chooses and drops the untouched cue", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Scale onChange={onChange} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(7);
    rerender(<Scale value={7} onChange={onChange} />);
    const slider = screen.getByRole("slider");
    expect(slider.hasAttribute("aria-valuetext")).toBe(false);
    expect(slider.hasAttribute("data-untouched")).toBe(false);
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.getByText((7).toLocaleString("fa"))).toBeTruthy(); // displayed value equals the stored value
  });

  it("treats an explicit 0 as an answer (not as untouched)", () => {
    render(<Scale value={0} onChange={vi.fn()} />);
    expect(screen.getByRole("slider").hasAttribute("data-untouched")).toBe(false);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("clicking the bar records the value under the thumb", () => {
    const onChange = vi.fn();
    render(<Scale onChange={onChange} />);
    fireEvent.click(screen.getByRole("slider"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(5);
  });
});

describe("stress question stays required until answered (client validation unchanged)", () => {
  const lifestyleErrors = (answers: Record<string, unknown>) => {
    const step = STEPS.find((s) => s.id === "lifestyle");
    if (!step) throw new Error("Missing lifestyle step");
    return validate(step, answers, (key) => isActive(key, answers, "Combo"), {});
  };

  it("requires an explicit answer and accepts 0 to 10", () => {
    expect(lifestyleErrors({})).toHaveProperty("ON-18");
    expect(lifestyleErrors({ "ON-18": 0 })).not.toHaveProperty("ON-18");
    expect(lifestyleErrors({ "ON-18": 10 })).not.toHaveProperty("ON-18");
  });
});
