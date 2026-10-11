import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STEPS, validate, type Ctx } from "@/components/onboarding/steps";
import { FileDrop } from "@/components/onboarding/fields";
import { isActive, LABELS } from "@/lib/onboarding/data";

vi.mock("@/components/onboarding/shell", () => ({
  GhostButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

afterEach(cleanup);

function context(answers: Ctx["a"]): Ctx {
  return { a: answers, set: vi.fn(), e: {}, on: (key) => isActive(key, answers, "Combo"), pf: () => undefined, fileErr: vi.fn() };
}

describe("meal routines and optional body photos", () => {
  it("shows five independent meal fields with routine-food examples", () => {
    const step = STEPS.find((s) => s.id === "nutrition");
    if (!step) throw new Error("Missing nutrition step");
    const c = context({});
    const { container } = render(step.render(c));
    const question = container.querySelector("#q-NU-06");
    expect(question).toHaveTextContent("معمولاً در هر وعده چه غذاهایی می‌خورید؟");
    expect(question).toHaveTextContent("۵ تا ۱۰ غذایی");
    expect(question?.querySelectorAll("textarea")).toHaveLength(5);
    fireEvent.change(screen.getByPlaceholderText("املت، تخم‌مرغ آب‌پز، نان و پنیر، اوتمیل، کیک و چای"), { target: { value: "نان و پنیر، عدسی" } });
    expect(c.set).toHaveBeenCalledWith("NU-06.breakfast", "نان و پنیر، عدسی");
  });

  it("gates all four independent photos and allows continuing without them", () => {
    const step = STEPS.find((s) => s.id === "measures");
    if (!step) throw new Error("Missing measures step");
    const c = context({ "MS-02": "80", "MS-03": "95" });
    const { container, rerender } = render(step.render(c));
    expect(container.querySelector("#q-MS-04")?.querySelectorAll('input[type="file"]')).toHaveLength(4);
    expect(screen.getByText("پهلو در حالت خنثی: برای مشاهدهٔ وضعیت شانه‌ها")).toBeInTheDocument();
    expect(screen.getByText("پهلو با دست‌ها رو به جلو: برای مشاهدهٔ وضعیت لگن و کمر")).toBeInTheDocument();
    for (const [index, key] of ["front", "back", "side", "side_forward"].entries()) {
      const input = container.querySelector("#q-MS-04")?.querySelectorAll('input[type="file"]')[index];
      if (!input) throw new Error("Missing photo input");
      expect(input).toHaveAttribute("accept", ".jpg,.jpeg,.png");
      fireEvent.change(input, { target: { files: [new File(["photo"], `${key}.jpg`, { type: "image/jpeg" })] } });
      expect(c.set).toHaveBeenCalledWith(`MS-05.${key}`, expect.objectContaining({ name: `${key}.jpg` }));
      expect(LABELS[`MS-05.${key}`]).toBeTruthy();
    }
    expect(validate(step, c.a, c.on, {})).toHaveProperty("MS-04");
    const withPhoto = { ...c.a, "MS-05.front": { name: "f.jpg" } };
    expect(validate(step, withPhoto, (k) => isActive(k, withPhoto, "Combo"), {})).toEqual({});
    const declined = { ...c.a, "MS-04": "no", "MS-04.ack": true };
    expect(Object.keys(validate(step, declined, (k) => isActive(k, declined, "Combo"), {}))).toHaveLength(8);
    const no = context({ "MS-04": "no" });
    rerender(step.render(no));
    expect(container.querySelector("#q-MS-04")?.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(isActive("MS-05.side_forward", no.a, "Combo")).toBe(false);
  });

  it("rejects unsupported formats and photos over 20 MB", () => {
    const error = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<FileDrop accept=".jpg,.jpeg,.png" maxMB={20} onChange={onChange} error={error} />);
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("Missing input");
    fireEvent.change(input, { target: { files: [new File(["x"], "photo.pdf")] } });
    expect(error).toHaveBeenCalledWith("فرمت فایل مجاز نیست.");
    const large = new File(["x"], "photo.png");
    Object.defineProperty(large, "size", { value: 20 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [large] } });
    expect(error).toHaveBeenCalledWith("حجم فایل باید کمتر از ۲۰ مگابایت باشد.");
    expect(onChange).not.toHaveBeenCalled();
  });
});