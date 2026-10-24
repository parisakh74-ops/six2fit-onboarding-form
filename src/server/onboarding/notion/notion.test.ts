// @vitest-environment node
// Notion sync: mapping, supplementary preservation, durable ledger, idempotency, concurrency, interrupted uploads, retries,
// rate limits and log hygiene. Mock Notion only: no network, synthetic data only.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical";
import { LIVE_EMAIL, syntheticFiles, syntheticMultiFileAnswers } from "../crm/live-fixtures";
import { validateSubmission } from "../validate";
import { NotionHttpError } from "./api";
import { HttpNotionApi } from "./http-api";
import { NotionSyncLedger } from "./ledger";
import { FILE_PROPERTY, NP, buildNotionPayload, legacyZohoDate, richText, type NotionSubmission } from "./mapping";
import { MockNotion } from "./mock";
import { NotionSync } from "./sync";

const KEY = "onb2_synthetic0123456789abcdef";
const DB = "a".repeat(32);
const SUBMITTED = "2026-10-24T07:04:30.000Z";

// Property names copied from the real legacy schema (fetched 2026-10-24, read-only): guards typos and whitespace.
const LEGACY = new Set([
  "نام", "نام خانوادگی", "سن", "تاریخ تولد میلادی", "محل سکونت - کشور", "محل سکونت - شهر", "شماره موبایل", "ایمیل", "قد", "وزن فعلی", "وزن هدف - دلخواه",
  "جنسیت", " هدف اصلی", "میزان فعالیت روزانه", "T&C", "ZOHO تاریخ تکمیل فرم", "نوع فرم", "محل تمرین", "وسایل در خانه", "تعداد روز ورزش/ هفته",
  "مدت زمان ورزش ", "الرژی - حساسیت ", "روتین صبحانه", "روتین میان وعده", "روتین وعده اصلی | نهار و شام", "آب", "تمایل به استفاده مکمل", "توضیح الکل",
  "توضیح الکل ", "توضیح سیگار و دخانیات", "بارداری  و شیردهی ", "توضیح مشکلات قلب  ؟", "توضیح مشکلات کبدی یا اختلال در آنزیم‌های کبدی",
  "توضیح چربی خون یا کلسترول بالا", "توضیح مشکل گوارش",
  "عکس از جلو", "عکس از پشت", "مدارک پزشکی ",
]);
const NEW_PROPS = new Set(["S2F Key", "S2F Sync Status", "WorkDrive Link", "S2F Supplementary Answers", "عکس ناحیه سلولیت", "عکس از پهلو - حالت خنثی", "عکس از پهلو - دست‌ها رو به جلو", "عکس وسیله (سایر)"]);

function typed(overrides: Record<string, string | undefined> = {}) {
  const raw: Record<string, string> = { ...syntheticMultiFileAnswers() };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete raw[k];
    else raw[k] = v;
  }
  const files = syntheticFiles();
  const fi = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { name: f.name, type: f.type, size: f.bytes.length, head: f.bytes.slice(0, 16) }]));
  const v = validateSubmission(raw, fi, { scope: "Combo", entitlements: ["cellulite"], now: new Date(SUBMITTED) });
  if (!v.ok) throw new Error(`fixture invalid: ${JSON.stringify(v.issues)}`);
  const submission: NotionSubmission = {
    uniqueFormKey: KEY, scope: "Combo", entitlements: ["cellulite"], answers: v.answers, submittedAt: SUBMITTED,
    files: v.files.map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, sha256: sha256Hex(files[f.key]!.bytes) })),
  };
  return { submission, files };
}
const source = (files: ReturnType<typeof syntheticFiles>) => ({ fileBytes: async (k: string) => files[k]!.bytes });
const plain = (p: unknown): string => JSON.stringify(p);

describe("mapping", () => {
  it("writes only exact legacy property names (whitespace included) plus the additive schema", () => {
    const { submission } = typed();
    const names = [...Object.keys(buildNotionPayload(submission).properties), ...Object.values(FILE_PROPERTY)];
    for (const n of names) expect(LEGACY.has(n) || NEW_PROPS.has(n), `unknown property name: ${JSON.stringify(n)}`).toBe(true);
    expect(FILE_PROPERTY["HL-09"]).toBe("مدارک پزشکی "); // trailing space of the real property
    expect(NP.alcoholB).toBe("توضیح الکل "); // twin with trailing space
  });

  it("legacy value formats: Female/Male, Agreed, ISO-with-offset text; alcohol note mirrored in both twins; stress never in the legacy 1..5 field", () => {
    const { submission } = typed({ "ON-03": "female", "HL-03a": "no", "ON-20": "weekly", "ON-20.detail": "S2F-TEST wine" });
    const p = buildNotionPayload(submission).properties as Record<string, any>;
    expect(p[NP.gender].rich_text[0].text.content).toBe("Female");
    expect(p[NP.terms].rich_text[0].text.content).toBe("Agreed");
    expect(p[NP.zohoDate].rich_text[0].text.content).toBe("2026-10-24T07:04:30.000+00:00");
    expect(p[NP.alcoholA].rich_text[0].text.content).toBe("S2F-TEST wine");
    expect(p[NP.alcoholB].rich_text[0].text.content).toBe("S2F-TEST wine");
    expect(p["استرس"]).toBeUndefined();
    expect(p[NP.key].rich_text[0].text.content).toBe(KEY);
    expect(p[NP.status]).toEqual({ select: { name: "Pending" } });
  });

  it("D1: form type comes ONLY from the resolved Product.Fitness; never from scope or entitlements; unknown = empty", () => {
    const { submission } = typed();
    const ft = (x: NotionSubmission) => (buildNotionPayload(x).properties as any)[NP.formType];
    expect(ft(submission)).toBeUndefined(); // scope Combo + cellulite entitlement alone decide nothing
    expect(ft({ ...submission, productFitness: "Normal" })).toEqual({ select: { name: "Normal" } });
    expect(ft({ ...submission, productFitness: "VIP" })).toEqual({ select: { name: "VIP" } });
    expect(ft({ ...submission, productFitness: "VIP - Cellulite" })).toEqual({ select: { name: "VIP Cellulite" } });
    expect(ft({ ...submission, productFitness: "Gold" })).toBeUndefined();
    expect(ft({ ...submission, productFitness: null })).toBeUndefined();
  });

  it("D2: MS-06.photo has its OWN property and never the legacy contracted/focused-cellulite one", () => {
    expect(FILE_PROPERTY["MS-06.photo"]).toBe("عکس ناحیه سلولیت");
    expect(Object.values(FILE_PROPERTY)).not.toContain("حالت منقبض / تمرکز بر ناحیه سلولیت");
  });

  it("D3/D4/D5: thyroid, diabetes, insulin, every NU-01 answer and the stress level stay ONLY in the supplementary text", () => {
    for (const nu of ["omni", "veg", "vegan", "pesce"]) {
      const { submission } = typed({ "ON-03": "female", "HL-03a": "no", "NU-01": nu });
      const out = buildNotionPayload({ ...submission, answers: { ...submission.answers, "HL-02": ["thyroid", "diabetes", "insulin", "heart"] } });
      const p = out.properties as Record<string, any>;
      expect(p["اختلالات غدد یا هورمونی"]).toBeUndefined();
      expect(p["نوع رژیم غذایی"]).toBeUndefined();
      expect(p["استرس"]).toBeUndefined();
      expect(out.represented).not.toContain("NU-01");
      expect(out.represented).not.toContain("HL-02");
      expect(out.represented).not.toContain("ON-18");
      expect(out.supplementary).toContain("\nNU-01 | الگوی غذایی: ");
      expect(out.supplementary).toContain("\nON-18 | سطح استرس: ");
      expect(out.supplementary).toMatch(/\nHL-02 \| شرایط سلامت: .*اختلال تیروئید.*دیابت.*پیش‌دیابت/);
      expect(p[NP.heart]).toBeDefined(); // heart keeps its approved exact-equivalent legacy property
    }
  });

  it("D6: the output is the SAME instant as the source timestamp, with an explicit valid offset and no assumed timezone", () => {
    for (const src of ["2026-10-24T07:04:30.123Z", "2027-01-15T23:59:59.999Z", "2026-03-29T00:30:00.000+03:30"]) {
      const out = legacyZohoDate(src);
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      expect(Date.parse(out)).toBe(Date.parse(src));
    }
    expect(legacyZohoDate("2026-10-24T07:04:30.123Z")).toBe("2026-10-24T07:04:30.123+00:00");
    expect(() => legacyZohoDate("not a date")).toThrow();
  });

  it("every answer is either fully represented by a legacy property or preserved line by line in the supplementary text", () => {
    const { submission } = typed();
    const out = buildNotionPayload(submission);
    const rep = new Set(out.represented);
    const fileKeys = new Set(Object.keys(FILE_PROPERTY));
    for (const k of Object.keys(submission.answers)) {
      if (fileKeys.has(k)) continue;
      expect(rep.has(k) || out.supplementary.includes(`\n${k} | `), `answer ${k} is neither represented nor preserved`).toBe(true);
    }
    // Unmatched answers must be present and exact; represented ones must not be duplicated.
    expect(out.supplementary).toContain("\nON-18 | سطح استرس: ");
    expect(out.supplementary).toContain("\nCN-01 | ");
    expect(out.supplementary).toContain("\nHL-02 | شرایط سلامت: ");
    expect(out.supplementary).toContain("\nON-01 | نام و نام خانوادگی: S2F-TEST Synthetic"); // full name kept verbatim
    expect(rep.has("ON-07")).toBe(true);
    expect(rep.has("NU-01")).toBe(false);
    expect(out.supplementary).not.toContain(LIVE_EMAIL);
    // The text in the property is exactly the supplementary text (chunks concatenate back with no loss).
    const chunks = ((out.properties as any)[NP.supplementary].rich_text as Array<{ text: { content: string } }>).map((c) => c.text.content);
    expect(chunks.join("")).toBe(out.supplementary);
  });

  it("long supplementary answers are chunked at 2000 characters without loss (emoji safe)", () => {
    const text = "ا".repeat(4500) + "😀" + "ب".repeat(1999);
    const chunks = richText(text);
    expect(chunks.length).toBe(4);
    expect(chunks.every((c) => Array.from(c.text.content).length <= 2000)).toBe(true);
    expect(chunks.map((c) => c.text.content).join("")).toBe(text);
    const { submission } = typed({ "NU-04": "غ".repeat(2000), "NU-22": "ن".repeat(2000), "NU-16": "ت".repeat(2000) });
    const out = buildNotionPayload(submission);
    expect(((out.properties as any)[NP.supplementary].rich_text as unknown[]).length).toBeGreaterThan(2);
  });

  it("file targets: seven distinct properties, deterministic names without customer data", () => {
    const { submission } = typed();
    const out = buildNotionPayload(submission);
    expect(out.files.map((f) => f.property).sort()).toEqual(Object.values(FILE_PROPERTY).sort());
    expect(new Set(out.files.map((f) => f.filename)).size).toBe(7);
    expect(out.files.every((f) => /^[A-Za-z0-9_.-]+-[0-9a-f]{8}\.(jpg|png|pdf)$/.test(f.filename))).toBe(true);
  });
});

let dir: string;
let now = Date.parse("2026-10-24T07:05:00Z");
let logs: Array<{ event: string; fields?: Record<string, unknown> }>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-notion-"));
  now = Date.parse("2026-10-24T07:05:00Z");
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const clock = () => now;
const build = (api: MockNotion) => {
  const ledger = new NotionSyncLedger(join(dir, "notion-ledger"), 60_000, clock);
  const sync = new NotionSync(api, ledger, { databaseId: DB, uploadMaxAgeMs: 45 * 60_000, now: clock, log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
  return { ledger, sync };
};
const complete = (api: MockNotion) => api.pages[0]!.properties[NP.status].select.name === "Complete";

describe("sync", () => {
  it("creates ONE page, attaches all seven files natively (bytes verified in Notion), marks Complete, and a replay changes nothing", async () => {
    const api = new MockNotion(clock);
    const { sync, ledger } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    expect(api.pages).toHaveLength(1);
    expect(complete(api)).toBe(true);
    const page = api.pages[0]!;
    for (const [k, prop] of Object.entries(FILE_PROPERTY)) {
      const att = api.attached(page.id, prop);
      expect(att, k).toHaveLength(1);
      expect(att[0]!.sha).toBe(sha256Hex(files[k]!.bytes));
      expect(att[0]!.size).toBe(files[k]!.bytes.length);
    }
    expect(api.calls.createFileUpload).toBe(7);
    expect((await ledger.read(KEY))?.state).toBe("complete");
    const before = { ...api.calls };
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    expect(api.calls).toEqual(before); // no Notion call at all on a replay
    expect(api.pages).toHaveLength(1);
  });

  it("two concurrent syncs of the same submission: one runs, the other is busy; exactly one page", async () => {
    const api = new MockNotion(clock);
    const { sync } = build(api);
    const { submission, files } = typed();
    const [a, b] = await Promise.all([sync.sync(submission, "f".repeat(64), source(files)), sync.sync(submission, "f".repeat(64), source(files))]);
    expect([a.status, b.status].sort()).toEqual(["busy", "complete"]);
    expect(api.pages).toHaveLength(1);
    expect(api.calls.createPage).toBe(1);
  });

  it("a stale lock of a dead worker is taken over after the lease", async () => {
    const api = new MockNotion(clock);
    const { sync, ledger } = build(api);
    const { submission, files } = typed();
    const real = ledger.withLock.bind(ledger);
    let held = false;
    await real(KEY, async () => {
      held = true;
      expect(await sync.sync(submission, "f".repeat(64), source(files))).toEqual({ status: "busy" });
    });
    expect(held).toBe(true);
  });

  it("interrupted file upload: the run stops as partial; the retry continues WITHOUT re-uploading attached files and without a second page", async () => {
    const api = new MockNotion(clock);
    api.faults.push({ op: "sendFileUpload", after: 2, times: 1, error: new NotionHttpError(400, "validation_error") });
    // 400 on the third send is handled as "restart this upload"; simulate a hard outage instead:
    api.faults.length = 0;
    api.faults.push({ op: "sendFileUpload", after: 2, times: 1, error: new NotionHttpError(503, "service_unavailable") });
    const { sync, ledger } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    const first = await sync.sync(submission, fp, source(files));
    expect(first.status).toBe("partial");
    expect(first.code).toBe("http_503_service_unavailable");
    expect(api.pages).toHaveLength(1);
    expect(api.pages[0]!.properties[NP.status].select.name).toBe("Partial");
    const e1 = await ledger.read(KEY);
    expect(e1?.state).toBe("partial");
    expect(Object.values(e1!.files).filter((f) => f.attached)).toHaveLength(2);
    const uploadsBefore = api.calls.createFileUpload;
    now += 5 * 60_000; // past the retry back-off
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    expect(api.pages).toHaveLength(1);
    expect(api.calls.createFileUpload - uploadsBefore).toBe(4); // 5 files remain: the interrupted one reuses its pending upload, the 2 attached ones are untouched
    expect(complete(api)).toBe(true);
  });

  it("a send whose answer was lost (applied, then error): the retry starts a fresh upload; every file ends up attached exactly once", async () => {
    const api = new MockNotion(clock);
    api.faults.push({ op: "sendFileUpload", after: 1, times: 1, applyThenFail: true, error: new NotionHttpError(0, "network") });
    const { sync } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    const out = [await sync.sync(submission, fp, source(files))];
    for (let i = 0; i < 4 && out[out.length - 1]!.status !== "complete"; i++) {
      now += 20 * 60_000;
      out.push(await sync.sync(submission, fp, source(files)));
    }
    expect(out[out.length - 1]).toEqual({ status: "complete" });
    expect(api.pages).toHaveLength(1);
    for (const prop of Object.values(FILE_PROPERTY)) expect(api.attached(api.pages[0]!.id, prop)).toHaveLength(1);
  });

  it("a crash after attaching but before recording: Notion shows the file, so it is not uploaded again", async () => {
    const api = new MockNotion(clock);
    const { sync, ledger } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    await sync.sync(submission, fp, source(files));
    const e = (await ledger.read(KEY))!;
    e.state = "partial";
    e.files["MS-05.front"]!.attached = false; // the worker died before recording it
    await ledger.write(e);
    const before = api.calls.createFileUpload;
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    expect(api.calls.createFileUpload).toBe(before);
    expect(api.attached(api.pages[0]!.id, FILE_PROPERTY["MS-05.front"]!)).toHaveLength(1);
  });

  it("an upload older than the attach window is replaced (Notion expires unattached uploads after one hour)", async () => {
    const api = new MockNotion(clock);
    api.faults.push({ op: "updatePage", after: 2, times: 1, error: new NotionHttpError(503, "service_unavailable") }); // properties, link-less; first attach fails
    const { sync } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    expect((await sync.sync(submission, fp, source(files))).status).toBe("partial");
    now += 50 * 60_000; // beyond uploadMaxAgeMs; the mock would also refuse the old object
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    for (const prop of Object.values(FILE_PROPERTY)) expect(api.attached(api.pages[0]!.id, prop)).toHaveLength(1);
  });

  it("a createPage whose answer was lost does not produce a second page (found by key), nor while the page is not yet visible", async () => {
    const api = new MockNotion(clock);
    api.faults.push({ op: "createPage", applyThenFail: true, error: new NotionHttpError(0, "network") });
    const { sync } = build(api);
    const { submission, files } = typed();
    const fp = "f".repeat(64);
    expect(await sync.sync(submission, fp, source(files))).toEqual({ status: "complete" });
    expect(api.pages).toHaveLength(1);

    const lag = new MockNotion(clock);
    lag.faults.push({ op: "createPage", applyThenFail: true, error: new NotionHttpError(0, "network") });
    lag.hideFromQueryCalls = 2; // the first lookup and the post-failure lookup do not see it yet
    const b = build(lag);
    const other = { ...submission, uniqueFormKey: "onb2_synthetic0123456789abcdeg" };
    const first = await b.sync.sync(other, fp, source(files));
    expect(first).toMatchObject({ status: "pending", code: "create_unconfirmed" });
    now += 60_000; // still inside the hold: no create, the page is found
    expect(await b.sync.sync(other, fp, source(files))).toEqual({ status: "complete" });
    expect(lag.pages).toHaveLength(1);
    expect(lag.calls.createPage).toBe(1);
  });

  it("more than one page with the same key is an integrity state: blocked, nothing written", async () => {
    const api = new MockNotion(clock);
    const { sync } = build(api);
    const { submission, files } = typed();
    const props = { [NP.key]: { rich_text: [{ text: { content: KEY } }] } };
    await api.createPage(DB, props);
    await api.createPage(DB, props);
    const calls = { ...api.calls };
    expect(await sync.sync(submission, "f".repeat(64), source(files))).toMatchObject({ status: "blocked", code: "duplicate_pages" });
    expect(api.calls.createPage).toBe(calls.createPage);
    expect(api.calls.updatePage).toBe(0);
  });

  it("a different fingerprint for an existing ledger entry is refused (no overwrite of an earlier submission)", async () => {
    const api = new MockNotion(clock);
    const { sync } = build(api);
    const { submission, files } = typed();
    await sync.sync(submission, "f".repeat(64), source(files));
    expect(await sync.sync(submission, "e".repeat(64), source(files))).toMatchObject({ status: "blocked", code: "fingerprint_mismatch" });
    expect(api.pages).toHaveLength(1);
  });

  it("file bytes that do not match the recorded hash are never uploaded (blocked)", async () => {
    const api = new MockNotion(clock);
    const { sync } = build(api);
    const { submission, files } = typed();
    const bad = { fileBytes: async (k: string) => (k === "HL-09" ? new Uint8Array(files[k]!.bytes.length) : files[k]!.bytes) };
    expect(await sync.sync(submission, "f".repeat(64), bad)).toMatchObject({ status: "blocked", code: "file_integrity" });
    expect([...api.uploads.values()].filter((u) => u.status === "uploaded")).toHaveLength(6);
    expect(api.attached(api.pages[0]!.id, FILE_PROPERTY["HL-09"]!)).toHaveLength(0);
  });

  it("logs and the ledger carry no answers, names, e-mail, file names or medical data", async () => {
    const api = new MockNotion(clock);
    api.faults.push({ op: "sendFileUpload", error: new NotionHttpError(503, "service_unavailable") });
    const { sync, ledger } = build(api);
    const { submission, files } = typed();
    await sync.sync(submission, "f".repeat(64), source(files));
    now += 5 * 60_000;
    await sync.sync(submission, "f".repeat(64), source(files));
    const sensitive = [LIVE_EMAIL, "S2F-TEST", "document.pdf", "front.jpg", ...Object.values(submission.answers).filter((v) => typeof v === "string" && v.length > 5).map(String)];
    const haystack = plain(logs) + plain(await ledger.read(KEY));
    for (const s of sensitive) expect(haystack.includes(s), `leaked: ${s.slice(0, 12)}`).toBe(false);
  });
});

describe("http client: retries, rate limits, secrecy", () => {
  const mk = (responses: Array<Response | Error>, o: { maxAttempts?: number } = {}) => {
    const sleeps: number[] = [];
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const queue = [...responses];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const r = queue.shift();
      if (!r) throw new Error("no more responses");
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    const api = new HttpNotionApi({ fetch: f, token: "secret_synthetic_token_0123456789", baseUrl: "https://api.notion.test", version: "2022-06-28", timeoutMs: 1000, maxAttempts: o.maxAttempts ?? 4, minIntervalMs: 350, now: clock, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    return { api, sleeps, seen };
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("429: waits for Retry-After and repeats; the caller sees the success", async () => {
    const { api, sleeps } = mk([json(429, { code: "rate_limited" }, { "retry-after": "2" }), json(429, { code: "rate_limited" }, { "retry-after": "1" }), json(200, { id: "p", properties: {} })]);
    expect((await api.updatePage("p", {})).id).toBe("p");
    expect(sleeps).toContain(2000);
    expect(sleeps).toContain(1000);
  });

  it("429 beyond the attempt budget surfaces a rate-limit error (state stays recoverable)", async () => {
    const { api } = mk([json(429, { code: "rate_limited" }, { "retry-after": "1" }), json(429, { code: "rate_limited" })], { maxAttempts: 2 });
    await expect(api.getPage("p")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("requests are spaced (about 3 per second)", async () => {
    const { api, sleeps } = mk([json(200, { id: "a", properties: {} }), json(200, { id: "a", properties: {} })]);
    await api.getPage("a");
    await api.getPage("a");
    expect(sleeps.some((s) => s > 0 && s <= 350)).toBe(true);
  });

  it("createPage is never repeated after a lost answer (the caller looks the page up instead); idempotent calls are", async () => {
    const a = mk([new Error("socket"), json(200, { id: "x", properties: {} })]);
    await expect(a.api.createPage("d".repeat(32), {})).rejects.toMatchObject({ status: 0 });
    expect(a.seen).toHaveLength(1);
    const b = mk([json(503, { code: "service_unavailable" }), json(200, { id: "x", properties: {} })]);
    expect((await b.api.getPage("x")).id).toBe("x");
    expect(b.seen).toHaveLength(2);
  });

  it("the token is only in the Authorization header; errors carry status and code, never the response text", async () => {
    const { api, seen } = mk([json(400, { code: "validation_error", message: "S2F-TEST secret answer echoed" })]);
    const err = await api.updatePage("p", { a: 1 }).catch((e) => e as Error);
    expect(String(err)).not.toContain("echoed");
    expect(String(err)).not.toContain("secret_synthetic");
    expect((seen[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret_synthetic_token_0123456789");
    expect(String(seen[0]!.init.body)).not.toContain("secret_synthetic");
  });

  it("file upload uses the native two-step API (single_part create, multipart send)", async () => {
    const { api, seen } = mk([json(200, { id: "u1", status: "pending" }), json(200, { id: "u1", status: "uploaded" })]);
    const up = await api.createFileUpload("a.jpg", "image/jpeg");
    await api.sendFileUpload(up.id, "a.jpg", "image/jpeg", new Uint8Array([1, 2, 3]));
    expect(seen[0]!.url).toBe("https://api.notion.test/v1/file_uploads");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ mode: "single_part", filename: "a.jpg", content_type: "image/jpeg" });
    expect(seen[1]!.url).toBe("https://api.notion.test/v1/file_uploads/u1/send");
    expect(seen[1]!.init.body).toBeInstanceOf(FormData);
  });
});

import { TEST_DB_SCHEMA } from "./test-db-schema";
describe("payload versus the real test database schema", () => {
  const SHAPE: Record<string, string> = { text: "rich_text", title: "title", email: "email", phone_number: "phone_number", number: "number", url: "url", select: "select", file: "files" };
  it("every property the mapper writes exists in the test database with a compatible type (names byte-exact)", () => {
    const { submission } = typed({ "ON-03": "female", "HL-03a": "no", "ON-20": "weekly", "ON-20.detail": "S2F-TEST wine" });
    const out = buildNotionPayload({ ...submission, workdriveLink: "https://workdrive.zoho.com/folder/x" });
    for (const [name, value] of Object.entries(out.properties)) {
      const type = TEST_DB_SCHEMA[name];
      expect(type, `missing in test DB: ${JSON.stringify(name)}`).toBeDefined();
      expect(Object.keys(value as object), name).toContain(SHAPE[type!]);
    }
    for (const prop of Object.values(FILE_PROPERTY)) expect(TEST_DB_SCHEMA[prop], prop).toBe("file");
  });
});

describe("lost ledger", () => {
  it("with the ledger gone, the page is adopted by key and files already attached in Notion are not uploaded again", async () => {
    const api = new MockNotion(clock);
    const { submission, files } = typed();
    await build(api).sync.sync(submission, "f".repeat(64), source(files));
    const uploads = api.calls.createFileUpload;
    const fresh = new NotionSync(api, new NotionSyncLedger(join(dir, "other-ledger"), 60_000, clock), { databaseId: DB, uploadMaxAgeMs: 45 * 60_000, now: clock });
    expect(await fresh.sync(submission, "f".repeat(64), source(files))).toEqual({ status: "complete" });
    expect(api.pages).toHaveLength(1);
    expect(api.calls.createFileUpload).toBe(uploads);
    expect(api.calls.createPage).toBe(1);
  });
});

describe("Product.Fitness resolution", () => {
  const withResolver = (api: MockNotion, resolveFitness: (id: string) => Promise<string | null>) => {
    const ledger = new NotionSyncLedger(join(dir, "notion-ledger"), 60_000, clock);
    return { ledger, sync: new NotionSync(api, ledger, { databaseId: DB, uploadMaxAgeMs: 45 * 60_000, now: clock, resolveFitness }) };
  };
  it("reads Product.Fitness once, before the page exists, and writes the form type; a read failure creates NO page and is retried", async () => {
    const api = new MockNotion(clock);
    let calls = 0;
    let fail = true;
    const { sync, ledger } = withResolver(api, async (id) => {
      calls += 1;
      expect(id).toBe("6223361000127334002");
      if (fail) throw new Error("crm down");
      return "VIP - Cellulite";
    });
    const { submission, files } = typed();
    const sub = { ...submission, dealId: "6223361000127334002" };
    expect(await sync.sync(sub, "f".repeat(64), source(files))).toMatchObject({ status: "pending", code: "fitness_unavailable" });
    expect(api.pages).toHaveLength(0);
    expect(api.calls.createPage).toBe(0);
    fail = false;
    now += 5 * 60_000;
    expect(await sync.sync(sub, "f".repeat(64), source(files))).toEqual({ status: "complete" });
    expect(api.pages[0]!.properties[NP.formType]).toEqual({ select: { name: "VIP Cellulite" } });
    expect((await ledger.read(KEY))?.fitness).toBe("VIP - Cellulite");
    const before = calls;
    expect(await sync.sync(sub, "f".repeat(64), source(files))).toEqual({ status: "complete" });
    expect(calls).toBe(before);
  });
  it("a product without Fitness (nutrition-only) leaves the form type empty and is not an error", async () => {
    const api = new MockNotion(clock);
    const { sync } = withResolver(api, async () => null);
    const { submission, files } = typed();
    expect(await sync.sync({ ...submission, dealId: "6223361000127334002" }, "f".repeat(64), source(files))).toEqual({ status: "complete" });
    expect(api.pages[0]!.properties[NP.formType]).toBeUndefined();
  });
});

describe("durable pending record", () => {
  it("register is create-only: it never changes an existing entry", async () => {
    const api = new MockNotion(clock);
    const { ledger, sync } = build(api);
    await ledger.register(KEY, "f".repeat(64));
    expect(await ledger.read(KEY)).toMatchObject({ state: "pending", attempts: 0, fingerprint: "f".repeat(64) });
    expect(await ledger.due()).toEqual([KEY]);
    const { submission, files } = typed();
    await sync.sync(submission, "f".repeat(64), source(files));
    await ledger.register(KEY, "f".repeat(64));
    expect((await ledger.read(KEY))?.state).toBe("complete");
    expect(await ledger.due()).toEqual([]);
  });
});

describe("Product.Fitness permission problem is visible, not silent", () => {
  it("a FORBIDDEN CRM read keeps the sync pending with its own code (no page, no guessed form type) until the grant is fixed", async () => {
    const api = new MockNotion(clock);
    const ledger = new NotionSyncLedger(join(dir, "notion-ledger"), 60_000, clock);
    const sync = new NotionSync(api, ledger, { databaseId: DB, uploadMaxAgeMs: 45 * 60_000, now: clock, resolveFitness: async () => { throw Object.assign(new Error("x"), { code: "FORBIDDEN" }); } });
    const { submission, files } = typed();
    expect(await sync.sync({ ...submission, dealId: "6223361000127334002" }, "f".repeat(64), source(files))).toMatchObject({ status: "pending", code: "fitness_forbidden" });
    expect(api.pages).toHaveLength(0);
  });
});
