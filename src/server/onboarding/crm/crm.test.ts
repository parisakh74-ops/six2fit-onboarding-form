// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreError } from "../errors";
import { LocalFileSink } from "../file-store";
import { DEAL_ID, NOW_MS, SECRET, consultToken, dealToken, validAnswers } from "../fixtures";
import { IdempotencyLedger, resolveManually } from "../ledger";
import type { SubjectDirectory } from "../ports";
import { createOnboardingService, type SubmitInput } from "../service";
import { createRequestsStore, createRequestsWriter } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";
import snapshot from "./requests-schema.snapshot.json";

const ENV: Record<string, string> = {
  SIX2FIT_ONBOARDING_STORE: "crm",
  SIX2FIT_ONBOARDING_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client",
  SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ONBOARDING_RAW_FIELD: "Onboarding_Raw_JSON",
  SIX2FIT_ZOHO_TIMEOUT_MS: "40",
  SIX2FIT_ONBOARDING_LEDGER_WAIT_MS: "1000000000", // virtual waits: many waiters advance one shared clock
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-onbcrm-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

class Directory implements SubjectDirectory {
  async resolve() {
    return { prefill: { "ON-01": "Ali Rezaei" } };
  }
}

function world(zoho = new MockZoho(), env: Record<string, string> = {}) {
  const clock = { t: NOW_MS };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  /** A separate "worker": its own service and store objects; shares only the ledger directory and the CRM. */
  const worker = () => {
    const store = createRequestsStore({ ...ENV, ...env }, join(dir, "ledger"), { fetch: zoho.fetch, now: () => clock.t, sleep, log: (event, fields) => logs.push({ event, fields }) });
    return createOnboardingService({ store, directory: new Directory(), sink: new LocalFileSink(dir), secret: SECRET, now: () => clock.t, log: (event, fields) => logs.push({ event, fields: fields ?? {} }) });
  };
  return { zoho, clock, logs, worker, advance: (ms: number) => (clock.t += ms) };
}

const input = (over: Partial<SubmitInput> = {}): SubmitInput => {
  const id = over.submissionId ?? "11111111-2222-4333-8444-555555555555";
  return { token: dealToken({ exp: Math.floor(NOW_MS / 1000) + 30 * 24 * 3600 }), submissionId: id, idempotencyKey: id, answers: validAnswers("Combo"), verificationState: "{}", files: {}, ...over };
};
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Requests").length;
const sid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("Requests record mapping", () => {
  it("creates one Deal-linked Request with the complete answers and the verified structured fields", async () => {
    const w = world();
    const r = await w.worker().submit(input());
    expect(r.status).toBe(200);
    expect(r.body["deduplicated"]).toBe(false);
    expect(w.zoho.records).toHaveLength(1);
    const rec = w.zoho.records[0] as Record<string, unknown>;
    expect(rec).toMatchObject({
      uniqueformkey: `onb2_${DEAL_ID}_link_0123456789abcdef0123`,
      Deal: { id: DEAL_ID },
      Form_Complete: true,
      Is_First_Request: "True",
      Product_Related_To: "Fitness and Nutrition",
      Email: "ali.rezaei@example.test",
      Sex: "Male",
      Height_cm: 178,
      Current_Weight_Kg: 82,
      Goal_Weight: 75,
      Goal: "Weight Reduction",
      Daily_Activities1: "Option 3", // ACTUAL value of the label "Moderately Active"
      Smoke: false,
      Alcohol1: false,
      Workout_Location: "Full Gym",
      Abdomen_circumference: 88,
      Hip_circumference: 98,
      Neck_circumference: 38,
    });
    expect(rec["Form_Completion_Date"]).toBe("2026-10-13T12:00:00+00:00");
    expect(rec["Is_New_Record_Created"]).toBeUndefined(); // gated by config (decision)
    // completeness: every answer is in the raw document
    const doc = JSON.parse(rec["Onboarding_Raw_JSON"] as string) as { answers: Record<string, unknown>; fingerprint: string };
    expect(Object.keys(doc.answers).sort()).toEqual(Object.keys(validAnswers("Combo")).sort());
    expect(doc.answers["NU-06.lunch"]).toBe("زرشک‌پلو با مرغ، آبگوشت");
    expect(w.zoho.triggerModes).toEqual(["suppressed"]);
  });

  it("every structured field the adapter writes exists in the Requests schema snapshot with a compatible type, length and picklist value", async () => {
    const w = world();
    await w.worker().submit(input({ answers: validAnswers("Combo", { "ON-11": "muscle", "ON-12.kg": undefined, "ON-13": "high", "ON-19": "yes", "ON-19.detail": "x", "ON-20": "weekly", "ON-20.detail": "y", "TR-05": "home", "TR-06": ["dumbbell"] }) }));
    const rec = w.zoho.records[0] as Record<string, unknown>;
    const fields = snapshot.fields as Record<string, { type: string; length: number | null; read_only: boolean; formula: boolean; picklist_actual_values?: string[] }>;
    const ownRaw = new Set(["Onboarding_Raw_JSON", "id", "Created_Time"]);
    for (const [k, v] of Object.entries(rec)) {
      if (ownRaw.has(k)) continue;
      const f = fields[k];
      expect(f, `field ${k} must exist in the verified Requests metadata`).toBeDefined();
      expect(f!.read_only || f!.formula, `${k} must be writable`).toBe(false);
      if (f!.type === "picklist") expect(f!.picklist_actual_values, `${k}=${String(v)}`).toContain(v);
      if (f!.type === "double" || f!.type === "integer") expect(typeof v).toBe("number");
      if (f!.type === "boolean") expect(typeof v).toBe("boolean");
      if (f!.type === "text" || f!.type === "email") expect([...String(v)].length).toBeLessThanOrEqual(f!.length ?? 255);
    }
    expect(rec["Goal"]).toBe("Muscle Gain");
    expect(rec["Daily_Activities1"]).toBe("Very Active");
    expect(rec["Smoke"]).toBe(true);
    expect(rec["Alcohol1"]).toBe(true);
    expect(rec["Workout_Location"]).toBe("Home or Home Gym");
  });

  it("never writes a read-only/formula field (Goal_Weight_Kg is a formula) or the credential-like Rambadi fields", async () => {
    const w = world();
    await w.worker().submit(input());
    const keys = Object.keys(w.zoho.records[0] as object);
    expect(keys).not.toContain("Goal_Weight_Kg");
    expect(keys.some((k) => /Rambadi/i.test(k))).toBe(false);
  });

  it("a Consultation hand-off link cannot create a Request (Requests are Deal-linked): 403, nothing written", async () => {
    const w = world();
    const r = await w.worker().submit(input({ token: consultToken() }));
    expect(r.status).toBe(403);
    expect(r.body["error_code"]).toBe("NOT_ELIGIBLE");
    expect(posts(w.zoho)).toBe(0);
  });

  it("answers that do not fit the CRM raw field are refused before any request", async () => {
    const w = world(new MockZoho(), { SIX2FIT_ONBOARDING_RAW_MAX_CHARS: "1000" });
    const r = await w.worker().submit(input());
    expect(r.status).toBe(503);
    expect(posts(w.zoho)).toBe(0);
  });

  it("workflows run on the new Request only when the PM enables it", async () => {
    const w = world(new MockZoho(), { SIX2FIT_ONBOARDING_TRIGGER_AUTOMATIONS: "true", SIX2FIT_ONBOARDING_SET_NEW_RECORD_FLAG: "true" });
    await w.worker().submit(input());
    expect(w.zoho.triggerModes).toEqual(["workflows-run"]);
    expect((w.zoho.records[0] as Record<string, unknown>)["Is_New_Record_Created"]).toBe(true);
  });
});

describe("environment safeguards (fail closed)", () => {
  it("CRM mode needs explicit enablement, the complete-answers field, a Sandbox domain and credentials", () => {
    const bad: Array<[string, Record<string, string>]> = [
      ["not enabled", { SIX2FIT_ONBOARDING_CRM_ENABLED: "" }],
      ["no raw field", { SIX2FIT_ONBOARDING_RAW_FIELD: "" }],
      ["production domain", { SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.com" }],
      ["no credentials", { SIX2FIT_ZOHO_REFRESH_TOKEN: "" }],
      ["production prefix", { SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6067417000" }],
      ["not sandbox", { SIX2FIT_ZOHO_ENVIRONMENT: "production" }],
    ];
    for (const [name, over] of bad) expect(() => createRequestsWriter({ ...ENV, ...over }), name).toThrow(StoreError);
  });

  it("an organisation or module that is not the expected Sandbox stops the write", async () => {
    for (const mutate of [(z: MockZoho) => (z.orgId = "111111111"), (z: MockZoho) => (z.orgType = "production"), (z: MockZoho) => (z.moduleId = "6067417000999999999")]) {
      const w = world();
      mutate(w.zoho);
      expect((await w.worker().submit(input())).status).toBe(503);
      expect(posts(w.zoho)).toBe(0);
    }
  });
});

describe("simultaneous submissions against a CRM whose unique check is not atomic", () => {
  it("identical: 3 workers x 9 requests -> exactly one POST and one Request", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const workers = [w.worker(), w.worker(), w.worker()];
    const rs = await Promise.all(Array.from({ length: 9 }, (_, i) => (workers[i % 3] as ReturnType<typeof w.worker>).submit(input({ submissionId: sid(i) }))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body["deduplicated"] === false)).toHaveLength(1);
    expect(w.zoho.records).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
  });

  it("conflicting answers on the same link: one 200, the rest 409, one Request", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const rs = await Promise.all([0, 1, 2].map((i) => w.worker().submit(input({ submissionId: sid(i), answers: validAnswers("Combo", { "ON-09.kg": String(80 + i) }) }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("different links (different Deals or links) are independent submissions", async () => {
    const w = world();
    const a = await w.worker().submit(input());
    const b = await w.worker().submit(input({ token: dealToken({ jti: "link_ffffffffffffffffffff", exp: Math.floor(NOW_MS / 1000) + 3600 }), submissionId: sid(5) }));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(w.zoho.records).toHaveLength(2);
  });
});

describe("restart, delayed indexing, lost responses, ambiguous outcomes", () => {
  it("a restarted worker deduplicates from the ledger without any CRM call", async () => {
    const w = world();
    await w.worker().submit(input());
    const before = w.zoho.requests.length;
    const again = await w.worker().submit(input({ submissionId: sid(7) }));
    expect(again.body["deduplicated"]).toBe(true);
    expect(w.zoho.requests.length).toBe(before);
  });

  it("an immediate retry while the search index lags is answered from the ledger", async () => {
    const w = world();
    w.zoho.searchLag = true;
    await w.worker().submit(input());
    const retry = await w.worker().submit(input({ submissionId: sid(8) }));
    expect(retry.body["deduplicated"]).toBe(true);
    expect(posts(w.zoho)).toBe(1);
  });

  it("create succeeded but the response was lost: 503, never a blind retry, resolved by a later lookup without a second POST", async () => {
    const w = world();
    w.zoho.searchLag = true;
    w.zoho.failNext(/Requests$/, { kind: "persist-then-timeout" }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(1);
    for (const wait of [0, 30_000]) {
      w.advance(wait);
      expect((await w.worker().submit(input({ submissionId: sid(9) }))).status).toBe(503);
      expect(posts(w.zoho)).toBe(1);
    }
    w.advance(121_000);
    expect((await w.worker().submit(input({ submissionId: sid(9) }))).status).toBe(503); // index still lagging: unresolved, NOT a failure
    expect(posts(w.zoho)).toBe(1);
    w.zoho.searchLag = false;
    w.advance(121_000);
    const ok = await w.worker().submit(input({ submissionId: sid(9) }));
    expect(ok.status).toBe(200);
    expect(ok.body["deduplicated"]).toBe(true);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("every ambiguous shape is a 503 and exactly one POST", async () => {
    const faults = [{ kind: "timeout" }, { kind: "network" }, { kind: "garbage", status: 200 }, { kind: "status", status: 500, body: {} }] as never[];
    for (const [i, fault] of faults.entries()) {
      const w = world(); // each shape uses its own link: the ledger directory is shared inside one test
      w.zoho.failNext(/Requests$/, fault, 5, "POST");
      const token = dealToken({ jti: `link_shape_${i}_0123456789abcdef`, exp: Math.floor(NOW_MS / 1000) + 3600 });
      expect((await w.worker().submit(input({ token }))).status).toBe(503);
      expect(posts(w.zoho)).toBe(1);
    }
  });

  it("an unresolved outcome becomes a fresh write only through an audited manual decision", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "timeout" }, 1, "POST");
    await w.worker().submit(input());
    for (const wait of [10_000, 130_000, 3_600_000]) {
      w.advance(wait);
      expect((await w.worker().submit(input({ submissionId: sid(3) }))).status).toBe(503);
      expect(posts(w.zoho)).toBe(1);
    }
    const key = (await new IdempotencyLedger(join(dir, "ledger")).current(await onlyLedgerId()))!;
    expect(key.state).toBe("needs_review");
    await resolveManually(new IdempotencyLedger(join(dir, "ledger")), key.id, { decision: "released", note: "PM verified in CRM: no Request exists" }, w.clock.t);
    const r = await w.worker().submit(input({ submissionId: sid(3) }));
    expect(r.status).toBe(200);
    expect(r.body["deduplicated"]).toBe(false);
    expect(posts(w.zoho)).toBe(2);
    expect(w.zoho.records).toHaveLength(1);
  });

  async function onlyLedgerId(): Promise<string> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(dir, "ledger"));
    expect(names).toHaveLength(1);
    return names[0] as string;
  }

  it("a CRM validation refusal is definitive: not retried, the next attempt may write", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: "Email" }, status: "error" }] } }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
    const retry = await w.worker().submit(input({ submissionId: sid(4) }));
    expect(retry.status).toBe(200);
    expect(posts(w.zoho)).toBe(2);
  });

  it("auth failures are definitive refusals too (nothing written)", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 403, body: {} }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect((await w.worker().submit(input({ submissionId: sid(4) }))).status).toBe(200);
    expect(w.zoho.records).toHaveLength(1);
  });
});

describe("existing duplicate CRM records are integrity exceptions", () => {
  it("a duplicate answer that reports more records is refused and remembered", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 400, body: { data: [{ code: "DUPLICATE_DATA", details: { api_name: "uniqueformkey", more_records: true, id: "6223361000127000010" }, status: "error" }] } }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    const before = w.zoho.requests.length;
    expect((await w.worker().submit(input({ submissionId: sid(6) }))).status).toBe(503);
    expect(w.zoho.requests.length).toBe(before);
    expect(w.logs.some((l) => l.event === "onboarding.integrity_exception")).toBe(true);
  });

  it("two records already carrying the key are never resolved by picking one", async () => {
    const w = world();
    const key = `onb2_${DEAL_ID}_link_0123456789abcdef0123`;
    for (const n of [1, 2]) w.zoho.records.push({ id: `62233610001270000${n}0`, uniqueformkey: key } as never);
    w.zoho.failNext(/Requests$/, { kind: "timeout" }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
  });

  it("a different unique field colliding (New_Unique_ID) is a refusal, not a duplicate answer", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "status", status: 400, body: { data: [{ code: "DUPLICATE_DATA", details: { api_name: "New_Unique_ID", id: "6223361000127000010" }, status: "error" }] } }, 1, "POST");
    expect((await w.worker().submit(input())).status).toBe(503);
    expect(w.zoho.records).toHaveLength(0);
  });

  it("a record whose stored answers were edited in the CRM is reported as corrupt, never as the original", async () => {
    const w = world();
    await w.worker().submit(input());
    const rec = w.zoho.records[0] as Record<string, unknown>;
    rec["Onboarding_Raw_JSON"] = (rec["Onboarding_Raw_JSON"] as string).replace('"ON-08":178', '"ON-08":179');
    // a ledger-less worker (ledger lost) meets the existing record through the CRM duplicate answer
    const lost = await mkdtemp(join(tmpdir(), "s2f-onbcrm-lost-"));
    const w2 = world(w.zoho);
    const store = createRequestsStore({ ...ENV }, lost, { fetch: w.zoho.fetch, now: () => w.clock.t, sleep: async () => undefined });
    const svc = createOnboardingService({ store, directory: new Directory(), sink: new LocalFileSink(lost), secret: SECRET, now: () => w.clock.t });
    expect((await svc.submit(input({ submissionId: sid(2) }))).status).toBe(503);
    await rm(lost, { recursive: true, force: true });
    void w2;
  });
});

describe("privacy of diagnostics", () => {
  it("no answer, token or credential appears in any log line, including failures", async () => {
    const w = world();
    w.zoho.failNext(/Requests$/, { kind: "timeout" }, 1, "POST");
    await w.worker().submit(input());
    await w.worker().submit(input({ answers: validAnswers("Combo", { "ON-07": "bad" }) }));
    expect(JSON.stringify(w.logs)).not.toMatch(/Rezaei|example\.test|synthetic-secret|synthetic-refresh|synthetic-onboarding|Zoho-oauthtoken|link_0123/);
  });
});
