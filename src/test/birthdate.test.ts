import { describe, it, expect } from "vitest";
import { ageOn, daysInMonth } from "@/components/onboarding/fields";
describe("birth date", () => {
  it("Feb has 29 days in leap years only", () => { expect(daysInMonth(2024, 2)).toBe(29); expect(daysInMonth(2023, 2)).toBe(28); expect(daysInMonth(1900, 2)).toBe(28); });
  it("age is calendar-exact", () => { const now = new Date(2026, 9, 10); expect(ageOn("2012-10-10", now)).toBe(14); expect(ageOn("2012-10-11", now)).toBe(13); });
  it("rejects impossible dates", () => { expect(ageOn("2023-02-29")).toBeNaN(); });
});
