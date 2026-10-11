import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/6tofit-logo.webp.asset.json";

export function Logo() {
  return (
    <img
      src={logoAsset.url}
      alt="6toFit"
      className="h-6 w-auto select-none sm:h-7"
      draggable={false}
    />
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-5 flex items-center justify-between">
          <Logo />
          <span className="text-[12px] text-muted-foreground">مشاوره تخصصی</span>
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
        "rounded-2xl border border-border bg-card p-5 sm:p-8",
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
    <div className="mb-6 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-[13px] font-semibold text-foreground">{title}</p>
        <p dir="ltr" className="shrink-0 font-display text-[12px] text-muted-foreground">
          {current} / {total}
        </p>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="پیشرفت فرم"
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-brand transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60";

export function PrimaryButton({
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(btnBase, "bg-brand text-brand-foreground hover:bg-brand-strong", className)}
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
        "border border-border bg-card text-foreground hover:bg-surface",
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
