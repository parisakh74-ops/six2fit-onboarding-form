import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import logoSrc from "@/assets/brand/6toFit_logotype_Black_1.svg";

export function Logo() {
  return (
    <img
      src={logoSrc}
      alt="6toFit"
      className="h-6 w-auto select-none sm:h-7"
      draggable={false}
    />
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface px-4 pb-10 sm:py-10">
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-6 flex h-16 items-center justify-between border-b border-border sm:rounded-t-2xl sm:border sm:bg-card sm:px-6">
          <Logo />
          <span className="text-[14px] font-medium text-foreground">مشاوره تخصصی</span>
        </header>
        {children}
        <footer className="mt-6 text-center text-[12px] leading-6 text-muted-foreground">
          این فرم جایگزین تشخیص یا درمان پزشکی نیست.
        </footer>
      </div>
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(22,22,24,0.03)] sm:p-8",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function StepProgress({
  current,
  total,
  title,
}: {
  current: number;
  total: number;
  title: string;
}) {
  const pct = Math.round((current / total) * 100);
  return (
    <div className="mb-8 space-y-3 px-0 sm:px-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-[14px] font-medium text-muted-foreground">{title}</p>
        <p dir="rtl" className="shrink-0 text-[14px] text-muted-foreground">
          سؤال {current.toLocaleString("fa")} از {total.toLocaleString("fa")}
        </p>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="پیشرفت فرم"
        className="h-2.5 w-full overflow-hidden rounded-full border border-border bg-card p-px"
      >
        <div
          className="h-full rounded-full bg-progress transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const btnBase =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 py-3 text-[16px] font-bold leading-[22px] transition-[background-color,box-shadow,transform] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[#e9e9eb] disabled:text-[#9b9ba1] disabled:opacity-100";

export function PrimaryButton({
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(btnBase, "bg-brand text-brand-foreground shadow-sm hover:bg-brand-strong", className)}
      {...rest}
    />
  );
}

export function GhostButton({
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        btnBase,
        "border border-input bg-card text-foreground hover:border-brand hover:bg-brand-soft",
        className,
      )}
      {...rest}
    />
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 animate-spin rounded-full border-2 border-brand-foreground/40 border-t-brand-foreground"
    />
  );
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "error" | "success";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-[13px] leading-6",
        tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
        tone === "success" && "border-brand/30 bg-brand-soft text-foreground",
        tone === "neutral" && "border-border bg-surface text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
