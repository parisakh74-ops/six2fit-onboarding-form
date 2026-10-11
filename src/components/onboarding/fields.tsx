import { useMemo, useRef, useState, type ReactNode } from "react";
import * as React from "react";
import { COUNTRY_LIST, byIso, flagOf, searchCountries, searchDial, digitsEn, type Country } from "@/lib/onboarding/countries";
import { Check } from "lucide-react";
import { GhostButton } from "./shell";
import { cn } from "@/lib/utils";
import type { Opt } from "@/lib/onboarding/data";

export type PrefillState = { state?: "confirmed" | "edited" | undefined; onConfirm: () => void };

export function Q({
  id, label, hint, error, prefill, children,
}: {
  id: string; label: ReactNode; hint?: ReactNode | undefined; required?: boolean | undefined; error?: string | undefined;
  prefill?: PrefillState | undefined; children: ReactNode;
}) {
  return (
    <section className="q-card" data-error={!!error} id={`q-${id}`} aria-labelledby={`l-${id}`}>
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
        <h3 id={`l-${id}`} className="text-[15px] font-semibold leading-7">
          {label}
        </h3>
        {prefill && <PrefillBadge {...prefill} />}
      </div>
      {hint && <p className="mb-2.5 text-[13px] leading-6 text-muted-foreground">{hint}</p>}
      <div className="space-y-2.5">{children}</div>
      {error && <p role="alert" className="mt-3 text-sm font-medium text-destructive">{error}</p>}
    </section>
  );
}

function PrefillBadge({ state }: PrefillState) {
  if (state === "edited") return null;
  return <span className="chip bg-surface text-muted-foreground">اطلاعات قبلی</span>;
}

export function Choice({ value, onChange, options, cols = 1 }: { value?: string; onChange: (v: string) => void; options: Opt[]; cols?: 1 | 2 | 3  | undefined}) {
  return (
    <div role="radiogroup" className={cn("grid gap-2.5", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3")}>
      {options.map(([v, l, d]) => (
        <label key={v} data-selected={value === v} className={cn("option", d && "items-start")}><input type="radio" className="sr-only" checked={value === v} onChange={() => onChange(v)} />
          <span className={cn("option-mark", d && "mt-1")}>{value === v && <span className="size-2 rounded-full bg-brand-foreground" />}</span>
          <span>{d ? <><span className="block font-medium">{l}</span><span className="mt-0.5 block text-[13px] leading-6 text-muted-foreground">{d}</span></> : l}</span>
        </label>
      ))}
    </div>
  );
}

export function Multi({ value, onChange, options, exclusive = [], max, cols = 1 }: {
  value?: string[]; onChange: (v: string[]) => void; options: Opt[]; exclusive?: string[] | undefined; max?: number | undefined; cols?: 1 | 2 | undefined;
}) {
  const cur = value ?? [];
  const toggle = (v: string) => {
    if (cur.includes(v)) return onChange(cur.filter((x) => x !== v));
    if (exclusive.includes(v)) return onChange([v]);
    const next = [...cur.filter((x) => !exclusive.includes(x)), v];
    if (max && next.length > max) return;
    onChange(next);
  };
  return (
    <div className={cn("grid gap-2.5", cols === 2 && "sm:grid-cols-2")}>
      {options.map(([v, l]) => {
        const sel = cur.includes(v);
        const disabled = !sel && !!max && cur.length >= max && !exclusive.includes(v);
        return (
          <label key={v} data-selected={sel} className="option"><input type="checkbox" className="sr-only" checked={sel} disabled={disabled} onChange={() => toggle(v)} />
            <span className="option-mark option-mark-sq">{sel && <span className="size-2 rounded-[2px] bg-brand-foreground" />}</span>
            <span>{l}</span>
          </label>
        );
      })}
      {max && <p className="text-xs text-muted-foreground">{cur.length.toLocaleString("fa")} از {max.toLocaleString("fa")} مورد انتخاب شده</p>}
    </div>
  );
}

export function CheckLine({ checked, onChange, children }: { checked?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label data-selected={!!checked} className="option items-start"><input type="checkbox" className="sr-only" checked={!!checked} onChange={() => onChange(!checked)} />
      <span className="option-mark option-mark-sq mt-0.5">{checked && <Check className="size-3.5 text-brand-foreground" strokeWidth={3} />}</span>
      <span className="leading-7">{children}</span>
    </label>
  );
}

export function Text({ value, onChange, ...p }: { value?: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return <input className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value)} {...p} />;
}

export function Num({ value, onChange, unit, ...p }: { value?: string; onChange: (v: string) => void; unit?: string  | undefined} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className="relative">
      <input className="field pe-20" type="text" inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" dir="ltr" style={{ textAlign: "right" }} value={value ?? ""} onChange={(e) => onChange(normalizeNumber(e.target.value))} {...p} />
      {unit && <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm text-muted-foreground">{unit}</span>}
    </div>
  );
}

export function Area({ value, onChange, ...p }: { value?: string; onChange: (v: string) => void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  return <textarea className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value)} {...p} />;
}

export function Select({ value, onChange, options, placeholder }: { value?: string; onChange: (v: string) => void; options: string[]; placeholder?: string  | undefined}) {
  return (
    <select className="field appearance-none" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>{placeholder ?? "انتخاب کنید"}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function Scale({ value, onChange, min = 0, max = 10, lo, hi }: { value?: number; onChange: (v: number) => void; min?: number | undefined; max?: number | undefined; lo?: string | undefined; hi?: string  | undefined}) {
  const touched = typeof value === "number";
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-center gap-1">
        <span className={cn("text-4xl font-bold tabular-nums", touched ? "text-brand" : "text-muted-foreground/40")}>{typeof value === "number" ? value.toLocaleString("fa") : "–"}</span>
        <span className="text-sm text-muted-foreground">/ {max.toLocaleString("fa")}</span>
      </div>
      <input type="range" dir="rtl" className="range" min={min} max={max} step={1} value={touched ? value : Math.round((min + max) / 2)}
        onChange={(e) => onChange(Number(e.target.value))} onClick={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{lo ?? min.toLocaleString("fa")}</span><span>{hi ?? max.toLocaleString("fa")}</span></div>
    </div>
  );
}

export type FileMeta = { name: string; size: number; type: string; status: "uploaded" };

export function FileDrop({ value, onChange, accept, maxMB, label, description, error }: {
  value?: FileMeta | null; onChange: (v: FileMeta | null) => void; accept: string; maxMB: number; label?: string | undefined; description?: string | undefined; error?: (m: string) => void | undefined;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = (f?: File) => {
    if (!f) return;
    const okTypes = accept.split(",").map((s) => s.trim().toLowerCase());
    const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
    if (!okTypes.includes(ext)) return error?.("فرمت فایل مجاز نیست.");
    if (f.size > maxMB * 1024 * 1024) return error?.(`حجم فایل باید کمتر از ${maxMB.toLocaleString("fa")} مگابایت باشد.`);
    onChange({ name: f.name, size: f.size, type: f.type, status: "uploaded" });
  };
  if (value)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-brand bg-brand-soft px-4 py-3">
        <div className="min-w-0">
          {label && <p className="text-xs text-muted-foreground">{label}</p>}
          {description && <p className="text-xs leading-6 text-muted-foreground">{description}</p>}
          <p className="truncate text-sm font-medium" dir="ltr">{value.name}</p>
          <p className="text-xs text-brand">بارگذاری شد · {(value.size / 1024 / 1024).toLocaleString("fa", { maximumFractionDigits: 1 })} مگابایت</p>
        </div>
        <GhostButton aria-label="حذف فایل" className="px-3 py-2 text-[13px]" onClick={() => onChange(null)}>حذف</GhostButton>
      </div>
    );
  return (
    <GhostButton onClick={() => ref.current?.click()}
      className="flex w-full flex-col items-center gap-1 rounded-xl border border-border bg-surface px-4 py-6 text-center transition hover:border-brand">
      <span className="text-sm font-medium">{label ?? "انتخاب فایل"}</span>
      {description && <span className="text-xs leading-6 text-muted-foreground">{description}</span>}
      <span className="text-xs text-muted-foreground" dir="ltr">{accept.replaceAll(".", "").toUpperCase()} · ≤ {maxMB}MB</span>
      <input ref={ref} type="file" hidden accept={accept} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    </GhostButton>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | undefined; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 text-[13px] leading-6 text-muted-foreground">
      <span>{children}</span>
    </div>
  );
}

export function Sub({ children }: { children: ReactNode }) {
  return <div className="conditional-fields space-y-3 pt-2">{children}</div>;
}

export function SubLabel({ children, error }: { children: ReactNode; error?: string  | undefined}) {
  return (
    <label className="block space-y-1.5">
      {children}
      {error && <span role="alert" className="block text-sm text-destructive">{error}</span>}
    </label>
  );
}

/** Persian/Arabic digits → English digits; keeps only digits and one decimal point. */
export const normalizeNumber = (v: string) => {
  const d = digitsEn(v).replace(/[٫,]/g, ".").replace(/[^0-9.]/g, "");
  const i = d.indexOf(".");
  return i === -1 ? d : d.slice(0, i + 1) + d.slice(i + 1).replace(/\./g, "");
};
export const normalizePhone = (v: string) => digitsEn(v).replace(/[^0-9\s-]/g, "");

/** 24-hour HH:MM: digits are normalised and a colon is inserted automatically. */
export const normalizeTime = (v: string) => {
  const d = digitsEn(v).replace(/[^0-9:]/g, "");
  if (d.includes(":")) return d.slice(0, 5);
  return d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2, 4)}` : d;
};
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

export function TimeField({ id, value, onChange }: { id: string; value?: string; onChange: (v: string) => void }) {
  return (
    <>
      <input className="field" list={`${id}-times`} type="text" inputMode="numeric" dir="ltr" style={{ textAlign: "right" }} placeholder="HH:MM" maxLength={5}
        value={value ?? ""} onChange={(e) => onChange(normalizeTime(e.target.value))} aria-label={id} />
      <datalist id={`${id}-times`}>{TIMES.map((t) => <option key={t} value={t} />)}</datalist>
    </>
  );
}

function Picker({ value, onSelect, search, render, placeholder, compact }: {
  value?: Country | undefined; onSelect: (c: Country) => void; search: (q: string) => Country[]; render: (c: Country) => ReactNode; placeholder: string; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = useMemo(() => search(q), [q, search]);
  return (
    <div className={cn("relative", compact ? "w-36 shrink-0" : "w-full")}>
      <button type="button" className="field flex items-center justify-between gap-2 text-start" aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen((o) => !o); setQ(""); }}>
        <span className="truncate">{value ? render(value) : <span className="text-muted-foreground">{placeholder}</span>}</span>
        <span aria-hidden className="text-muted-foreground">▾</span>
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 min-w-[16rem] rounded-xl border border-border bg-card p-2 shadow-lg">
          <input autoFocus className="field mb-2" dir="ltr" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جست‌وجو"
            onKeyDown={(e) => { if (e.key === "Enter" && list[0]) { e.preventDefault(); onSelect(list[0]); setOpen(false); } if (e.key === "Escape") setOpen(false); }} />
          <ul role="listbox" className="max-h-64 overflow-auto">
            {list.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">نتیجه‌ای پیدا نشد</li>}
            {list.map((c) => (
              <li key={c.iso} role="option" aria-selected={value?.iso === c.iso}>
                <button type="button" className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-surface", value?.iso === c.iso && "bg-brand-soft text-brand")}
                  onClick={() => { onSelect(c); setOpen(false); }}>
                  <span>{flagOf(c.iso)}</span><span className="flex-1">{c.fa} <span className="text-muted-foreground" dir="ltr">{c.en}</span></span><span dir="ltr" className="text-muted-foreground">+{c.dial}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CountrySelect({ value, onChange }: { value?: string; onChange: (iso: string) => void }) {
  return <Picker value={byIso(value)} onSelect={(c) => onChange(c.iso)} search={searchCountries} placeholder="کشور را انتخاب کنید" render={(c) => <>{flagOf(c.iso)} {c.fa} <span className="text-muted-foreground">{c.en}</span></>} />;
}

/** Dial-code picker; the selected country (ISO) is kept so shared codes like +1 stay unambiguous. */
export function DialSelect({ iso, dial, onChange }: { iso?: string; dial?: string; onChange: (c: Country) => void }) {
  const cur = byIso(iso) ?? COUNTRY_LIST.find((c) => `+${c.dial}` === dial);
  return <Picker compact value={cur} onSelect={onChange} search={searchDial} placeholder="Canada +1" render={(c) => <span dir="ltr">{flagOf(c.iso)} +{c.dial}</span>} />;
}

export function ImageCards({ value, onChange, options, images, exclusive = [] }: { value?: string[]; onChange: (v: string[]) => void; options: Opt[]; images: Record<string, string>; exclusive?: string[] }) {
  const cur = value ?? [];
  const toggle = (v: string) => {
    if (cur.includes(v)) return onChange(cur.filter((x) => x !== v));
    if (exclusive.includes(v)) return onChange([v]);
    onChange([...cur.filter((x) => !exclusive.includes(x)), v]);
  };
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {options.map(([v, l]) => {
        const sel = cur.includes(v);
        return (
          <label key={v} data-selected={sel} className="option flex-col items-center gap-2 p-3 text-center">
            <input type="checkbox" className="sr-only" checked={sel} onChange={() => toggle(v)} />
            <span className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-surface">
              {images[v] ? <img src={images[v]} alt="" loading="lazy" className="size-full object-contain p-2" /> : <span className="text-2xl text-muted-foreground">—</span>}
            </span>
            <span className="text-[13px] leading-5">{l}</span>
          </label>
        );
      })}
    </div>
  );
}

export const GREG_MONTHS = ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"];
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y || 2000, m, 0)).getUTCDate();
export function ageOn(iso: string, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return NaN;
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return NaN;
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age--;
  return age;
}

export function BirthDateField({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const init = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const [p, setP] = React.useState({ d: init ? String(+init[3]!) : "", m: init ? String(+init[2]!) : "", y: init?.[1] ?? "" });
  React.useEffect(() => {
    const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
    if (r) setP({ d: String(+r[3]!), m: String(+r[2]!), y: r[1]! });
  }, [value]);
  const thisYear = new Date().getFullYear();
  const maxDay = p.m ? daysInMonth(+p.y, +p.m) : 31;
  const upd = (k: "d" | "m" | "y", v: string) => {
    const n = { ...p, [k]: v };
    if (n.d && n.m && +n.d > daysInMonth(+n.y, +n.m)) n.d = "";
    setP(n);
    onChange(n.d && n.m && n.y ? `${n.y}-${n.m.padStart(2, "0")}-${n.d.padStart(2, "0")}` : "");
  };
  const sel = (k: "d" | "m" | "y", label: string, opts: [string, string][]) => (
    <label className="block">
      <span className="mb-1 block text-[12px] text-muted-foreground">{label}</span>
      <select aria-label={label} className="field appearance-none" value={p[k]} onChange={(e) => upd(k, e.target.value)}>
        <option value="" disabled>{label}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  return (
    <div className="grid grid-cols-[1fr_1.4fr_1.2fr] gap-2">
      {sel("d", "روز", Array.from({ length: maxDay }, (_, i) => [String(i + 1), (i + 1).toLocaleString("fa")]))}
      {sel("m", "ماه", GREG_MONTHS.map((n, i) => [String(i + 1), n]))}
      {sel("y", "سال", Array.from({ length: 101 }, (_, i) => { const y = thisYear - i; return [String(y), y.toLocaleString("fa", { useGrouping: false })]; }))}
    </div>
  );
}
