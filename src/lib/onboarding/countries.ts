export type Country = { iso: string; en: string; fa: string; dial: string; alt?: string[] };

const flag = (iso: string) => String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
export const flagOf = (iso: string) => flag(iso);

/** USA, Canada and Iran first, then alphabetical by English name. */
export const COUNTRY_LIST: Country[] = [
  { iso: "US", en: "United States", fa: "آمریکا", dial: "1", alt: ["USA", "America"] },
  { iso: "CA", en: "Canada", fa: "کانادا", dial: "1" },
  { iso: "IR", en: "Iran", fa: "ایران", dial: "98" },
  ...([
    ["AF", "Afghanistan", "افغانستان", "93"], ["AL", "Albania", "آلبانی", "355"], ["DZ", "Algeria", "الجزایر", "213"],
    ["AR", "Argentina", "آرژانتین", "54"], ["AM", "Armenia", "ارمنستان", "374"], ["AU", "Australia", "استرالیا", "61"],
    ["AT", "Austria", "اتریش", "43"], ["AZ", "Azerbaijan", "آذربایجان", "994"], ["BH", "Bahrain", "بحرین", "973"],
    ["BE", "Belgium", "بلژیک", "32"], ["BR", "Brazil", "برزیل", "55"], ["BG", "Bulgaria", "بلغارستان", "359"],
    ["CN", "China", "چین", "86"], ["HR", "Croatia", "کرواسی", "385"], ["CY", "Cyprus", "قبرس", "357"],
    ["CZ", "Czechia", "چک", "420", ["Czech Republic"]], ["DK", "Denmark", "دانمارک", "45"], ["EG", "Egypt", "مصر", "20"],
    ["FI", "Finland", "فنلاند", "358"], ["FR", "France", "فرانسه", "33"], ["GE", "Georgia", "گرجستان", "995"],
    ["DE", "Germany", "آلمان", "49", ["Deutschland"]], ["GR", "Greece", "یونان", "30"], ["HU", "Hungary", "مجارستان", "36"],
    ["IN", "India", "هند", "91"], ["ID", "Indonesia", "اندونزی", "62"], ["IQ", "Iraq", "عراق", "964"],
    ["IE", "Ireland", "ایرلند", "353"], ["IT", "Italy", "ایتالیا", "39"], ["JP", "Japan", "ژاپن", "81"],
    ["JO", "Jordan", "اردن", "962"], ["KZ", "Kazakhstan", "قزاقستان", "7"], ["KW", "Kuwait", "کویت", "965"],
    ["LB", "Lebanon", "لبنان", "961"], ["LU", "Luxembourg", "لوکزامبورگ", "352"], ["MY", "Malaysia", "مالزی", "60"],
    ["MX", "Mexico", "مکزیک", "52"], ["NL", "Netherlands", "هلند", "31", ["Holland"]], ["NZ", "New Zealand", "نیوزیلند", "64", ["NZL"]],
    ["NO", "Norway", "نروژ", "47"], ["OM", "Oman", "عمان", "968"], ["PK", "Pakistan", "پاکستان", "92"],
    ["PL", "Poland", "لهستان", "48"], ["PT", "Portugal", "پرتغال", "351"], ["QA", "Qatar", "قطر", "974"],
    ["RO", "Romania", "رومانی", "40"], ["RU", "Russia", "روسیه", "7"], ["SA", "Saudi Arabia", "عربستان", "966", ["KSA"]],
    ["SG", "Singapore", "سنگاپور", "65"], ["ZA", "South Africa", "آفریقای جنوبی", "27"], ["KR", "South Korea", "کرهٔ جنوبی", "82", ["Korea"]],
    ["ES", "Spain", "اسپانیا", "34"], ["LK", "Sri Lanka", "سریلانکا", "94"], ["SE", "Sweden", "سوئد", "46"],
    ["CH", "Switzerland", "سوئیس", "41"], ["TJ", "Tajikistan", "تاجیکستان", "992"], ["TH", "Thailand", "تایلند", "66"],
    ["TR", "Turkey", "ترکیه", "90", ["Türkiye", "Turkiye"]], ["TM", "Turkmenistan", "ترکمنستان", "993"], ["UA", "Ukraine", "اوکراین", "380"],
    ["AE", "United Arab Emirates", "امارات", "971", ["UAE", "Emirates", "Dubai"]],
    ["GB", "United Kingdom", "انگلستان", "44", ["UK", "England", "Britain", "Great Britain"]],
    ["UZ", "Uzbekistan", "ازبکستان", "998"],
  ] as [string, string, string, string, string[]?][]).map(([iso, en, fa, dial, alt]) => ({ iso, en, fa, dial, ...(alt ? { alt } : {}) })),
];

export const byIso = (iso?: string) => COUNTRY_LIST.find((c) => c.iso === iso);

const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/** Search by Persian/English name, English abbreviation or dial code. */
export function searchCountries(q: string): Country[] {
  const s = q.trim().toLowerCase();
  if (!s) return COUNTRY_LIST;
  const dig = /^\+?[\d۰-۹٠-٩]+$/.test(s) ? toEnDigits(s).replace("+", "") : "";
  const rank = (c: Country) => {
    const abbr = [c.iso, ...(c.alt ?? [])].map((x) => x.toLowerCase());
    const en = c.en.toLowerCase();
    if (abbr.includes(s) || c.fa === s || c.dial === dig) return 0;
    if (c.fa.startsWith(s) || (dig && c.dial.startsWith(dig))) return 1;
    if (en.startsWith(s)) return 1;
    if (abbr.some((a) => a.startsWith(s)) || en.split(/\s+/).some((w) => w.startsWith(s))) return 2;
    if (en.includes(s) || c.fa.includes(s)) return 3;
    return -1;
  };
  return COUNTRY_LIST.map((c, i) => ({ c, r: rank(c), i })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

/** Search dial codes: digits match code prefixes first (shorter codes first); otherwise English name search. */
export function searchDial(q: string): Country[] {
  const d = toEnDigits(q).replace(/[\s+]/g, "");
  if (!d) return COUNTRY_LIST;
  if (/^\d+$/.test(d)) {
    return COUNTRY_LIST.map((c, i) => ({ c, i })).filter(({ c }) => c.dial.startsWith(d))
      .sort((a, b) => a.c.dial.length - b.c.dial.length || a.c.dial.localeCompare(b.c.dial) || a.i - b.i).map((x) => x.c);
  }
  return searchCountries(q);
}

/** Capitalise the first letter of each English word, e.g. "los angeles" → "Los Angeles". */
export const capWords = (s: string) => s.replace(/(^|[\s\-])([a-z])/g, (_m, p: string, ch: string) => p + ch.toUpperCase());
export const digitsEn = toEnDigits;
