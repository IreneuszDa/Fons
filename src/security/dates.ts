/**
 * Relative-date anchoring (PLAN §3 step 1 and cache key): "wczoraj" → "20 listopada 2026".
 * Conservative on purpose: only unambiguous day words are replaced, plus "w tym tygodniu".
 * Calendar day is computed in Europe/Warsaw, since that is where users are.
 */

export const MONTHS_GENITIVE_PL = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
] as const;

const TZ = "Europe/Warsaw";

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function warsawYmd(date: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function addDays(base: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "20 listopada 2026" */
export function formatPolishDate(v: Ymd): string {
  return `${v.d} ${MONTHS_GENITIVE_PL[v.m - 1]} ${v.y}`;
}

/** Expressions without a fixed date still change meaning as the calendar advances. */
export function relativeWindowDay(text: string, receivedAt: Date): string | undefined {
  if (!/\b(?:ostatnio|niedawno|przyszłego tygodnia|przyszlym tygodniu|przyszłym tygodniu|przyszlego tygodnia)\b/iu.test(text)) return;
  return formatPolishDate(warsawYmd(receivedAt));
}

function weekRange(today: Ymd): string {
  const dow = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay(); // 0 = Sunday
  const mon = addDays(today, -((dow + 6) % 7));
  const sun = addDays(mon, 6);
  if (mon.y !== sun.y) return `od ${formatPolishDate(mon)} do ${formatPolishDate(sun)}`;
  if (mon.m !== sun.m) return `od ${mon.d} ${MONTHS_GENITIVE_PL[mon.m - 1]} do ${formatPolishDate(sun)}`;
  return `od ${mon.d} do ${formatPolishDate(sun)}`;
}

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";

// Words before "jutro" that make it the noun "the future" ("lepsze jutro").
const JUTRO_NOUN_BEFORE = /(?:lepsze|lepszego|lepszym|świetlane|swietlane|nasze|naszego|naszym|wasze|swoje|swojego|pewne|pewnego|niepewne|polskie)\s+$/iu;

/**
 * Replaces relative dates with absolute Polish dates anchored at `receivedAt`.
 * Example (receivedAt = 21.11.2026): "Wczoraj premier powiedział" → "20 listopada 2026 premier powiedział".
 */
export function resolveRelativeDates(text: string, receivedAt: Date): string {
  if (!text) return text;
  const today = warsawYmd(receivedAt);
  const day = (offset: number) => formatPolishDate(addDays(today, offset));

  const rules: { re: RegExp; to: (m: string, offset: number, whole: string) => string }[] = [
    { re: new RegExp(`${L}w dniu dzisiejszym${R}`, "giu"), to: () => `w dniu ${day(0)}` },
    { re: new RegExp(`${L}w dniu wczorajszym${R}`, "giu"), to: () => `w dniu ${day(-1)}` },
    { re: new RegExp(`${L}w tym tygodniu${R}`, "giu"), to: () => `w tygodniu ${weekRange(today)}` },
    { re: new RegExp(`${L}przedwczoraj${R}`, "giu"), to: () => day(-2) },
    { re: new RegExp(`${L}pojutrze${R}`, "giu"), to: () => day(2) },
    { re: new RegExp(`${L}wczoraj${R}`, "giu"), to: () => day(-1) },
    { re: new RegExp(`${L}(?:dzisiaj|dziś)${R}`, "giu"), to: () => day(0) },
    {
      re: new RegExp(`${L}jutro${R}`, "giu"),
      to: (m, offset, whole) => (JUTRO_NOUN_BEFORE.test(whole.slice(Math.max(0, offset - 30), offset)) ? m : day(1)),
    },
    { re: new RegExp(`${L}the day before yesterday${R}`, "giu"), to: () => day(-2) },
    { re: new RegExp(`${L}yesterday${R}`, "giu"), to: () => day(-1) },
    { re: new RegExp(`${L}today${R}`, "giu"), to: () => day(0) },
    { re: new RegExp(`${L}tomorrow${R}`, "giu"), to: () => day(1) },
  ];

  let out = text;
  for (const r of rules) {
    out = out.replace(r.re, (m: string, offset: number, whole: string) => r.to(m, offset, whole));
  }
  return out;
}
