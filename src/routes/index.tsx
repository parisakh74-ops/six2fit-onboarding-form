import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Card, Logo, PrimaryButton, GhostButton, Spinner, Notice, StepProgress } from "@/components/onboarding/shell";
import { z } from "zod";
import { STEPS, validate, type Ctx } from "@/components/onboarding/steps";
import { LABELS, OPTS, formatValue, isActive, type Answers, type Scope } from "@/lib/onboarding/data";
import { loadBootstrap, submitOnboarding, type OnboardingBootstrap } from "@/lib/onboarding/integration";
import { isFileMeta } from "@/lib/onboarding/files";
import { handleOnboardingBootstrap } from "./api/onboarding/bootstrap";
import { handleOnboardingSubmission } from "./api/onboarding/submit";

const STORAGE = "six2fit-onboarding-v5";
const SCOPE_LABEL: Record<Scope, string> = { Diet: "برنامهٔ تغذیه", Training: "برنامهٔ تمرین", Combo: "تغذیه + تمرین", CIP: "CIP — تغذیه + تمرین" };

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      POST: ({ request }) => new URL(request.url).searchParams.get("six2fit_api") === "bootstrap"
        ? handleOnboardingBootstrap(request)
        : handleOnboardingSubmission(request),
    },
  },
  validateSearch: z.object({ scope: z.enum(["Diet", "Training", "Combo", "CIP"]).optional() }),
  head: () => ({
    meta: [
      { title: "تکمیل اطلاعات برنامه | Six2Fit" },
      { name: "description", content: "فرم چندمرحله‌ای تکمیل اطلاعات برای ساخت برنامهٔ شخصی‌سازی‌شدهٔ تغذیه و تمرین Six2Fit." },
      { property: "og:title", content: "تکمیل اطلاعات برنامه | Six2Fit" },
      { property: "og:description", content: "اطلاعات خود را تکمیل کنید تا برنامهٔ شخصی‌سازی‌شدهٔ Six2Fit آماده شود." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Onboarding,
});

const fa = (n: number) => n.toLocaleString("fa");
const isEmpty = (v: any) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length);
const ORDER = Object.keys(LABELS);

function labelFor(k: string) {
  if (LABELS[k]) return LABELS[k];
  let m = k.match(/^NU-15\.freq\.(.+)$/);
  if (m) return `تکرار ${OPTS["NU-15"]!.find((o) => o[0] === m![1]!)?.[1] ?? ""}`;
  m = k.match(/^HL-04\.([a-z]+)\.(name|dose)$/);
  if (m) return `${OPTS["HL-04"]!.find((o) => o[0] === m![1]!)?.[1]} — ${m[2] === "name" ? "نام" : "دوز"}`;
  return k;
}
const sortKey = (k: string) => { const i = ORDER.indexOf(k); return i === -1 ? ORDER.findIndex((x) => x.startsWith(k.split(".")[0]!)) + 0.5 : i; };

function Onboarding() {
  const [bootstrap, setBootstrap] = useState<OnboardingBootstrap | null>(null);
  const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "error">("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  // The URL is untrusted input. The server bootstrap is the only source of scope.
  const scope: Scope = bootstrap?.scope ?? "Combo";
  const steps = useMemo(() => STEPS.filter((s) => s.show(scope)), [scope]);
  const total = steps.length + 1;

  const [a, setA] = useState<Answers>({});
  const [ver, setVer] = useState<Record<string, "confirmed" | "edited">>({});
  const [step, setStep] = useState(0);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [resumed, setResumed] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [payload, setPayload] = useState<any>(null);
  const loaded = useRef(false);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadBootstrap(controller.signal).then((data) => {
      setBootstrap(data);
      setA({ ...data.prefill, __entitlements: data.entitlements });
      setBootstrapState("ready");
    }).catch((error: unknown) => {
      if ((error as Error)?.name === "AbortError") return;
      setBootstrapError(error instanceof Error && error.message === "BOOTSTRAP_INVALID" ? "اطلاعات شروع فرم معتبر نیست." : "لینک فرم معتبر نیست یا منقضی شده است.");
      setBootstrapState("error");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (bootstrapState !== "ready" || loaded.current) return;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && typeof s === "object" && s.a && typeof s.a === "object") {
          // Chosen files cannot be restored (only their metadata was saved): the person selects them again.
          const restored = Object.fromEntries(Object.entries(s.a as Record<string, unknown>).filter(([, v]) => !isFileMeta(v)));
          setA({ ...bootstrap?.prefill, ...restored, __entitlements: bootstrap!.entitlements });
          setVer(s.ver && typeof s.ver === "object" ? s.ver : {});
          setStep(Math.min(Number.isInteger(s.step) ? s.step : 0, total - 1));
          setResumed(true);
        }
      }
    } catch {}
    loaded.current = true;
  }, [bootstrapState, bootstrap, total]);

  useEffect(() => {
    if (!loaded.current || status === "done") return;
    const t = setTimeout(() => { localStorage.setItem(STORAGE, JSON.stringify({ a, ver, step })); setSavedAt(new Date()); }, 400);
    return () => clearTimeout(t);
  }, [a, ver, step, status]);

  const on = (k: string) => isActive(k, a, scope);

  const set = (k: string, v: any) => {
    setA((prev) => {
      const next = { ...prev, [k]: v };
      const base = k.split(".")[0]!;
      const prefill = bootstrap?.prefill ?? {};
      const prefillBases = Array.from(new Set(Object.keys(prefill).map((p) => p.split(".")[0]!)));
      if (prefillBases.includes(base)) {
        const same = Object.keys(prefill).filter((p) => p.split(".")[0]! === base).every((p) => String(next[p] ?? "") === String(prefill[p]));
        setVer((vv) => { const n = { ...vv }; if (same) delete n[base]; else n[base] = "edited"; return n; });
      }
      return next;
    });
    setErrs((e) => { if (!e[k] && !e[k.split(".")[0]!]) return e; const n = { ...e }; delete n[k]; delete n[k.split(".")[0]!]; return n; });
  };

  const ctx: Ctx = {
    a, set, e: errs, on,
    pf: (b) => (bootstrap?.prefill && Object.keys(bootstrap.prefill).some((p) => p.split(".")[0] === b) ? { state: ver[b], onConfirm: () => { setVer((v) => ({ ...v, [b]: "confirmed" })); setErrs((e) => { const n = { ...e }; delete n[b]; return n; }); } } : undefined),
    fileErr: (k, m) => setErrs((e) => ({ ...e, [k]: m })),
  };

  const go = (i: number) => { setErrs({}); setStep(i); requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: "smooth" })); };

  const next = () => {
    const e = validate(steps[step]!, a, on, ver);
    setErrs(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() => document.querySelector("[role=alert]")?.closest("section, label, div")?.scrollIntoView({ behavior: "smooth", block: "center" }));
      return;
    }
    go(step + 1);
  };

  const buildPayload = () => {
    const answers: Answers = {};
    for (const k of Object.keys(a).sort((x, y) => sortKey(x) - sortKey(y))) if (on(k) && !isEmpty(a[k]) && steps.some((s) => s.keys.test(k))) answers[k] = a[k];
    const verification_state: Record<string, string> = {};
    const prefillBases = Array.from(new Set(Object.keys(bootstrap?.prefill ?? {}).map((k) => k.split(".")[0]!)));
    for (const b of prefillBases) if (ver[b]) verification_state[b] = ver[b];
    return { scope, has_nutrition: scope !== "Training", has_training: scope !== "Diet", answers, verification_state };
  };

  const submit = async () => {
    for (let i = 0; i < steps.length; i++) {
      const e = validate(steps[i]!, a, on, ver);
      if (Object.keys(e).length) { go(i); setTimeout(() => setErrs(e), 0); return; }
    }
    if (!bootstrap) { setBootstrapError("لینک فرم معتبر نیست یا منقضی شده است."); return; }
    setStatus("sending");
    const p = buildPayload();
    try {
      await submitOnboarding(bootstrap, p.answers, p.verification_state);
      setPayload(p);
      localStorage.removeItem(STORAGE);
      setStatus("done");
      top.current?.scrollIntoView({ behavior: "smooth" });
    } catch (error) {
      setStatus("idle");
      const code = error instanceof Error ? error.message : "";
      setBootstrapError(
        code === "SUBMISSION_CONFLICT" ? "این فرم قبلاً با همین ارسال ثبت شده یا ارسال هم‌زمان تشخیص داده شد."
        : code === "SESSION_EXPIRED" ? "لینک فرم منقضی شده است. لطفاً از لینک جدید استفاده کنید."
        : code === "SUBMISSION_INVALID" ? "برخی پاسخ‌ها معتبر نیست. لطفاً مرور نهایی را بررسی و دوباره تلاش کنید."
        : "ثبت اطلاعات انجام نشد. لطفاً دوباره تلاش کنید.");
    }
  };

  const pct = status === "done" ? 100 : Math.round((step / total) * 100);
  const isReview = step === steps.length;
  const cur = steps[step]!;

  return (
    <div dir="rtl" lang="fa" className="min-h-screen bg-surface px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-[760px]">
        <header ref={top} className="mb-5 flex items-center justify-between gap-3">
          <Logo />
          <span className="text-[12px] text-muted-foreground">تکمیل اطلاعات · {SCOPE_LABEL[scope]}</span>
        </header>
        <main>
          {bootstrapState === "loading" && <Card><Notice>در حال بررسی لینک امن فرم…</Notice></Card>}
          {bootstrapState === "error" && <Card><Notice tone="error">{bootstrapError}</Notice></Card>}
          {bootstrapState === "ready" && status === "done" ? <Success payload={payload} /> : bootstrapState === "ready" ? (
            
            <Card>
              <StepProgress current={step + 1} total={total} title={isReview ? "مرور نهایی" : cur.title} />
              {resumed && step > 0 && (
                <div className="mb-5">
                  <Notice><div className="flex items-center justify-between gap-3"><span>پاسخ‌های قبلی شما بازیابی شد؛ از همین‌جا ادامه دهید.</span><GhostButton className="px-2 py-1 text-[12px]" onClick={() => setResumed(false)}>بستن</GhostButton></div></Notice>
                </div>
              )}
              <div className="mb-7">
                <h1 className="text-xl font-bold leading-9 sm:text-2xl">{isReview ? "مرور نهایی" : cur.title}</h1>
                <p className="mt-2 text-[15px] leading-8 text-muted-foreground">{isReview ? "پاسخ‌هایتان را بررسی کنید. برای اصلاح، روی «ویرایش» هر بخش بزنید." : cur.desc}</p>
              </div>
              <div key={step} className="space-y-7 animate-in fade-in duration-200">
                {isReview ? <Review steps={steps} a={a} prefill={bootstrap?.prefill ?? {}} on={on} ver={ver} edit={go} /> : cur.render(ctx)}
              </div>
              <div className="onboarding-actions fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card px-4 pt-3 sm:static sm:mt-7 sm:px-0 sm:pt-5">
                <div className="mx-auto grid max-w-[696px] grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  {isReview ? <PrimaryButton className="sm:order-3 sm:ms-auto" disabled={status === "sending"} onClick={submit}>{status === "sending" ? <><Spinner />در حال ثبت…</> : "ثبت نهایی"}</PrimaryButton> : <PrimaryButton className="sm:order-3 sm:ms-auto" onClick={next}>{step === steps.length - 1 ? "مرور نهایی" : "ادامه"}</PrimaryButton>}
                  <GhostButton disabled={step === 0 || status === "sending"} onClick={() => go(step - 1)}>مرحلهٔ قبل</GhostButton>
                  <GhostButton className="col-span-2 py-2 text-[13px] sm:py-3" disabled={status === "sending"} onClick={() => { localStorage.setItem(STORAGE, JSON.stringify({ a, ver, step })); setSavedAt(new Date()); alert("پیشرفت شما ذخیره شد. هر زمان برگردید، از همین مرحله ادامه می‌دهید."); }}>ذخیره و ادامه بعداً</GhostButton>
                </div>
              </div>
            </Card>
          ) : null}
        </main>
        <footer className="mt-6 space-y-2 pb-36 text-center text-[12px] leading-6 text-muted-foreground sm:pb-0">
          {status !== "done" && <p aria-live="polite">{savedAt ? "ذخیره شد" : "ذخیرهٔ خودکار"}</p>}
          <p>این فرم جایگزین تشخیص یا درمان پزشکی نیست.</p>
        </footer>
      </div>
    </div>
  );
}

function Review({ steps, a, prefill, on, ver, edit }: { steps: typeof STEPS; a: Answers; prefill: Answers; on: (k: string) => boolean; ver: Record<string, string>; edit: (i: number) => void }) {
  return (
    <>
      {steps.map((s, i) => {
        const keys = Object.keys(a).filter((k) => s.keys.test(k) && on(k) && !isEmpty(a[k])).sort((x, y) => sortKey(x) - sortKey(y));
        return (
          <section key={s.id} className="q-card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-bold">{s.title}</h3>
              <GhostButton className="px-3 py-2 text-[13px]" onClick={() => edit(i)}>ویرایش</GhostButton>
            </div>
            {keys.length === 0 ? <p className="text-sm text-muted-foreground">پاسخی ثبت نشده است.</p> : (
              <dl className="divide-y">
                {keys.map((k) => {
                  const b = k.split(".")[0]!;
                  return (
                    <div key={k} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[11rem_1fr] sm:gap-4">
                      <dt className="text-muted-foreground">{labelFor(k)}</dt>
                      <dd className="whitespace-pre-line font-medium">
                        {formatValue(k, a[k])}
                        {ver[b] === "edited" && k === Object.keys(prefill).find((p) => p.split(".")[0]! === b) && (
                          <span className="chip ms-2 bg-brand-soft text-brand">ویرایش‌شده</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>
        );
      })}
    </>
  );
}

function Success({ payload }: { payload: any }) {
  return (
    <Card className="space-y-6 text-center animate-in fade-in duration-300">
      <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
        <Check className="size-6" strokeWidth={2.2} />
      </div>
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">اطلاعات شما با موفقیت ثبت شد</h1>
        <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-muted-foreground">تیم Six2Fit برنامهٔ شخصی‌سازی‌شدهٔ شما را آماده می‌کند و به‌زودی از طریق ایمیل و پیامک خبرتان می‌کنیم.</p>
      </div>
      {import.meta.env.DEV && (
        <details className="q-card text-start">
          <summary className="cursor-pointer text-sm font-semibold">دادهٔ ارسال‌شده (JSON — فقط در توسعه)</summary>
          <pre dir="ltr" className="mt-3 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-left text-xs leading-5">{JSON.stringify(payload, null, 2)}</pre>
        </details>
      )}
    </Card>
  );
}
