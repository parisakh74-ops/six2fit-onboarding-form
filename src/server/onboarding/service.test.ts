// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "./errors";
import { FileOnboardingStore, LocalFileSink } from "./file-store";
import { CONSULT_ID, NOW_MS, SECRET, consultToken, dealToken, jpegFile, validAnswers } from "./fixtures";
import type { OnboardingStore, StoredRef, SubjectDirectory, SubmissionRecord } from "./ports";
import { createOnboardingService, type SubmitInput } from "./service";
import { signLinkToken } from "./tokens";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-onb-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class Directory implements SubjectDirectory {
  calls = 0;
  constructor(private readonly mode: "ok" | "missing" | "unavailable" | "unconfigured" = "ok", private readonly prefill: Record<string, unknown> = { "ON-01": "Ali Rezaei", "ON-07": "ali.rezaei@example.test" }) {}
  async resolve() {
    this.calls += 1;
    if (this.mode === "missing") return null;
    if (this.mode === "unavailable") throw new StoreError("UNAVAILABLE", "x", "FILE_IO");
    if (this.mode === "unconfigured") throw new StoreError("NOT_CONFIGURED", "x", "IDENTITY_UNAVAILABLE");
    return { prefill: this.prefill };
  }
}

function make(over: { store?: OnboardingStore; directory?: SubjectDirectory; logs?: Array<Record<string, unknown>> } = {}) {
  const logs = over.logs ?? [];
  const service = createOnboardingService({
    store: over.store ?? new FileOnboardingStore(dir),
    directory: over.directory ?? new Directory(),
    sink: new LocalFileSink(dir),
    secret: SECRET,
    acceptConsultHandoff: true,
    now: () => NOW_MS,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  return { service, logs };
}

const input = (over: Partial<SubmitInput> = {}, scope: "Combo" | "Diet" | "Training" | "CIP" = "Combo"): SubmitInput => {
  const id = over.submissionId ?? "11111111-2222-4333-8444-555555555555";
  return {
    token: dealToken({ scope }),
    submissionId: id,
    idempotencyKey: id,
    answers: validAnswers(scope),
    verificationState: JSON.stringify({ "ON-01": "confirmed", "ON-07": "edited" }),
    files: {},
    ...over,
  };
};

describe("bootstrap", () => {
  it("returns scope and entitlements from the signed link, and only the resolved prefill", async () => {
    const { service } = make();
    const r = await service.bootstrap(dealToken({ scope: "CIP", entitlements: ["cellulite"] }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: "CIP", entitlements: ["cellulite"], prefill: { "ON-01": "Ali Rezaei" } });
    expect(typeof r.body["expires_at"]).toBe("string");
    expect(r.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  });

  it("answers 401 for malformed, tampered, expired and wrong-secret links, without touching the directory", async () => {
    const dir0 = new Directory();
    const { service } = make({ directory: dir0 });
    const good = dealToken();
    for (const t of ["", "garbage", `${good}x`, dealToken({ exp: Math.floor(NOW_MS / 1000) - 5 }), dealToken({}, "another-secret-another-secret-another!!")]) {
      expect((await service.bootstrap(t)).status).toBe(401);
    }
    expect(dir0.calls).toBe(0);
  });

  it("404 when the subject cannot be found, 503 (fail closed) when the resolver is unavailable or not configured", async () => {
    expect((await make({ directory: new Directory("missing") }).service.bootstrap(dealToken())).status).toBe(404);
    expect((await make({ directory: new Directory("unavailable") }).service.bootstrap(dealToken())).status).toBe(503);
    const r = await make({ directory: new Directory("unconfigured") }).service.bootstrap(dealToken());
    expect(r.status).toBe(503);
    expect(r.body["error_code"]).toBe("IDENTITY_UNAVAILABLE");
  });

  it("does not leak token or answers into logs", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { service } = make({ logs });
    await service.bootstrap(`${dealToken()}x`);
    await service.bootstrap(dealToken());
    expect(JSON.stringify(logs)).not.toMatch(/link_0123|Rezaei|example\.test|synthetic-onboarding/);
  });
});

describe("submit: contract and validation", () => {
  it("creates once and answers the unchanged success contract", async () => {
    const { service } = make();
    const r = await service.submit(input());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "completed", submission_id: "11111111-2222-4333-8444-555555555555", deduplicated: false });
  });

  it("rejects a missing or different Idempotency-Key and a malformed submission id", async () => {
    const { service } = make();
    expect((await service.submit(input({ idempotencyKey: null }))).status).toBe(400);
    expect((await service.submit(input({ idempotencyKey: "00000000-0000-4000-8000-000000000000" }))).status).toBe(400);
    expect((await service.submit(input({ submissionId: "x", idempotencyKey: "x" }))).status).toBe(400);
  });

  it("401 for invalid or expired links; nothing is stored", async () => {
    const { service } = make();
    expect((await service.submit(input({ token: `${dealToken()}x` }))).status).toBe(401);
    expect((await service.submit(input({ token: dealToken({ exp: Math.floor(NOW_MS / 1000) - 1 }) }))).status).toBe(401);
    await expect(readdir(join(dir, "onboarding-v2"))).rejects.toThrow();
  });

  it("422 with field paths and codes only (never values) for an invalid payload; nothing is stored", async () => {
    const { service } = make();
    const r = await service.submit(input({ answers: validAnswers("Combo", { "ON-07": "not-an-email", "ON-08": undefined }) }));
    expect(r.status).toBe(422);
    expect(r.body["error_code"]).toBe("INVALID_PAYLOAD");
    expect(JSON.stringify(r.body)).not.toMatch(/not-an-email/);
    expect(r.body["issues"]).toEqual(expect.arrayContaining([{ path: "ON-07", code: "INVALID_EMAIL" }, { path: "ON-08", code: "REQUIRED" }]));
    await expect(readdir(join(dir, "onboarding-v2"))).rejects.toThrow();
  });

  it("scope comes from the signed link: a Diet link refuses training answers", async () => {
    const { service } = make();
    const r = await service.submit(input({ token: dealToken({ scope: "Diet" }), answers: validAnswers("Combo") }));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body["issues"])).toContain("TR-01");
  });

  it("verification state may only name prefilled fields with a known state", async () => {
    const { service } = make();
    for (const v of ['{"ON-08":"confirmed"}', '{"ON-01":"hacked"}', "[1]", "not json"]) {
      expect((await service.submit(input({ verificationState: v }))).status).toBe(400);
    }
    expect((await service.submit(input({ verificationState: "{}" }))).status).toBe(200);
  });

  it("503 when the subject cannot be resolved; 404 when it does not exist", async () => {
    expect((await make({ directory: new Directory("unavailable") }).service.submit(input())).status).toBe(503);
    expect((await make({ directory: new Directory("missing") }).service.submit(input())).status).toBe(404);
  });
});

describe("submit: idempotency, duplicates and concurrency", () => {
  it("a retry with the same answers (even with a NEW browser submission id) is deduplicated", async () => {
    const { service } = make();
    expect((await service.submit(input())).body["deduplicated"]).toBe(false);
    const retry = await service.submit(input({ submissionId: "99999999-8888-4777-8666-555555555555" }));
    expect(retry.status).toBe(200);
    expect(retry.body["deduplicated"]).toBe(true);
  });

  it("the same link with different answers is a conflict (409), never a second record", async () => {
    const { service } = make();
    await service.submit(input());
    const r = await service.submit(input({ answers: validAnswers("Combo", { "ON-09.kg": "90" }) }));
    expect(r.status).toBe(409);
    expect(r.body["error_code"]).toBe("SUBMISSION_CONFLICT");
    expect(await readdir(join(dir, "onboarding-v2"))).toHaveLength(1);
  });

  it("eight simultaneous identical submissions create exactly one record", async () => {
    const { service } = make();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => service.submit(input({ submissionId: `aaaaaaaa-0000-4000-8000-00000000000${i}` }))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body["deduplicated"] === false)).toHaveLength(1);
    expect(await readdir(join(dir, "onboarding-v2"))).toHaveLength(1);
  });

  it("simultaneous conflicting submissions: one wins, the others get 409", async () => {
    const { service } = make();
    const rs = await Promise.all([0, 1, 2, 3].map((i) => service.submit(input({ submissionId: `bbbbbbbb-0000-4000-8000-00000000000${i}`, answers: validAnswers("Combo", { "ON-09.kg": String(80 + i) }) }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await readdir(join(dir, "onboarding-v2"))).toHaveLength(1);
  });

  it("a new process (new service and store objects, same storage) still deduplicates", async () => {
    await make().service.submit(input());
    const again = await make().service.submit(input({ submissionId: "cccccccc-0000-4000-8000-000000000000" }));
    expect(again.body["deduplicated"]).toBe(true);
  });

  it("a Consultation hand-off link is one onboarding per Consultation submission", async () => {
    const { service } = make();
    const a = await service.submit(input({ token: consultToken() }));
    const b = await service.submit(input({ token: consultToken({ exp: Math.floor(NOW_MS / 1000) + 5000 }), submissionId: "dddddddd-0000-4000-8000-000000000000" }));
    expect(a.body["deduplicated"]).toBe(false);
    expect(b.body["deduplicated"]).toBe(true);
    void CONSULT_ID;
  });
});

describe("submit: persistence failures are never reported as success", () => {
  class FailingStore implements OnboardingStore {
    constructor(private readonly error: StoreError) {}
    async get(): Promise<StoredRef | null> {
      return null;
    }
    async create(): Promise<never> {
      throw this.error;
    }
  }

  it("storage failure -> 503 STORAGE_UNAVAILABLE with a safe log code", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { service } = make({ store: new FailingStore(new StoreError("UNAVAILABLE", "x", "OUTCOME_UNKNOWN")), logs });
    const r = await service.submit(input());
    expect(r.status).toBe(503);
    expect(r.body["error_code"]).toBe("STORAGE_UNAVAILABLE");
    expect(logs.find((l) => l["event"] === "onboarding.storage_failure")).toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(JSON.stringify(logs)).not.toMatch(/Rezaei|example\.test/);
  });

  it("an integrity exception (duplicate CRM records) is a 503 with its own log event", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { service } = make({ store: new FailingStore(new StoreError("CORRUPT", "x", "DUPLICATE_RECORDS")), logs });
    expect((await service.submit(input())).status).toBe(503);
    expect(logs.some((l) => l["event"] === "onboarding.integrity_exception")).toBe(true);
  });
});

describe("submit: files and complete persistence", () => {
  it("stores the complete answers and each accepted file (content-addressed, private), and survives a retry", async () => {
    const { service } = make();
    const answers = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    const r = await service.submit(input({ answers, files: { "MS-05.front": jpegFile("front.jpg", 4096) } }));
    expect(r.status).toBe(200);
    const files = await readdir(join(dir, "uploads-v2"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^onb_[0-9a-f]{40}-MS-05\.front-[0-9a-f]{16}\.jpg$/);
    const stored = JSON.parse(await readFile(join(dir, "onboarding-v2", (await readdir(join(dir, "onboarding-v2")))[0] as string), "utf8")) as SubmissionRecord;
    expect(Object.keys(stored.answers).length).toBe(Object.keys(answers).length);
    expect(stored.files[0]).toMatchObject({ key: "MS-05.front", type: "image/jpeg", size: 4096 });
    expect((await service.submit(input({ answers, files: { "MS-05.front": jpegFile("front.jpg", 4096) }, submissionId: "eeeeeeee-0000-4000-8000-000000000000" }))).body["deduplicated"]).toBe(true);
  });

  it("the same answers with a different photo are a different submission (409)", async () => {
    const { service } = make();
    const answers = validAnswers("Combo", { "MS-04": undefined, "MS-04.ack": undefined, "MS-07.neck": undefined, "MS-07.shoulder": undefined, "MS-07.chest": undefined, "MS-07.arm_relaxed": undefined, "MS-07.arm_flexed": undefined, "MS-07.thigh": undefined, "MS-07.calf": undefined, "MS-07.wrist": undefined });
    await service.submit(input({ answers, files: { "MS-05.front": jpegFile("a.jpg", 2048) } }));
    const other = jpegFile("a.jpg", 2048);
    other.bytes[100] = 7;
    expect((await service.submit(input({ answers, files: { "MS-05.front": other } }))).status).toBe(409);
  });

  it("a signed link without the add-on cannot submit add-on answers", async () => {
    const { service } = make();
    const r = await service.submit(input({ answers: validAnswers("Combo", { "MS-06.consent": true }) }));
    expect(r.status).toBe(422);
    void signLinkToken;
  });
});
