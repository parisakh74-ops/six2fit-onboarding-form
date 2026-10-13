// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LABELS, OPTS } from "@/lib/onboarding/data";
import { FILE_KEYS, specFor } from "./fields";

/** Keys with a label that the form never submits as an answer. */
const NEVER_SENT = new Set(["MS-01"]);

describe("answer key catalogue", () => {
  it("covers every key the frontend can submit (all labelled keys, per-option sub-keys and the file keys)", () => {
    const missing = Object.keys(LABELS).filter((k) => !NEVER_SENT.has(k) && !specFor(k));
    expect(missing).toEqual([]);
    for (const [o] of OPTS["NU-15"]!.filter((x) => x[0] !== "none")) expect(specFor(`NU-15.freq.${o}`)).toBeDefined();
    for (const [o] of OPTS["HL-04"]!.filter((x) => x[0] !== "none")) {
      expect(specFor(`HL-04.${o}.name`)).toBeDefined();
      expect(specFor(`HL-04.${o}.dose`)).toBeDefined();
    }
    for (const k of Object.keys(FILE_KEYS)) expect(specFor(k)?.t).toBe("file");
  });

  it("enum catalogues are exactly the frontend option values", () => {
    for (const k of ["ON-11", "TR-03", "TR-04", "NU-13", "HL-03b", "ON-21"]) {
      const spec = specFor(k);
      expect(spec?.t).toBe("enum");
      if (spec?.t === "enum") expect([...spec.opts]).toEqual(OPTS[k]!.map((o) => o[0]));
    }
  });

  it("rejects keys outside the form", () => {
    for (const k of ["", "ON-99", "NU-15.freq.none", "NU-15.freq.zzz", "HL-04.none.name", "HL-04.hormonal.other", "constructor", "__proto__", "MS-05.top"]) expect(specFor(k), k).toBeUndefined();
  });
});
