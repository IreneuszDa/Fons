/** Polish formatting helpers for dates and small labels (no Astryx/React here, unit-tested). */

const dateFmt = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Warsaw" });
const dateTimeFmt = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Warsaw",
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "21 listopada 2026" or a plain-language fallback when the date is unknown. */
export function formatDate(iso: string | null | undefined, fallback = "data nieznana"): string {
  const d = parse(iso);
  return d ? dateFmt.format(d) : fallback;
}

/** "21 listopada 2026, 14:05". */
export function formatDateTime(iso: string | null | undefined, fallback = "data nieznana"): string {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : fallback;
}

/** Polish plural: plural(1, "źródło", "źródła", "źródeł"). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** "3 źródła". */
export function countLabel(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}

/** Hostname of a URL for display ("www.gov.pl"), or empty string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Splits plain text into non-empty paragraphs (server texts use "\n" as separators). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Milliseconds → "12,3 s" / "850 ms". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} s`;
}

/** USD with 4 decimals for tiny per-run costs. */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`;
}
