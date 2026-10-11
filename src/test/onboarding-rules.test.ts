import { describe, it, expect } from "vitest";
import { searchCountries, searchDial, capWords, COUNTRY_LIST } from "@/lib/onboarding/countries";
import { normalizeNumber, normalizeTime } from "@/components/onboarding/fields";
import { isActive, OPTS } from "@/lib/onboarding/data";

describe("onboarding rules", () => {
  it("lists USA, Canada, Iran first", () => expect(COUNTRY_LIST.slice(0, 3).map((c) => c.iso)).toEqual(["US", "CA", "IR"]));
  it("searches countries by Persian, English, abbreviation and dial code", () => {
    expect(searchCountries("uk")[0]!.iso).toBe("GB");
    expect(searchCountries("ای")[0]!.iso).toBe("IR");
    expect(searchCountries("Ir")[0]!.iso).toBe("IR");
    expect(searchCountries("98")[0]!.iso).toBe("IR");
  });
  it("dial search '9' puts codes starting with 9 first", () => expect(searchDial("9").every((c) => c.dial.startsWith("9"))).toBe(true));
  it("+1 resolves to distinct US and Canada", () => expect(searchDial("1").slice(0, 2).map((c) => c.iso)).toEqual(["US", "CA"]));
  it("capitalises English words", () => expect(capWords("los angeles")).toBe("Los Angeles"));
  it("stores Persian digits as English", () => expect(normalizeNumber("۱۸۱")).toBe("181"));
  it("formats 24h time", () => expect(normalizeTime("۰۶۳۰")).toBe("06:30"));
  it("shows equipment for home and home gym only", () => {
    expect(isActive("TR-06", { "TR-05": "homegym" }, "Combo")).toBe(true);
    expect(isActive("TR-06", { "TR-05": "gym_full" }, "Combo")).toBe(false);
  });
  it("asks the no-photo acknowledgement only when photos are declined", () => {
    expect(isActive("MS-04.ack", { "MS-04": "no" }, "Combo")).toBe(true);
    expect(isActive("MS-04.ack", {}, "Combo")).toBe(false);
  });
  it("asks extra measurements only after declining photos and confirming", () => {
    expect(isActive("MS-07.neck", { "MS-04": "no", "MS-04.ack": true }, "Combo")).toBe(true);
    expect(isActive("MS-07.neck", { "MS-04": "no" }, "Combo")).toBe(false);
    expect(isActive("MS-07.neck", {}, "Combo")).toBe(false);
  });
  it("offers eggplant sensitivity", () => expect(OPTS["NU-03"]!.some((o) => o[1] === "حساسیت یا عدم تحمل بادمجان")).toBe(true));
  it("training days are 3, 4, 5, 6+", () => expect(OPTS["TR-03"]!.map((o) => o[0])).toEqual(["3", "4", "5", "6+"]));
});
