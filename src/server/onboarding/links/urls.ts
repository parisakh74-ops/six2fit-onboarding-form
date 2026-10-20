/**
 * Frontend URL contract of the onboarding form (verified against `src/routes/index.tsx` and `src/lib/onboarding/integration.ts`):
 *
 *   - the form lives at the site root `/` (TanStack file route `index.tsx`);
 *   - the signed link token is read from the query parameter `session` (`loadBootstrap` -> POST `/?six2fit_api=bootstrap&session=<token>`);
 *   - scope and entitlements are NEVER read from the URL (the optional `scope` search param is untrusted and ignored);
 *   - the UI is Persian only (`<html lang="fa" dir="rtl">`); no component reads a language parameter.
 *
 * So the Persian URL is exactly `<origin>/?session=<token>`. The English URL carries the same token plus `lang=en`;
 * the frontend currently IGNORES `lang`, so it shows the Persian form (reported to the caller as `language_support.en = false`).
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,1800}\.[A-Za-z0-9_-]{20,200}$/;

export type FormUrls = { fa: string; en: string };

export function normalizeBaseUrl(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error("BASE_URL_INVALID");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("BASE_URL_INVALID");
  return u.origin;
}

export function buildFormUrls(base: string, token: string): FormUrls {
  if (!TOKEN_SHAPE.test(token)) throw new Error("TOKEN_SHAPE");
  const origin = normalizeBaseUrl(base);
  const fa = new URL("/", origin);
  fa.searchParams.set("session", token);
  const en = new URL("/", origin);
  en.searchParams.set("session", token);
  en.searchParams.set("lang", "en");
  return { fa: fa.toString(), en: en.toString() };
}

/** Reads the token exactly like the frontend does (`new URLSearchParams(location.search).get("session")`). */
export function sessionFromUrl(url: string): string | null {
  return new URLSearchParams(new URL(url).search).get("session");
}

/** True when a URL fits the contract: root path, only `session` (+ optional `lang`), no fragment, no other parameters. */
export function matchesFrontendContract(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin !== normalizeBaseUrl(base) || u.pathname !== "/" || u.hash !== "") return false;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length || !keys.includes("session")) return false;
    if (keys.some((k) => k !== "session" && k !== "lang")) return false;
    const lang = u.searchParams.get("lang");
    return TOKEN_SHAPE.test(u.searchParams.get("session") ?? "") && (lang === null || lang === "en");
  } catch {
    return false;
  }
}
