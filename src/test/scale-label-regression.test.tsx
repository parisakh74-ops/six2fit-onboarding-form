import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scale } from "@/components/onboarding/fields";
import { STEPS, type Ctx } from "@/components/onboarding/steps";
import { isActive, type Answers } from "@/lib/onboarding/data";

afterEach(cleanup);

// Renders a real step with a spy for `set`, so the markup that production uses is what is clicked.
function renderStep(id: string, answers: Answers, errors: Record<string, string> = {}) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Missing step ${id}`);
  const set = vi.fn();
  const ctx: Ctx = {
    a: answers,
    set,
    e: errors,
    on: (k) => isActive(k, answers, "Combo"),
    pf: () => undefined,
    fileErr: vi.fn(),
  };
  render(<>{step.render(ctx)}</>);
  return set;
}

const painAnswers: Answers = { "TR-08": "yes", "TR-08.location": "knee" };
const recorded = (set: ReturnType<typeof vi.fn>, key: string) =>
  set.mock.calls.filter(([k]) => k === key);

describe("pain severity (TR-08.severity): text is not interactive, the slider is", () => {
  it("does not record an answer when the caption, an end label or the instruction text is clicked", () => {
    const set = renderStep("training", painAnswers);
    for (const text of [/شدت درد/, "بدون درد", "شدیدترین", /برای ثبت پاسخ/])
      fireEvent.click(screen.getByText(text));
    expect(recorded(set, "TR-08.severity")).toHaveLength(0);
  });

  it("is not wrapped in a <label> (the cause of the silent default)", () => {
    renderStep("training", painAnswers);
    const slider = screen.getByRole("slider");
    expect(slider.closest("label")).toBeNull();
    expect(screen.getByText(/برای ثبت پاسخ/).closest("label")).toBeNull();
  });

  it("records the number when the slider is moved or its track is clicked", () => {
    const set = renderStep("training", painAnswers);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "7" } });
    expect(recorded(set, "TR-08.severity")).toEqual([["TR-08.severity", 7]]);
    fireEvent.click(slider);
    expect(recorded(set, "TR-08.severity").length).toBeGreaterThanOrEqual(2); // explicit interaction is recorded
  });

  it("keeps an accessible name, the untouched state and the instruction link for assistive technology", () => {
    renderStep("training", painAnswers);
    const slider = screen.getByRole("slider", { name: /شدت درد/ });
    expect(slider.getAttribute("aria-valuetext")).toBe("انتخاب نشده");
    expect(slider.getAttribute("data-untouched")).toBe("true");
    expect(slider.hasAttribute("tabindex")).toBe(false); // natively focusable: keyboard users reach it
    const hint = document.getElementById(slider.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/برای ثبت پاسخ/);
  });

  it("drops the untouched cue once answered, and shows the required error outside any label", () => {
    renderStep("training", { ...painAnswers, "TR-08.severity": 4 });
    const slider = screen.getByRole("slider", { name: /شدت درد/ });
    expect(slider.hasAttribute("data-untouched")).toBe(false);
    expect(slider.hasAttribute("aria-valuetext")).toBe(false);
    expect(slider.hasAttribute("aria-describedby")).toBe(false);
    cleanup();
    renderStep("training", painAnswers, { "TR-08.severity": "لطفاً این مورد را تکمیل کنید." });
    const alert = screen.getByRole("alert", { name: "" });
    expect(alert.textContent).toBe("لطفاً این مورد را تکمیل کنید.");
    expect(alert.closest("label")).toBeNull();
  });
});

describe("stress (ON-18): same behaviour", () => {
  it("does not record an answer when an end label or the instruction text is clicked", () => {
    const set = renderStep("lifestyle", {});
    for (const text of ["بدون استرس", "بسیار زیاد", /برای ثبت پاسخ/])
      fireEvent.click(screen.getByText(text));
    expect(recorded(set, "ON-18")).toHaveLength(0);
  });

  it("records the number when the slider is moved and has the question as its accessible name", () => {
    const set = renderStep("lifestyle", {});
    const slider = screen.getByRole("slider", { name: /سطح استرس/ });
    expect(slider.getAttribute("data-untouched")).toBe("true");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(recorded(set, "ON-18")).toEqual([["ON-18", 3]]);
  });
});

describe("Scale on its own", () => {
  it("passes labelledBy to the slider and leaves it unnamed when none is given", () => {
    render(
      <>
        <span id="cap">سؤال</span>
        <Scale onChange={vi.fn()} labelledBy="cap" />
      </>,
    );
    expect(screen.getByRole("slider", { name: "سؤال" })).toBeTruthy();
    cleanup();
    render(<Scale onChange={vi.fn()} />);
    expect(screen.getByRole("slider").hasAttribute("aria-labelledby")).toBe(false);
  });
});
