/**
 * Small text utilities shared by the engine (claim overlap, quote check, fake provider).
 * Pure functions, no dependencies.
 */

// Built from a string: esbuild emits U+2028/U+2029 literally, which breaks regex literals.
const ZERO_WIDTH = new RegExp("[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]", "g");
// C0/C1 control characters except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Removes invisible characters (zero-width, bidi controls, soft hyphen, control chars). */
export function stripInvisible(text: string): string {
  return text.replace(ZERO_WIDTH, "").replace(CONTROL, "");
}

/** Unicode + whitespace cleanup for text that will be shown to people or models. */
export function cleanText(text: string): string {
  return stripInvisible(text.normalize("NFC"))
    .replace(/[ \t  ]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n\n")
    .trim();
}

/** Lowercase, no diacritics (ł → l too), letters and digits only, single spaces. */
export function foldForMatch(text: string): string {
  return stripInvisible(text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function words(text: string): string[] {
  const f = foldForMatch(text);
  return f ? f.split(" ") : [];
}

const STOPWORDS = new Set(
  (
    "i w we z ze na do od o u a ale lub albo czy to ten ta te tego tej tym jest sa byl byla bylo beda " +
    "jak sie nie tak ze po przez dla przy pod nad za co ktory ktora ktore ich jego jej oraz juz tez " +
    "the a an of in on to is are was were be and or for with by at from that this it as not"
  ).split(" "),
);

/** Content words (no stopwords, length >= 3). */
export function contentWords(text: string): string[] {
  return words(text).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Character trigrams of each content word (padded), robust to Polish inflection. */
function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of contentWords(text)) {
    const p = ` ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

/**
 * Share of the candidate's character trigrams (over content words) that also occur in the source.
 * 1 = every piece of the candidate comes from the source; 0 = nothing in common.
 * Used to reject claims that were not actually present in the user's input (claim substitution).
 */
export function ngramContainment(candidate: string, source: string): number {
  const c = trigramSet(candidate);
  if (c.size === 0) return 0;
  const s = trigramSet(source);
  let hit = 0;
  for (const g of c) if (s.has(g)) hit++;
  return hit / c.size;
}

/** Splits text into sentences (keeps the original characters of each sentence). */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}„"«(\[])|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

/** Truncates on a word boundary, never above `max` characters. Result is a prefix of the input. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

/** Accepts "YYYY", "YYYY-MM", "YYYY-MM-DD" (optionally with time). Returns the date part or undefined. */
export function isoDateOrUndefined(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(v.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return undefined;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 12)) return undefined;
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 31)) return undefined;
  return m[0];
}

export const MONTHS_PL = [
  "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
  "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
];

/** "2026-11-20" → "20 listopada 2026"; "2026-11" → "11.2026"; "2026" → "2026"; null → "data nieznana". */
export function formatDatePl(iso: string | null | undefined): string {
  if (!iso) return "data nieznana";
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(iso);
  if (!m) return "data nieznana";
  if (m[3] && m[2]) return `${Number(m[3])} ${MONTHS_PL[Number(m[2]) - 1] ?? ""} ${m[1]}`.replace("  ", " ");
  if (m[2]) return `${m[2]}.${m[1]}`;
  return m[1] ?? "data nieznana";
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}
