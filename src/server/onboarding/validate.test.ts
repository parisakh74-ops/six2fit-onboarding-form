// @vitest-environment node
import { describe, expect, it } from "vitest";
import { STEPS, validate as clientValidate } from "@/components/onboarding/steps";
import { isActive, type Answers, type Scope } from "@/lib/onboarding/data";
import { PDF_HEAD, PNG_HEAD, jpegFile, validAnswers } from "./fixtures";
import { sniffMime, validateSubmission, type FileInput } from "./validate";

const NOW = new Date(2026, 9, 13, 12, 0, 0);
const run = (answers: Record<string, string>, scope: Scope = "Combo", files: Record<string, FileInput> = {}, entitlements: string[] = []) =>
  validateSubmission(answers, files, { scope, entitlements, now: NOW });
const codes = (r: ReturnType<typeof run>): string[] => (r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`));

describe("server validation: complete submissions", () => {
  it.each(["Combo", "Diet", "Training", "CIP"] as Scope[])("accepts a complete %s submission and types every answer", (scope) => {
    const r = run(validAnswers(scope), scope);
    expect(codes(r)).toEqual([]);
    if (r.ok) {
      expect(r.answers["ON-08"]).toBe(178);
      expect(r.answers["ON-18"]).toBe(4);
      if (scope !== "Training") expect(r.answers["NU-19"]).toEqual(["time"] as never);
      expect(r.answers["MS-04.ack"]).toBe(true);
    }
  });

  it("normalises Persian digits and keeps long Persian text intact", () => {
    const long = "غذا ".repeat(400).trim(); // 1,599 code points
    const r = run(validAnswers("Combo", { "ON-08": "۱۷۸", "ON-09.kg": "۸۲٫۵".replace("٫", "."), "NU-06.lunch": long }));
    expect(codes(r)).toEqual([]);
    if (r.ok) {
      expect(r.answers["ON-08"]).toBe(178);
      expect(r.answers["ON-09.kg"]).toBe(82.5);
      expect(r.answers["NU-06.lunch"]).toBe(long);
    }
  });

  it("measures: a submission with photos instead of the supplementary measurements is accepted", () => {
    const a = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    expect(codes(run(a, "Combo", { "MS-05.front": jpegFile() }))).toEqual([]);
  });
});

describe("server validation: rejects what the browser must never send", () => {
  it("unknown, internal and mass-assignment keys", () => {
    for (const k of ["is_admin", "__entitlements", "ON-99", "NU-15.freq.none", "HL-04.none.name", "MS-01", "x".repeat(100)]) {
      expect(codes(run({ ...validAnswers(), [k]: "1" }))).toContain(`${k.slice(0, 60)}:UNKNOWN_FIELD`);
    }
  });

  it("answers for the wrong scope are conditional-integrity violations (NU- in Training, TR- in Diet)", () => {
    expect(codes(run({ ...validAnswers("Training"), "NU-01": "omni" }, "Training"))).toContain("NU-01:INACTIVE_FIELD");
    expect(codes(run({ ...validAnswers("Diet"), "TR-01": "basic" }, "Diet"))).toContain("TR-01:INACTIVE_FIELD");
  });

  it("answers whose parent condition is not met are inactive", () => {
    expect(codes(run(validAnswers("Combo", { "ON-12.kg": "70", "ON-11": "muscle" })))).toContain("ON-12.kg:INACTIVE_FIELD");
    expect(codes(run(validAnswers("Combo", { "HL-03b": "0-6" })))).toContain("HL-03b:INACTIVE_FIELD"); // male
    expect(codes(run(validAnswers("Combo", { "ON-21": "regular" })))).toContain("ON-21:INACTIVE_FIELD"); // male
    expect(codes(run(validAnswers("Combo", { "NU-08.start": "08:00" })))).toContain("NU-08.start:INACTIVE_FIELD");
    expect(codes(run(validAnswers("Combo", { "TR-06": ["dumbbell"] })))).toContain("TR-06:INACTIVE_FIELD"); // full gym
    expect(codes(run(validAnswers("Combo", { "MS-06.consent": true })))).toContain("MS-06.consent:INACTIVE_FIELD"); // no add-on
  });

  it("add-on answers need the signed entitlement, never a browser claim", () => {
    const a = validAnswers("Combo", { "MS-06.consent": true });
    expect(codes(run(a))).toContain("MS-06.consent:INACTIVE_FIELD");
    expect(codes(run(a, "Combo", {}, ["cellulite"]))).toEqual([]);
  });

  it("invalid options, types, ranges, formats and lengths", () => {
    const bad: Record<string, string> = {
      "ON-03": "other", "ON-08": "99", "ON-09.kg": "abc", "ON-02": "2031-01-01", "ON-07": "not-an-email", "ON-06.n": "12", "ON-15.wake": "25:00",
      "ON-18": "11", "NU-19": JSON.stringify(["time", "cook", "family", "social"]), "HL-02": JSON.stringify(["diabetes", "none"]), "ON-04": "ZZ", "CN-01": "false",
    };
    for (const [k, v] of Object.entries(bad)) {
      const r = run(validAnswers("Combo", { [k]: v }));
      expect(r.ok, k).toBe(false);
      expect(codes(r).some((c) => c.startsWith(`${k}:`)), k).toBe(true);
    }
    expect(codes(run(validAnswers("Combo", { "ON-01": "x".repeat(256) })))).toContain("ON-01:TOO_LONG");
    expect(codes(run(validAnswers("Combo", { "ON-07": `${"a".repeat(95)}@example.test` })))).toContain("ON-07:TOO_LONG"); // CRM Email is 100 chars
    expect(codes(run(validAnswers("Combo", { "NU-04": "y".repeat(2001) })))).toContain("NU-04:TOO_LONG");
    expect(codes(run(validAnswers("Combo", { "ON-01": "bad\u0000name" })))).toContain("ON-01:INVALID_CHARACTERS");
    expect(codes(run(validAnswers("Combo", { "ON-06.cc": "+1" })))).toContain("ON-06.cc:INCONSISTENT"); // Iran is +98
  });

  it("phone is normalised without a leading zero", () => {
    const r = run(validAnswers("Combo", { "ON-06.n": "0912 123-4567" }));
    expect(r.ok && r.answers["ON-06.n"]).toBe("9121234567");
  });

  it("an age outside 14-100 is rejected", () => {
    expect(codes(run(validAnswers("Combo", { "ON-02": "2020-01-01" })))).toContain("ON-02:OUT_OF_RANGE");
    expect(codes(run(validAnswers("Combo", { "ON-02": "1900-01-01" })))).toContain("ON-02:OUT_OF_RANGE");
    expect(codes(run(validAnswers("Combo", { "ON-02": "1990-02-30" })))).toContain("ON-02:INVALID_DATE");
  });

  it("the consents are mandatory (health consent only when health answers exist)", () => {
    expect(codes(run(validAnswers("Combo", { "CN-01": undefined })))).toContain("CN-01:REQUIRED");
    expect(codes(run(validAnswers("Combo", { "CN-03": undefined })))).toContain("CN-03:REQUIRED");
    expect(codes(run(validAnswers("Combo", { "HL-05": "regular", "HL-05.name": "x", "HL-05.dose": "1", "HL-05.time": "am", "HL-05.reason": "r" })))).toContain("CN-02:REQUIRED");
  });
});

describe("server validation: files", () => {
  it("sniffs real content, not the declared type", () => {
    expect(sniffMime(PNG_HEAD)).toBe("image/png");
    expect(sniffMime(PDF_HEAD)).toBe("application/pdf");
    expect(sniffMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  const photos = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });

  it("rejects a declared type that does not match the content, executable content and oversize files", () => {
    const fake: FileInput = { name: "a.jpg", type: "image/jpeg", size: 100, head: new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) };
    expect(codes(run(photos, "Combo", { "MS-05.front": fake }))).toContain("MS-05.front:FILE_TYPE");
    const lie: FileInput = { name: "a.png", type: "image/png", size: 100, head: PDF_HEAD };
    expect(codes(run(photos, "Combo", { "MS-05.front": lie }))).toContain("MS-05.front:FILE_TYPE");
    const big = { ...jpegFile(), size: 21 * 1024 * 1024 };
    expect(codes(run(photos, "Combo", { "MS-05.front": big }))).toContain("MS-05.front:FILE_TOO_LARGE");
  });

  it("accepts a PDF only where the form allows it (HL-09) and rejects unknown file keys and files sent as answers", () => {
    const pdf: FileInput = { name: "report.pdf", type: "application/pdf", size: 500, head: PDF_HEAD };
    const withHealth = validAnswers("Combo", { "HL-02": ["diabetes"], "CN-02": true });
    expect(codes(run(withHealth, "Combo", { "HL-09": pdf }))).toEqual([]);
    expect(codes(run(photos, "Combo", { "MS-05.front": pdf }))).toContain("MS-05.front:FILE_TYPE");
    expect(codes(run(photos, "Combo", { "evil.exe": jpegFile() }))).toContain("evil.exe:UNKNOWN_FIELD");
    expect(codes(run({ ...photos, "MS-05.front": "[object Object]" }))).toContain("MS-05.front:FILE_AS_ANSWER");
  });

  it("photos are inactive when the person declined them", () => {
    expect(codes(run(validAnswers(), "Combo", { "MS-05.front": jpegFile() }))).toContain("MS-05.front:INACTIVE_FIELD");
  });

  it("file names are sanitised", () => {
    const f = { ...jpegFile("../../etc/pass\u0000wd?.jpg") };
    const r = run(photos, "Combo", { "MS-05.front": f });
    expect(r.ok && r.files[0]?.name).toMatch(/^[\p{L}\p{N}._ -]+$/u);
  });
});

describe("parity with the frontend validation (required fields)", () => {
  const stepFor = (key: string) => STEPS.find((s) => s.keys.test(key));

  function variants(): Array<{ name: string; scope: Scope; ans: Record<string, string> }> {
    return [
      { name: "combo-male", scope: "Combo", ans: validAnswers("Combo") },
      { name: "diet", scope: "Diet", ans: validAnswers("Diet") },
      { name: "training", scope: "Training", ans: validAnswers("Training") },
      {
        name: "female-pregnant-meds",
        scope: "Combo",
        ans: validAnswers("Combo", {
          "ON-03": "female", "ON-21": "regular", "HL-03a": "pregnant", "ON-10": "60", "HL-04": ["hormonal"], "HL-04.hormonal.name": "x", "HL-04.hormonal.dose": "1", "HL-02": ["thyroid"],
          "CN-02": true, "NU-02": "yes", "NU-03": ["lactose"], "NU-15": ["bloat"], "NU-15.freq.bloat": "daily", "TR-05": "home", "TR-06": ["dumbbell"], "TR-07": "yes", "TR-07.location": "knee", "TR-07.type": "t", "TR-07.clinician": "c",
          "TR-08": "yes", "TR-08.location": "back", "TR-08.severity": 3, "TR-08.onset": "1m", "TR-08.effect": "e", "ON-19": "yes", "ON-19.detail": "x", "ON-20": "rare", "ON-20.detail": "y", "NU-08": "yes_choice", "NU-08.start": "10:00", "NU-08.end": "18:00",
          "NU-11": "yes", "NU-11.detail": "d", "NU-01": "other", "NU-01.other": "o", "HL-05": "regular", "HL-05.name": "n", "HL-05.dose": "d", "HL-05.time": "t", "HL-05.reason": "r", "HL-08": "yes", "HL-08.type": "t", "HL-08.area": "a", "HL-08.when": "w", "ON-027": "yes", "ON-027.name": "Sara",
        }),
      },
    ];
  }

  it("every key the client requires is also required by the server, and the server requires nothing more", () => {
    for (const v of variants()) {
      expect(codes(run(v.ans, v.scope)), `${v.name} base`).toEqual([]);
      const typed: Answers = { __entitlements: [] };
      for (const [k, val] of Object.entries(v.ans)) typed[k] = k === "NU-15" || k === "HL-04" || k === "HL-02" || k === "NU-19" || k === "NU-03" || k === "TR-06" || k === "HL-07" ? JSON.parse(val) : val === "true" ? true : /^\d+$/.test(val) && (k === "ON-18" || k === "TR-08.severity") ? Number(val) : val;
      const steps = STEPS.filter((s) => s.show(v.scope));
      const on = (k: string) => isActive(k, typed, v.scope);
      // Server must require each key that the client requires: drop it and look for REQUIRED.
      for (const step of steps) {
        const required = step.checks(typed).filter((c) => on(c.k) && !c.optional).map((c) => c.k);
        for (const key of required) {
          if (typed[key] === undefined) continue; // not part of this variant's answers
          const without = { ...v.ans };
          delete without[key];
          const sv = codes(run(without, v.scope));
          expect(sv.some((c) => c.startsWith(`${key}:`)), `${v.name}: server must flag missing ${key}`).toBe(true);
          const t2 = { ...typed };
          delete t2[key];
          const client = clientValidate(step, t2, (k) => isActive(k, t2, v.scope), {});
          expect(Object.keys(client), `${v.name}: client must flag missing ${key}`).toContain(key);
          void stepFor;
        }
      }
    }
  });
});
