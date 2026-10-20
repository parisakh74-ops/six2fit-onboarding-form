import type { ReactNode } from "react";
import { OPTS, toEn, hasNutrition, hasTraining, type Answers, type Scope } from "@/lib/onboarding/data";
import { Q, Choice, Multi, CheckLine, Text, Num, Area, Scale, FileDrop, Note, Sub, SubLabel, TimeField, CountrySelect, DialSelect, ImageCards, BirthDateField, ageOn, normalizePhone, type PrefillState } from "./fields";
import { capWords } from "@/lib/onboarding/countries";
import poseFront from "@/assets/photo-guides/front.png";
import poseBack from "@/assets/photo-guides/back.png";
import poseSide from "@/assets/photo-guides/side-neutral.png";
import poseSideForward from "@/assets/photo-guides/side-arms-forward.png";

const EQUIP_IMG: Record<string, string> = (() => {
  const strip = (f: string) => f.split("/").pop()!.replace(/\.(svg|png)$/, "");
  const svgs = import.meta.glob("@/assets/equipment/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  const pngs = import.meta.glob("@/assets/equipment/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  return Object.assign(
    Object.fromEntries(Object.entries(svgs).map(([f, u]) => [strip(f), u])),
    Object.fromEntries(Object.entries(pngs).map(([f, u]) => [strip(f), u])),
  );
})();
const MEASURES: [string, string, string][] = [
  ["neck", "دور گردن", "در حالت ایستاده قرار بگیرید و متر را دور پهن‌ترین قسمت گردن بپیچید. متر باید دقیقاً روی برآمدگی ناحیهٔ گلو، یعنی سیب آدم، قرار بگیرد. اگر امکان کمک‌گرفتن از فرد دیگری را ندارید، روبه‌روی آینه بایستید و عدد را بخوانید."],
  ["shoulder", "دور شانه", "صاف بایستید و متر را از پشت شانه عبور دهید. پهن‌ترین قسمت شانه‌ها را مانند یک خط صاف اندازه بگیرید و مطمئن شوید متر صاف قرار گرفته است."],
  ["chest", "دور سینه", "بایستید، بازدم انجام دهید و دست‌ها را از طرفین بالا ببرید. متر را به‌صورت صاف، بالای نوک سینه دور بدن قرار دهید؛ سپس دست‌ها را پایین بیاورید و عدد به‌دست‌آمده را ثبت کنید."],
  ["arm_relaxed", "دور بازو در حالت آزاد", "دست را کاملاً ریلکس کنار بدن نگه دارید. متر را دور برجسته‌ترین بخش بازو قرار دهید و اندازه را ثبت کنید."],
  ["arm_flexed", "دور بازو در حالت منقبض", "دست را بالا بیاورید تا ساعد و بازو تقریباً زاویهٔ ۹۰ درجه بسازند. متر را دور برجسته‌ترین بخش بازو قرار دهید و اندازه را ثبت کنید."],
  ["thigh", "دور ران", "پهن‌ترین بخش ران را پیدا کنید؛ معمولاً حدود ۴ سانتی‌متر پایین‌تر از کشالهٔ ران است. متر را افقی و موازی زمین دور ران قرار دهید. ران نباید در حالت انقباض باشد."],
  ["calf", "دور ساق", "پهن‌ترین بخش ساق را پیدا کنید و متر را افقی و موازی زمین دور آن قرار دهید. ساق نباید در حالت انقباض باشد."],
  ["wrist", "دور مچ دست", "متر را دور محل اتصال استخوان مچ به پنجهٔ دست قرار دهید و اندازه را ثبت کنید."],
];
const PHOTO_KEYS = ["MS-05.front", "MS-05.back", "MS-05.side", "MS-05.side_forward"];
export const MEASURE_KEYS = MEASURES.map(([k]) => `MS-07.${k}`);
const Strong = ({ children }: { children: ReactNode }) => <p className="text-[13px] font-semibold leading-6 text-brand">{children}</p>;

export type Ctx = {
  a: Answers;
  set: (k: string, v: any) => void;
  e: Record<string, string>;
  on: (k: string) => boolean;
  pf: (base: string) => PrefillState | undefined;
  fileErr: (k: string, m: string) => void;
};

type Check = { k: string; t?: "req" | "num" | "age" | "email" | "phone" | "true" | "scale" | "time"; min?: number; max?: number; unit?: string; optional?: boolean; msg?: string };

export type Step = {
  id: string;
  title: string;
  desc: string;
  show: (s: Scope) => boolean;
  keys: RegExp;
  checks: (a: Answers) => Check[];
  render: (c: Ctx) => ReactNode;
};

const empty = (v: any) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "string" && !v.trim());
const fa = (n: number) => n.toLocaleString("fa");

export function validate(step: Step, a: Answers, on: (k: string) => boolean, ver: Record<string, string>) {
  const errs: Record<string, string> = {};
  for (const c of step.checks(a)) {
    if (!on(c.k)) continue;
    const v = a[c.k];
    if (empty(v) || (c.t === "true" && v !== true)) {
      if (!c.optional) errs[c.k] = c.msg ?? "لطفاً این مورد را تکمیل کنید.";
      continue;
    }
    const s = toEn(v);
    if (c.t === "num") {
      const n = Number(s);
      if (!Number.isFinite(n) || n < c.min! || n > c.max!) errs[c.k] = `عدد معتبر بین ${fa(c.min!)} تا ${fa(c.max!)} ${c.unit ?? ""} وارد کنید.`;
    } else if (c.t === "age") {
      const age = ageOn(s);
      if (isNaN(age) || age < 14 || age > 100) errs[c.k] = "سن شما باید بین ۱۴ تا ۱۰۰ سال باشد.";
    } else if (c.t === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) errs[c.k] = "ایمیل معتبر وارد کنید.";
    } else if (c.t === "time") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) errs[c.k] = "ساعت را به‌صورت ۲۴ ساعته و با قالب HH:MM وارد کنید؛ مثلاً 06:30 یا 23:00.";
    } else if (c.t === "phone") {
      if (!/^\d{7,13}$/.test(s.replace(/[\s-]/g, "").replace(/^0/, ""))) errs[c.k] = "شمارهٔ تماس معتبر وارد کنید.";
    }
  }
  return errs;
};

const o = (k: string) => OPTS[k]!;

export const STEPS: Step[] = [
  {
    id: "personal", title: "اطلاعات فردی و هدف", desc: "چند اطلاعات پایه تا برنامه دقیقاً برای شما تنظیم شود.",
    show: () => true, keys: /^ON-(0[1-9]|1[12]|027)/,
    checks: (a) => [
      { k: "ON-01" }, { k: "ON-02", t: "age" }, { k: "ON-03" }, { k: "ON-04" },
      { k: "ON-06.cc", msg: "کد کشور را انتخاب کنید." }, { k: "ON-06.n", t: "phone" }, { k: "ON-07", t: "email" },
      { k: "ON-08", t: "num", min: 100, max: 250, unit: "سانتی‌متر" },
      { k: "ON-09.kg", t: "num", min: 25, max: 350, unit: "کیلوگرم" },
      { k: "ON-11" },
      ...(a["ON-12.unsure"] ? [] : [{ k: "ON-12.kg", t: "num" as const, min: 25, max: 350, unit: "کیلوگرم", msg: "وزن هدف را وارد کنید یا «مطمئن نیستم» را انتخاب کنید." }]),
      { k: "ON-027" }, { k: "ON-027.phone", t: "phone", optional: true },
    ],
    render: (c) => (
      <>
        <Q id="ON-01" label="نام و نام خانوادگی شما" required error={c.e["ON-01"]} prefill={c.pf("ON-01")}>
          <Text value={c.a["ON-01"]} onChange={(v) => c.set("ON-01", capWords(v))} autoComplete="name" autoCapitalize="words" />
        </Q>
        <Q id="ON-02" label="تاریخ تولد شما (میلادی)" required error={c.e["ON-02"]} prefill={c.pf("ON-02")}>
          <BirthDateField value={c.a["ON-02"]} onChange={(v) => c.set("ON-02", v)} />
        </Q>
        <Q id="ON-03" label="جنسیت شما" required error={c.e["ON-03"]} prefill={c.pf("ON-03")}>
          <Choice cols={2} value={c.a["ON-03"]} onChange={(v) => c.set("ON-03", v)} options={o("ON-03")} />
        </Q>
        <Q id="ON-04" label="کشور محل اقامت شما" required error={c.e["ON-04"]}>
          <CountrySelect value={c.a["ON-04"]} onChange={(v) => c.set("ON-04", v)} />
        </Q>
        <Q id="ON-05" label="شهر محل اقامت شما" prefill={c.pf("ON-05")}>
          <Text value={c.a["ON-05"]} onChange={(v) => c.set("ON-05", capWords(v))} autoCapitalize="words" autoComplete="address-level2" />
        </Q>
        <Q id="ON-06" label="شماره تماس شما" required error={c.e["ON-06"] ?? c.e["ON-06.cc"] ?? c.e["ON-06.n"]} prefill={c.pf("ON-06")}>
          <div className="flex gap-2" dir="ltr">
            <DialSelect iso={c.a["ON-06.iso"]} dial={c.a["ON-06.cc"]} onChange={(ct) => { c.set("ON-06.iso", ct.iso); c.set("ON-06.cc", `+${ct.dial}`); }} />
            <input className="field" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="912 123 4567" value={c.a["ON-06.n"] ?? ""} onChange={(e) => c.set("ON-06.n", normalizePhone(e.target.value))} />
          </div>
        </Q>
        <Q id="ON-07" label="ایمیل شما" required error={c.e["ON-07"]} prefill={c.pf("ON-07")}>
          <Text type="email" dir="ltr" maxLength={100} value={c.a["ON-07"]} onChange={(v) => c.set("ON-07", v)} autoComplete="email" />
        </Q>
        <Q id="ON-08" label="قد فعلی شما" hint="پابرهنه کنار دیوار صاف بایستید؛ پاشنه‌ها به دیوار نزدیک باشند، بدن صاف باشد و سر روبه‌رو قرار بگیرد. فاصلهٔ زمین تا بالای سر را با کمک فرد دیگر اندازه بگیرید." required error={c.e["ON-08"]} prefill={c.pf("ON-08")}>
          <Num unit="سانتی‌متر" value={c.a["ON-08"]} onChange={(v) => c.set("ON-08", v)} />
        </Q>
        <Q id="ON-09" label="وزن فعلی شما" hint={<>برای اندازه‌گیری دقیق‌تر، از ترازوی دیجیتال استفاده کنید و همیشه در یک زمان مشخص، ترجیحاً صبح‌ها بین ساعت ۷ تا ۸، پس از ناشتا بودن و با کمترین لباس ممکن وزن‌کشی کنید.<br />لطفاً وزنی را وارد کنید که حداکثر مربوط به ۱۰ روز اخیر باشد.</>} required error={c.e["ON-09"] ?? c.e["ON-09.kg"]} prefill={c.pf("ON-09")}>
          <Num unit="کیلوگرم" value={c.a["ON-09.kg"]} onChange={(v) => c.set("ON-09.kg", v)} />
        </Q>
        <Q id="ON-11" label="هدف اصلی شما از این برنامه چیست؟" required error={c.e["ON-11"]} prefill={c.pf("ON-11")}>
          <Choice value={c.a["ON-11"]} onChange={(v) => c.set("ON-11", v)} options={o("ON-11")} />
        </Q>
        {c.on("ON-12") && (
          <Q id="ON-12" label="دوست دارید به چه وزنی برسید؟" required error={c.e["ON-12.kg"]}>
            {!c.a["ON-12.unsure"] && <Num unit="کیلوگرم" value={c.a["ON-12.kg"]} onChange={(v) => c.set("ON-12.kg", v)} />}
            <CheckLine checked={c.a["ON-12.unsure"]} onChange={(v) => c.set("ON-12.unsure", v)}>مطمئن نیستم</CheckLine>
          </Q>
        )}
        <Q id="ON-027" label="آیا یکی از دوستان یا آشنایان‌تان شما را به Six2Fit معرفی کرده است؟" required error={c.e["ON-027"]}>
          <Choice cols={2} value={c.a["ON-027"]} onChange={(v) => c.set("ON-027", v)} options={o("ON-027")} />
          {c.on("ON-027.phone") && (
            <Sub>
              <Strong>این معرفی می‌تواند برای خریدهای بعدی شما امتیاز داشته باشد.</Strong>
              <SubLabel><span className="text-sm font-medium">نام فرد معرف</span>
                <Text value={c.a["ON-027.name"]} onChange={(v) => c.set("ON-027.name", capWords(v))} autoCapitalize="words" /></SubLabel>
              <SubLabel error={c.e["ON-027.phone"]}><span className="text-sm font-medium">شماره تماس فرد معرف</span>
                <input className="field" dir="ltr" type="tel" inputMode="tel" value={c.a["ON-027.phone"] ?? ""} onChange={(e) => c.set("ON-027.phone", normalizePhone(e.target.value))} /></SubLabel>
            </Sub>
          )}
        </Q>
      </>
    ),
  },
  {
    id: "lifestyle", title: "سبک زندگی", desc: "ریتم روزانه‌تان به ما کمک می‌کند برنامه‌ای واقع‌بینانه بچینیم.",
    show: () => true, keys: /^ON-(1[3-9]|2[01])/,
    checks: () => [{ k: "ON-13" }, { k: "ON-15.wake", t: "time" }, { k: "ON-15.sleep", t: "time" }, { k: "ON-17" }, { k: "ON-18", msg: "لطفاً سطح استرس را مشخص کنید." }, { k: "ON-19.detail" }, { k: "ON-20.detail" }],
    render: (c) => (
      <>
        <Q id="ON-13" label="در طول روز، به‌جز زمان تمرین، چقدر فعال هستید؟" required error={c.e["ON-13"]}>
          <Choice value={c.a["ON-13"]} onChange={(v) => c.set("ON-13", v)} options={o("ON-13")} />
        </Q>
        <Q id="ON-15" label="معمولاً چه ساعتی بیدار می‌شوید و چه ساعتی می‌خوابید؟" required
          hint="ساعت را به‌صورت ۲۴ ساعته انتخاب یا وارد کنید؛ مثلاً 06:30 یا 23:00.">
          <div className="grid gap-3 sm:grid-cols-2">
            <SubLabel error={c.e["ON-15.wake"]}><span className="text-sm text-muted-foreground">ساعت بیدارشدن</span><TimeField id="ON-15.wake" value={c.a["ON-15.wake"]} onChange={(v) => c.set("ON-15.wake", v)} /></SubLabel>
            <SubLabel error={c.e["ON-15.sleep"]}><span className="text-sm text-muted-foreground">ساعت خوابیدن</span><TimeField id="ON-15.sleep" value={c.a["ON-15.sleep"]} onChange={(v) => c.set("ON-15.sleep", v)} /></SubLabel>
          </div>
        </Q>
        <Q id="ON-17" label="کیفیت خواب شما در هفته‌های اخیر چگونه بوده است؟" required error={c.e["ON-17"]}>
          <Choice cols={2} value={c.a["ON-17"]} onChange={(v) => c.set("ON-17", v)} options={o("ON-17")} />
        </Q>
        <Q id="ON-18" label="در چهار هفتهٔ اخیر، سطح استرس‌تان را از ۰ تا ۱۰ چقدر ارزیابی می‌کنید؟" required error={c.e["ON-18"]}>
          <Scale value={c.a["ON-18"]} onChange={(v) => c.set("ON-18", v)} lo="بدون استرس" hi="بسیار زیاد" labelledBy="l-ON-18" />
        </Q>
        <Q id="ON-19" label="آیا دخانیات مصرف می‌کنید؟">
          <Choice cols={2} value={c.a["ON-19"]} onChange={(v) => c.set("ON-19", v)} options={o("ON-19")} />
          {c.on("ON-19.detail") && (
            <Sub><SubLabel error={c.e["ON-19.detail"]}>
              <span className="text-sm font-medium">لطفاً نوع دخانیات و مقدار مصرف روزانه‌تان را بنویسید.</span>
              <Text value={c.a["ON-19.detail"]} onChange={(v) => c.set("ON-19.detail", v)} />
            </SubLabel><Strong>این اطلاعات در شخصی‌سازی بهتر برنامهٔ شما اثر دارد.</Strong></Sub>
          )}
        </Q>
        <Q id="ON-20" label="الگوی مصرف الکل شما چگونه است؟">
          <Choice value={c.a["ON-20"]} onChange={(v) => c.set("ON-20", v)} options={o("ON-20")} />
          {c.on("ON-20.detail") && (
            <Sub><SubLabel error={c.e["ON-20.detail"]}>
              <span className="text-sm font-medium">لطفاً نوع نوشیدنی و مقدار معمول مصرف در هر نوبت را بنویسید.</span>
              <Text value={c.a["ON-20.detail"]} onChange={(v) => c.set("ON-20.detail", v)} />
            </SubLabel></Sub>
          )}
        </Q>
        {c.on("ON-21") && (
          <Q id="ON-21" label="وضعیت چرخهٔ قاعدگی شما چگونه است؟">
            <Choice value={c.a["ON-21"]} onChange={(v) => c.set("ON-21", v)} options={o("ON-21")} />
            {c.a["ON-21"] && (
              <Sub><SubLabel>
                <span className="text-sm text-muted-foreground">در صورت تمایل دربارهٔ PMS، میل شدید به غذا، افت قند یا ورم بنویسید.</span>
                <Area rows={3} value={c.a["ON-21.note"]} onChange={(v) => c.set("ON-21.note", v)} />
              </SubLabel></Sub>
            )}
          </Q>
        )}
      </>
    ),
  },
  {
    id: "nutrition", title: "تغذیه", desc: "عادت‌ها و ترجیحات غذایی‌تان را بدون قضاوت با ما در میان بگذارید.",
    show: hasNutrition, keys: /^NU-/,
    checks: (a) => [
      { k: "NU-01" }, { k: "NU-01.other" }, { k: "NU-02" }, { k: "NU-03" }, { k: "NU-03.other" }, { k: "NU-05" }, { k: "NU-06.breakfast" }, { k: "NU-06.lunch" }, { k: "NU-06.dinner" }, { k: "NU-06.snacks" }, { k: "NU-06.drinks" },
      { k: "NU-08" }, { k: "NU-08.start", t: "time" }, { k: "NU-08.end", t: "time" }, { k: "NU-10" }, { k: "NU-11" }, { k: "NU-11.detail" }, { k: "NU-13" }, { k: "NU-14" },
      { k: "NU-15" }, ...((a["NU-15"] ?? []) as string[]).filter((s) => s !== "none").map((s) => ({ k: `NU-15.freq.${s}`, msg: "میزان تکرار را مشخص کنید." })),
      { k: "NU-17" }, { k: "NU-18" }, { k: "NU-19" }, { k: "NU-21" },
    ],
    render: (c) => (
      <>
        <Q id="NU-01" label="الگوی غذایی شما بیشتر به کدام گزینه نزدیک است؟" required error={c.e["NU-01"]}>
          <Choice value={c.a["NU-01"]} onChange={(v) => c.set("NU-01", v)} options={o("NU-01")} />
          {c.on("NU-01.other") && <Sub><SubLabel error={c.e["NU-01.other"]}><Text placeholder="توضیح دهید" value={c.a["NU-01.other"]} onChange={(v) => c.set("NU-01.other", v)} /></SubLabel></Sub>}
        </Q>
        <Q id="NU-02" label="آیا غذایی وجود دارد که مصرف آن برای شما واکنش شدید، شوک یا مشکل گوارشی حاد ایجاد کند؟" required error={c.e["NU-02"]}>
          <Choice cols={2} value={c.a["NU-02"]} onChange={(v) => c.set("NU-02", v)} options={o("NU-02")} />
          {c.on("NU-03") && (
            <Sub>
              <p className="text-sm font-medium">کدام موارد؟</p>
              <Multi cols={2} value={c.a["NU-03"]} onChange={(v) => c.set("NU-03", v)} options={o("NU-03")} exclusive={["none"]} />
              {c.e["NU-03"] && <p role="alert" className="text-sm text-destructive">{c.e["NU-03"]}</p>}
              {c.on("NU-03.other") && <SubLabel error={c.e["NU-03.other"]}><Text placeholder="مورد دیگر را بنویسید" value={c.a["NU-03.other"]} onChange={(v) => c.set("NU-03.other", v)} /></SubLabel>}
            </Sub>
          )}
        </Q>
        <Q id="NU-04" label="چه غذاهایی را دوست ندارید یا نمی‌خورید؟" hint="هر غذایی را که به هر دلیلی نمی‌خواهید در برنامه‌تان باشد، برای ما بنویسید.">
          <Area rows={3} value={c.a["NU-04"]} onChange={(v) => c.set("NU-04", v)} placeholder="مثلاً: بادمجان، جگر، قارچ" />
        </Q>
        <Q id="NU-05" label="چه نوع غذاهایی را بیشتر می‌پسندید؟" required error={c.e["NU-05"]}>
          <Choice cols={3} value={c.a["NU-05"]} onChange={(v) => c.set("NU-05", v)} options={o("NU-05")} />
        </Q>
        <Q id="NU-06" label="معمولاً در هر وعده چه غذاهایی می‌خورید؟" hint={<strong className="font-semibold text-brand">برای هر وعده، ۵ تا ۱۰ غذایی را بنویسید که معمولاً می‌خورید تا برنامه با روتین واقعی شما هماهنگ باشد. لطفاً نام غذای کامل را بنویسید؛ مثلاً جوجه‌کباب، خورشت مرغ یا زرشک‌پلو، نه مواد اولیه‌ای مثل مرغ.</strong>} required>
          <SubLabel error={c.e["NU-06.breakfast"]}><span className="text-sm text-muted-foreground">صبحانه</span><Area rows={2} placeholder="املت، تخم‌مرغ آب‌پز، نان و پنیر، اوتمیل، کیک و چای" value={c.a["NU-06.breakfast"]} onChange={(v) => c.set("NU-06.breakfast", v)} /></SubLabel>
          <SubLabel error={c.e["NU-06.lunch"]}><span className="text-sm text-muted-foreground">ناهار</span><Area rows={2} placeholder="زرشک‌پلو با مرغ، پاستا پنه، خورشت کرفس، آبگوشت" value={c.a["NU-06.lunch"]} onChange={(v) => c.set("NU-06.lunch", v)} /></SubLabel>
          <SubLabel error={c.e["NU-06.dinner"]}><span className="text-sm text-muted-foreground">شام</span><Area rows={2} placeholder="املت گوجه، کتلت، سالاد، پیتزا" value={c.a["NU-06.dinner"]} onChange={(v) => c.set("NU-06.dinner", v)} /></SubLabel>
          <SubLabel error={c.e["NU-06.snacks"]}><span className="text-sm text-muted-foreground">میان‌وعده‌ها و ریزه‌خواری‌ها</span><Area rows={2} placeholder="مثال: میوه، آجیل، بیسکویت، شکلات، چیپس" value={c.a["NU-06.snacks"]} onChange={(v) => c.set("NU-06.snacks", v)} /></SubLabel>
          <SubLabel error={c.e["NU-06.drinks"]}><span className="text-sm text-muted-foreground">نوشیدنی‌ها</span><Area rows={2} placeholder="مثال: چای، قهوه، نوشابه، آبمیوه، شیر" value={c.a["NU-06.drinks"]} onChange={(v) => c.set("NU-06.drinks", v)} /></SubLabel>
        </Q>
        <Q id="NU-08" label="آیا در حال حاضر فستینگ یا روزه‌داری متناوب انجام می‌دهید؟" required error={c.e["NU-08"]}>
          <Choice value={c.a["NU-08"]} onChange={(v) => c.set("NU-08", v)} options={o("NU-08")} />
          {c.on("NU-08.start") && (
            <Sub><div className="grid gap-3 sm:grid-cols-2">
              <SubLabel error={c.e["NU-08.start"]}><span className="text-sm font-medium">ساعت شروع پنجرهٔ غذاخوردن</span>
                <TimeField id="NU-08.start" value={c.a["NU-08.start"]} onChange={(v) => c.set("NU-08.start", v)} /></SubLabel>
              <SubLabel error={c.e["NU-08.end"]}><span className="text-sm font-medium">ساعت پایان پنجرهٔ غذاخوردن</span>
                <TimeField id="NU-08.end" value={c.a["NU-08.end"]} onChange={(v) => c.set("NU-08.end", v)} /></SubLabel>
            </div></Sub>
          )}
        </Q>
        <Q id="NU-10" label="معمولاً چند وقت یک‌بار غذای بیرون یا رستورانی می‌خورید؟" required error={c.e["NU-10"]}>
          <Choice cols={2} value={c.a["NU-10"]} onChange={(v) => c.set("NU-10", v)} options={o("NU-10")} />
        </Q>
        <Q id="NU-11" label="آیا پیش از این رژیم غذایی داشته‌اید؟" required error={c.e["NU-11"]}>
          <Choice cols={2} value={c.a["NU-11"]} onChange={(v) => c.set("NU-11", v)} options={o("NU-11")} />
          {c.on("NU-11.detail") && (
            <Sub><SubLabel error={c.e["NU-11.detail"]}>
              <span className="text-sm font-medium">چه رژیم‌هایی و با چه نتیجه‌ای؟</span>
              <Area rows={3} value={c.a["NU-11.detail"]} onChange={(v) => c.set("NU-11.detail", v)} />
            </SubLabel></Sub>
          )}
        </Q>
        <Q id="NU-13" label="روزانه چقدر آب خالص می‌نوشید؟" required error={c.e["NU-13"]}>
          <Choice cols={2} value={c.a["NU-13"]} onChange={(v) => c.set("NU-13", v)} options={o("NU-13")} />
        </Q>
        <Q id="NU-14" label="در طول روز چقدر چای یا قهوه می‌نوشید؟" required error={c.e["NU-14"]}>
          <Text placeholder="مثلاً: ۳ لیوان چای و ۱ فنجان قهوه" value={c.a["NU-14"]} onChange={(v) => c.set("NU-14", v)} />
        </Q>
        <Q id="NU-15" label="در چهار هفتهٔ اخیر کدام علائم گوارشی را داشته‌اید؟" required error={c.e["NU-15"]}>
          <Multi cols={2} value={c.a["NU-15"]} onChange={(v) => c.set("NU-15", v)} options={o("NU-15")} exclusive={["none"]} />
          {((c.a["NU-15"] ?? []) as string[]).filter((s) => s !== "none").map((s) => (
            <Sub key={s}>
              <p className="text-sm font-medium">{o("NU-15").find((x) => x[0] === s)?.[1]} — چند وقت یک‌بار؟</p>
              <Choice cols={3} value={c.a[`NU-15.freq.${s}`]} onChange={(v) => c.set(`NU-15.freq.${s}`, v)} options={o("NU-15.freq")} />
              {c.e[`NU-15.freq.${s}`] && <p role="alert" className="text-sm text-destructive">{c.e[`NU-15.freq.${s}`]}</p>}
            </Sub>
          ))}
        </Q>
        <Q id="NU-16" label="آیا غذایی هست که علائم گوارشی‌تان را تشدید کند؟">
          <Area rows={2} value={c.a["NU-16"]} onChange={(v) => c.set("NU-16", v)} />
        </Q>
        <Q id="NU-17" label="اشتها و ولع غذایی‌تان را چگونه توصیف می‌کنید؟" required error={c.e["NU-17"]}>
          <Choice value={c.a["NU-17"]} onChange={(v) => c.set("NU-17", v)} options={o("NU-17")} />
        </Q>
        <Q id="NU-18" label="کنترل غذاخوردن و رفتار جبرانی" hint="کدام گزینه به تجربهٔ شما نزدیک‌تر است؟ پاسخ شما محرمانه است." required error={c.e["NU-18"]}>
          <Choice value={c.a["NU-18"]} onChange={(v) => c.set("NU-18", v)} options={o("NU-18")} />
        </Q>
        <Q id="NU-19" label="بزرگ‌ترین چالش‌های شما برای پایبندی به برنامهٔ غذایی چیست؟" hint="حداکثر ۳ مورد" required error={c.e["NU-19"]}>
          <Multi cols={2} max={3} value={c.a["NU-19"]} onChange={(v) => c.set("NU-19", v)} options={o("NU-19")} />
        </Q>
        <Q id="NU-21" label="دربارهٔ استفاده از مکمل‌های ورزشی یا تغذیه‌ای چه نظری دارید؟" required error={c.e["NU-21"]}>
          <Choice value={c.a["NU-21"]} onChange={(v) => c.set("NU-21", v)} options={o("NU-21")} />
        </Q>
        <Q id="NU-22" label="آیا نکتهٔ دیگری دربارهٔ تغذیه‌تان هست که لازم باشد بدانیم؟">
          <Area rows={3} value={c.a["NU-22"]} onChange={(v) => c.set("NU-22", v)} />
        </Q>
      </>
    ),
  },
  {
    id: "training", title: "تمرین", desc: "شرایط و امکانات تمرینی‌تان را بگویید تا برنامه اجرایی باشد.",
    show: hasTraining, keys: /^TR-/,
    checks: () => [
      { k: "TR-01" }, { k: "TR-02" }, { k: "TR-03" }, { k: "TR-04" }, { k: "TR-05" }, { k: "TR-06" },
      { k: "TR-07" }, { k: "TR-07.location" }, { k: "TR-07.type" }, { k: "TR-07.clinician" },
      { k: "TR-08" }, { k: "TR-08.location" }, { k: "TR-08.severity", msg: "شدت درد را مشخص کنید." }, { k: "TR-08.onset" }, { k: "TR-08.effect" },
    ],
    render: (c) => {
      const sub = (k: string, label: string, area = false) => (
        <SubLabel error={c.e[k]}>
          <span className="text-sm font-medium">{label}</span>
          {area ? <Area rows={2} value={c.a[k]} onChange={(v) => c.set(k, v)} /> : <Text value={c.a[k]} onChange={(v) => c.set(k, v)} />}
        </SubLabel>
      );
      return (
        <>
          <Q id="TR-01" label="با چه نوع حرکت‌هایی راحت‌تر هستید؟" hint="گزینه‌ای را انتخاب کنید که به تجربهٔ واقعی شما نزدیک‌تر است. اگر مطمئن نیستید، گزینهٔ ساده‌تر را انتخاب کنید تا برنامه با خیال راحت‌تری شروع شود." required error={c.e["TR-01"]}>
            <Choice value={c.a["TR-01"]} onChange={(v) => c.set("TR-01", v)} options={o("TR-01")} />
          {c.on("TR-02") && <Sub><SubLabel error={c.e["TR-02"]}><span className="text-sm font-medium">توانایی فعلی‌تان را با یک مثال بنویسید.</span>
            <Text placeholder="مثلاً می‌توانم ۱۰ برپی و ۱۰ اسکوات را در یک ست انجام بدهم." value={c.a["TR-02"]} onChange={(v) => c.set("TR-02", v)} /></SubLabel></Sub>}
          </Q>
          <Q id="TR-03" label="دوست دارید چند روز در هفته تمرین کنید؟" required error={c.e["TR-03"]}>
            <Choice cols={3} value={c.a["TR-03"]} onChange={(v) => c.set("TR-03", v)} options={o("TR-03")} />
          </Q>
          <Q id="TR-04" label="برای هر جلسهٔ تمرین چقدر زمان دارید؟" required error={c.e["TR-04"]}>
            <Choice cols={2} value={c.a["TR-04"]} onChange={(v) => c.set("TR-04", v)} options={o("TR-04")} />
          </Q>
          <Q id="TR-05" label="معمولاً کجا تمرین می‌کنید؟" hint="محلی را انتخاب کنید که بیشتر تمرین‌های شما در آن انجام می‌شود. بر اساس این انتخاب، حرکت‌های برنامه با تجهیزات در دسترس شما هماهنگ می‌شوند." required error={c.e["TR-05"]}>
            <Choice value={c.a["TR-05"]} onChange={(v) => c.set("TR-05", v)} options={o("TR-05")} />
          </Q>
          {c.on("TR-06") && (
            <Q id="TR-06" label="کدام تجهیزات را در اختیار دارید؟" hint="همهٔ موارد موجود را انتخاب کنید." required error={c.e["TR-06"]}>
              <ImageCards value={c.a["TR-06"]} onChange={(v) => c.set("TR-06", v)} options={o("TR-06")} images={EQUIP_IMG} exclusive={["none"]} />
              {(c.a["TR-06"] ?? []).includes("none") && <Note tone="warn">برای اجرای بهتر برنامه، پیشنهاد می‌کنیم حداقل یک جفت دمبل داشته باشید.</Note>}
              <div className="space-y-2.5 rounded-xl border border-border p-3">
                <SubLabel><span className="text-sm font-medium">وسیلهٔ دیگری دارید؟</span>
                  <Text placeholder="نام وسیله" value={c.a["TR-06.other_name"]} onChange={(v) => c.set("TR-06.other_name", v)} /></SubLabel>
                <FileDrop accept=".jpg,.jpeg,.png" maxMB={20} label="عکس وسیله" value={c.a["TR-06.other_photo"]} onChange={(v) => c.set("TR-06.other_photo", v)} error={(m) => c.fileErr("TR-06.other_photo", m)} />
                {c.e["TR-06.other_photo"] && <p role="alert" className="text-sm text-destructive">{c.e["TR-06.other_photo"]}</p>}
              </div>
            </Q>
          )}
          <Q id="TR-07" label="آیا ناهنجاری یا محدودیت حرکتی تأییدشده‌ای دارید؟" required error={c.e["TR-07"]}>
            <Choice cols={2} value={c.a["TR-07"]} onChange={(v) => c.set("TR-07", v)} options={o("TR-07")} />
            {c.on("TR-07.location") && (
              <Sub>{sub("TR-07.location", "محل محدودیت")}{sub("TR-07.type", "نوع محدودیت")}{sub("TR-07.clinician", "نظر پزشک یا فیزیوتراپیست", true)}</Sub>
            )}
          </Q>
          <Q id="TR-08" label="آیا در حال حاضر دردی دارید که روی فعالیت یا تمرین شما اثر بگذارد؟" required error={c.e["TR-08"]}>
            <Choice cols={2} value={c.a["TR-08"]} onChange={(v) => c.set("TR-08", v)} options={o("TR-08")} />
            {c.on("TR-08.location") && (
              <Sub>
                {sub("TR-08.location", "محل درد")}
                {/* Not a <label>: a wrapping label would let a click on the caption, the end labels or the hint activate the slider and record 5. */}
                <div className="space-y-1.5">
                  <span id="l-TR-08.severity" className="text-sm font-medium">شدت درد (۰ تا ۱۰)</span>
                  <Scale value={c.a["TR-08.severity"]} onChange={(v) => c.set("TR-08.severity", v)} lo="بدون درد" hi="شدیدترین" labelledBy="l-TR-08.severity" />
                  {c.e["TR-08.severity"] && <span role="alert" className="block text-sm text-destructive">{c.e["TR-08.severity"]}</span>}
                </div>
                {sub("TR-08.onset", "از چه زمانی شروع شده است؟")}
                {sub("TR-08.effect", "فعالیت چه اثری روی درد دارد؟", true)}
              </Sub>
            )}
          </Q>
          <Q id="TR-09" label="آیا نکتهٔ دیگری دربارهٔ تمرین‌تان هست که لازم باشد بدانیم؟">
            <Area rows={3} value={c.a["TR-09"]} onChange={(v) => c.set("TR-09", v)} />
          </Q>
        </>
      );
    },
  },
  {
    id: "health", title: "سلامت، دارو و وضعیت زنان", desc: "این اطلاعات محرمانه است و فقط برای ایمنی برنامهٔ شما استفاده می‌شود.",
    show: () => true, keys: /^(HL-|ON-10)/,
    checks: (a) => [
      { k: "HL-02" }, { k: "HL-03a" }, { k: "ON-10", t: "num", min: 25, max: 350, unit: "کیلوگرم" }, { k: "HL-03b" }, { k: "HL-04" },
      ...((a["HL-04"] ?? []) as string[]).filter((m) => m !== "none").flatMap((m) => [{ k: `HL-04.${m}.name` }, { k: `HL-04.${m}.dose` }]),
      { k: "HL-05" }, { k: "HL-05.name" }, { k: "HL-05.dose" }, { k: "HL-05.time" }, { k: "HL-05.reason" },
      { k: "HL-06" }, { k: "HL-07" }, { k: "HL-08" }, { k: "HL-08.type" }, { k: "HL-08.area" }, { k: "HL-08.when" },
    ],
    render: (c) => {
      const sub = (k: string, label: string) => (
        <SubLabel error={c.e[k]}>
          <span className="text-sm font-medium">{label}</span>
          <Text value={c.a[k]} onChange={(v) => c.set(k, v)} />
        </SubLabel>
      );
      return (
        <>
          <Strong>پاسخ‌های این بخش محرمانه‌اند و فقط در اختیار متخصص برنامهٔ شما قرار می‌گیرند.</Strong>
          <Q id="HL-02" label="شرایط تشخیص‌داده‌شده یا تحت پیگیری" hint="همهٔ موارد مرتبط را انتخاب کنید." required error={c.e["HL-02"]}>
            <Multi cols={2} value={c.a["HL-02"]} onChange={(v) => c.set("HL-02", v)} options={o("HL-02")} exclusive={["none"]} />
          </Q>
          {c.on("HL-03a") && (
            <Q id="HL-03a" label="آیا باردار هستید یا در دوران شیردهی قرار دارید؟" required error={c.e["HL-03a"]}>
              <Choice value={c.a["HL-03a"]} onChange={(v) => c.set("HL-03a", v)} options={o("HL-03a")} />
              {c.on("ON-10") && (
                <Sub><SubLabel error={c.e["ON-10"]}>
                  <span className="text-sm font-medium">وزن شما پیش از بارداری چقدر بوده است؟</span>
                  <Num unit="کیلوگرم" value={c.a["ON-10"]} onChange={(v) => c.set("ON-10", v)} />
                </SubLabel></Sub>
              )}
              {c.on("HL-03b") && (
                <Sub>
                  <p className="text-sm font-medium">بازهٔ سنی کودک</p>
                  <Choice cols={2} value={c.a["HL-03b"]} onChange={(v) => c.set("HL-03b", v)} options={o("HL-03b")} />
                  {c.e["HL-03b"] && <p role="alert" className="text-sm text-destructive">{c.e["HL-03b"]}</p>}
                </Sub>
              )}
            </Q>
          )}
          <Q id="HL-04" label="آیا در حال حاضر دارویی مصرف می‌کنید؟" required error={c.e["HL-04"]}>
            <Multi value={c.a["HL-04"]} onChange={(v) => c.set("HL-04", v)} options={o("HL-04")} exclusive={["none"]} />
            {((c.a["HL-04"] ?? []) as string[]).filter((m) => m !== "none").map((m) => (
              <Sub key={m}>
                <p className="text-sm font-semibold text-primary">{o("HL-04").find((x) => x[0] === m)?.[1]}</p>
                <div className="grid gap-3 sm:grid-cols-2">{sub(`HL-04.${m}.name`, "نام دقیق دارو")}{sub(`HL-04.${m}.dose`, "دوز مصرفی")}</div>
              </Sub>
            ))}
          </Q>
          <Q id="HL-05" label="آیا در حال حاضر مکمل مصرف می‌کنید؟" required error={c.e["HL-05"]}>
            <Choice cols={3} value={c.a["HL-05"]} onChange={(v) => c.set("HL-05", v)} options={o("HL-05")} />
            {c.on("HL-05.name") && (
              <Sub><div className="grid gap-3 sm:grid-cols-2">{sub("HL-05.name", "نام یا برند")}{sub("HL-05.dose", "دوز")}{sub("HL-05.time", "زمان مصرف")}{sub("HL-05.reason", "دلیل مصرف")}</div></Sub>
            )}
          </Q>
          <Q id="HL-06" label="آیا داروی کاهش وزن، کنترل قند خون یا کنترل اشتها مصرف می‌کنید یا در ۱۲ ماه اخیر مصرف کرده‌اید؟" required error={c.e["HL-06"]}>
            <Choice value={c.a["HL-06"]} onChange={(v) => c.set("HL-06", v)} options={o("HL-06")} />
            {c.on("HL-06.name") && <Sub>{sub("HL-06.name", "نام دارو")}</Sub>}
          </Q>
          <Q id="HL-07" label="آیا سابقهٔ جراحی زیبایی دارید؟" required error={c.e["HL-07"]}>
            <Multi cols={2} value={c.a["HL-07"]} onChange={(v) => c.set("HL-07", v)} options={o("HL-07")} exclusive={["none"]} />
          </Q>
          <Q id="HL-08" label="آیا سابقهٔ جراحی عمومی دارید؟" required error={c.e["HL-08"]}>
            <Choice cols={2} value={c.a["HL-08"]} onChange={(v) => c.set("HL-08", v)} options={o("HL-08")} />
            {c.on("HL-08.type") && <Sub>{sub("HL-08.type", "نوع جراحی")}{sub("HL-08.area", "ناحیه")}{sub("HL-08.when", "زمان انجام")}</Sub>}
          </Q>
          <Q id="HL-09" label="آیا مایلید مدرک پزشکی مرتبطی بارگذاری کنید؟" error={c.e["HL-09"]}>
            <FileDrop accept=".pdf,.jpg,.jpeg,.png" maxMB={20} value={c.a["HL-09"]} onChange={(v) => c.set("HL-09", v)} error={(m) => c.fileErr("HL-09", m)} />
          </Q>
        </>
      );
    },
  },
  {
    id: "measures", title: "اندازه‌گیری و عکس", desc: "برای ارزیابی دقیق‌تر و دنبال‌کردن پیشرفت.",
    show: () => true, keys: /^MS-/,
    checks: (a) => [
      { k: "MS-02", t: "num", min: 40, max: 250, unit: "سانتی‌متر" }, { k: "MS-03", t: "num", min: 40, max: 250, unit: "سانتی‌متر" },
      ...(PHOTO_KEYS.some((k) => a[k]) ? [] : [{ k: "MS-04", msg: "حداقل یک عکس بارگذاری کنید یا گزینهٔ «فعلاً مایل به ارسال عکس نیستم» را انتخاب کنید." }]),
      { k: "MS-04.ack", t: "true", msg: "لطفاً برای ادامه بدون عکس، این مورد را تأیید کنید." },
      ...MEASURE_KEYS.map((k) => ({ k, t: "num" as const, min: 5, max: 200, unit: "سانتی‌متر" })),
      { k: "MS-06.photo", optional: true },
    ],
    render: (c) => (
      <>
        <Q id="MS-02" label="دور کمر و دور باسن" required>
          <SubLabel error={c.e["MS-02"]}><span className="text-sm font-medium">دور کمر شما چقدر است؟</span><span className="block text-[13px] leading-6 text-muted-foreground">شکم را در حالت طبیعی نگه دارید؛ نه داخل بدهید و نه بیرون. متر را صاف، موازی زمین و به‌صورت افقی از روی ناف عبور دهید.</span><Num unit="سانتی‌متر" value={c.a["MS-02"]} onChange={(v) => c.set("MS-02", v)} /></SubLabel>
          <SubLabel error={c.e["MS-03"]}><span className="text-sm font-medium">دور باسن شما چقدر است؟</span><span className="block text-[13px] leading-6 text-muted-foreground">در حالت طبیعی و بدون منقبض‌کردن عضلات بایستید. متر را از پهن‌ترین بخش باسن عبور دهید و مطمئن شوید کاملاً افقی و موازی زمین است.</span><Num unit="سانتی‌متر" value={c.a["MS-03"]} onChange={(v) => c.set("MS-03", v)} /></SubLabel>
        </Q>
        <Q id="MS-04" label="عکس بدن" required error={c.e["MS-04"]}>
          <Strong>مشاهدهٔ عکس بدن، در کنار اندازه‌گیری‌ها، به ما کمک می‌کند برنامه‌تان را با توجه به فرم بدنی، حجم عضله، میزان چربی و ساختار بدنی شما شخصی‌سازی کنیم.</Strong>
          {c.on("MS-05.front") && (
            <Sub>
              <Note>ارسال عکس اختیاری است و لازم نیست چهره در تصویر دیده شود. لطفاً با لباس ورزشی یا لباس راحت، در نور مناسب و از فاصله‌ای عکس بگیرید که تمام بدن مشخص باشد.<br />دوربین هم‌ارتفاع بدن باشد، تصویر واضح و بدون فیلتر باشد، نور کافی داشته باشید و تمام قد در کادر دیده شود.</Note>
              {([
                { key: "front", label: "عکس از روبه‌رو", img: poseFront },
                { key: "back", label: "عکس از پشت", img: poseBack },
                { key: "side", label: "عکس از پهلو در حالت خنثی", img: poseSide, description: "پهلو در حالت خنثی: برای مشاهدهٔ وضعیت شانه‌ها" },
                { key: "side_forward", label: "عکس از پهلو با دست‌ها رو به جلو", img: poseSideForward, description: "پهلو با دست‌ها رو به جلو: برای مشاهدهٔ وضعیت لگن و کمر" },
              ] as { key: string; label: string; img: string; description?: string }[]).map(({ key: p, label, description, img }) => (
                <div key={p} className="space-y-2">
                  <img src={img} alt={`نمونهٔ ژست ${label}`} loading="lazy" width={384} height={1024} className="mx-auto h-40 w-auto rounded-lg border border-border bg-surface object-contain" />
                  <FileDrop accept=".jpg,.jpeg,.png" maxMB={20} label={label} description={description}
                    value={c.a[`MS-05.${p}`]} onChange={(v) => c.set(`MS-05.${p}`, v)} error={(m) => c.fileErr(`MS-05.${p}`, m)} />
                  {c.e[`MS-05.${p}`] && <p role="alert" className="mt-1 text-sm text-destructive">{c.e[`MS-05.${p}`]}</p>}
                </div>
              ))}
            </Sub>
          )}
          {!PHOTO_KEYS.some((k) => c.a[k]) && (
            <CheckLine checked={c.a["MS-04"] === "no"} onChange={(v) => c.set("MS-04", v ? "no" : undefined)}>فعلاً مایل به ارسال عکس نیستم.</CheckLine>
          )}
          {c.on("MS-04.ack") && (
            <Sub>
              <CheckLine checked={c.a["MS-04.ack"]} onChange={(v) => c.set("MS-04.ack", v)}>آگاه هستم که درخواست دارم برنامه‌ام بدون درنظرگرفتن عکس، نسبت چربی به عضله و برخی جزئیات فرم بدنی تدوین شود و شخصی‌سازی آن بر اطلاعات محدودتر فرم انجام خواهد شد.</CheckLine>
              {c.e["MS-04.ack"] && <p role="alert" className="text-sm text-destructive">{c.e["MS-04.ack"]}</p>}
            </Sub>
          )}
        </Q>
        {c.on("MS-07.neck") && (
          <Q id="MS-07" label="اندازه‌گیری‌های تکمیلی" hint="چون عکسی ارسال نمی‌کنید، لطفاً این اندازه‌ها را بر حسب سانتی‌متر وارد کنید." required>
            <div className="conditional-fields space-y-4">
              {MEASURES.map(([k, label, hint]) => (
                <SubLabel key={k} error={c.e[`MS-07.${k}`]}>
                  <span className="text-sm font-medium">{label}</span>
                  <span className="block text-[13px] leading-6 text-muted-foreground">{hint}</span>
                  <Num unit="سانتی‌متر" value={c.a[`MS-07.${k}`]} onChange={(v) => c.set(`MS-07.${k}`, v)} />
                </SubLabel>
              ))}
            </div>
          </Q>
        )}
        {c.on("MS-06.consent") && (
          <Q id="MS-06" label="عکس سلولیت (افزونهٔ سلولیت)" hint="این بخش مخصوص افزونهٔ سلولیت سفارش شماست و رضایت جداگانه دارد." error={c.e["MS-06.photo"]}>
            <CheckLine checked={c.a["MS-06.consent"]} onChange={(v) => c.set("MS-06.consent", v)}>
              رضایت می‌دهم عکس نواحی سلولیت را فقط برای ارزیابی برنامهٔ سلولیت ارسال کنم.
            </CheckLine>
            {c.on("MS-06.photo") && (
              <Sub>
                <p className="text-sm text-muted-foreground">عکس را در حالت ریلکس و از فاصلهٔ نزدیک بگیرید.</p>
                <FileDrop accept=".jpg,.jpeg,.png" maxMB={20} value={c.a["MS-06.photo"]} onChange={(v) => c.set("MS-06.photo", v)} error={(m) => c.fileErr("MS-06.photo", m)} />
              </Sub>
            )}
          </Q>
        )}
      </>
    ),
  },
  {
    id: "consent", title: "رضایت", desc: "پیش از مرور نهایی، این موارد را تأیید کنید.",
    show: () => true, keys: /^CN-/,
    checks: () => [{ k: "CN-01", t: "true" }, { k: "CN-02", t: "true" }, { k: "CN-03", t: "true" }],
    render: (c) => (
      <>
        <Q id="CN-01" label="تأیید صحت اطلاعات" required error={c.e["CN-01"]}>
          <CheckLine checked={c.a["CN-01"]} onChange={(v) => c.set("CN-01", v)}>تأیید می‌کنم اطلاعات این فرم را تا حد امکان دقیق وارد کرده‌ام و می‌دانم این فرم جایگزین تشخیص یا درمان پزشکی نیست.</CheckLine>
        </Q>
        {c.on("CN-02") && (
          <Q id="CN-02" label="رضایت پردازش دادهٔ سلامت" required error={c.e["CN-02"]}>
            <CheckLine checked={c.a["CN-02"]} onChange={(v) => c.set("CN-02", v)}>رضایت می‌دهم Six2Fit اطلاعات سلامت من را صرفاً برای طراحی و پیگیری برنامهٔ شخصی‌ام پردازش کند.</CheckLine>
          </Q>
        )}
        <Q id="CN-03" label="شرایط و ضوابط" required error={c.e["CN-03"]}>
          <CheckLine checked={c.a["CN-03"]} onChange={(v) => c.set("CN-03", v)}>شرایط و ضوابط Six2Fit را مطالعه کرده‌ام و می‌پذیرم.</CheckLine>
        </Q>
      </>
    ),
  },
];

