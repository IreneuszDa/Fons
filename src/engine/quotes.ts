/**
 * Quote check (PLAN §3.6 i): the model's quote must occur in the stored corpus fragment.
 * Normalises unicode / whitespace / typographic quotes, then exact substring or fuzzy ratio >= 0.90
 * over a sliding window (fastest-levenshtein). The returned `matched` text is cut from the ORIGINAL
 * record text, so what we show users always comes from the database, never from the model.
 */
import { distance } from "fastest-levenshtein";

export const QUOTE_MIN_CHARS = 15;
export const QUOTE_MAX_CHARS = 300;
export const QUOTE_FUZZY_THRESHOLD = 0.9;
/**
 * Short quotes (8–14 chars) are accepted only as EXACT matches with a digit and at least two words —
 * e.g. a row of a list such as „Poland 1999”. Fuzzy matching always needs QUOTE_MIN_CHARS.
 */
export const QUOTE_SHORT_EXACT_MIN_CHARS = 8;

export interface QuoteMatch {
  found: boolean;
  /** 0–1 similarity of the best window (1 = exact after normalisation). */
  score: number;
  exact: boolean;
  /** The matching span of the original text (only when found). */
  matched?: string;
  /** Start/end offsets of `matched` in the original text. */
  start?: number;
  end?: number;
  tooShort?: boolean;
}

const QUOTE_CHARS: Record<string, string> = {
  "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"', "″": '"',
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "‹": "'", "›": "'", "′": "'", "`": "'",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
};
// Built from a string: esbuild emits U+2028/U+2029 literally, which breaks regex literals.
const INVISIBLE = new RegExp("[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]");

/** Normalised text plus, for every normalised char, the offset of the original char it came from. */
export function normalizeWithMap(text: string): { norm: string; map: number[]; ends: number[] } {
  let norm = "";
  const map: number[] = [];
  const ends: number[] = [];
  let lastWasSpace = true; // drops leading whitespace
  let i = 0;
  for (const ch of text) {
    const start = i;
    i += ch.length;
    if (INVISIBLE.test(ch)) continue;
    if (/\s/u.test(ch)) {
      if (!lastWasSpace) {
        norm += " ";
        map.push(start);
        ends.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    let out = QUOTE_CHARS[ch] ?? ch;
    if (out === "…") out = "...";
    out = out.normalize("NFKC").toLowerCase();
    for (const c of out) {
      norm += c;
      map.push(start);
      ends.push(i);
    }
    lastWasSpace = false;
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
    ends.pop();
  }
  return { norm, map, ends };
}

export function normalizeQuoteText(text: string): string {
  return normalizeWithMap(text).norm;
}

function ratio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - distance(a, b) / max;
}

function slice(text: string, n: { map: number[]; ends: number[] }, s: number, e: number) {
  const start = n.map[s] ?? 0;
  const end = n.ends[e - 1] ?? text.length;
  return { matched: text.slice(start, end), start, end };
}

/** indexOf that only accepts matches starting and ending on word boundaries (no „1999” inside „19990”). */
function indexOfWord(t: string, q: string): number {
  let from = 0;
  for (;;) {
    const i = t.indexOf(q, from);
    if (i < 0) return -1;
    const before = i === 0 ? "" : t[i - 1]!;
    const after = t[i + q.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return i;
    from = i + 1;
  }
}

function findSingle(quote: string, text: string, threshold: number): QuoteMatch {
  const q = normalizeQuoteText(quote);
  const n = normalizeWithMap(text);
  const t = n.norm;
  if (q.length < QUOTE_MIN_CHARS) {
    const shortOk = q.length >= QUOTE_SHORT_EXACT_MIN_CHARS && /\d/.test(q) && q.includes(" ");
    const idx = shortOk ? indexOfWord(t, q) : -1;
    if (idx >= 0) return { found: true, score: 1, exact: true, ...slice(text, n, idx, idx + q.length) };
    return { found: false, score: 0, exact: false, tooShort: true };
  }
  if (t.length === 0) return { found: false, score: 0, exact: false };

  const idx = t.indexOf(q);
  if (idx >= 0) return { found: true, score: 1, exact: true, ...slice(text, n, idx, idx + q.length) };

  const L = q.length;
  if (t.length <= L) {
    const r = ratio(q, t);
    return r >= threshold ? { found: true, score: r, exact: false, ...slice(text, n, 0, t.length) } : { found: false, score: r, exact: false };
  }

  // Coarse pass over positions, then refine position and window length around the best one.
  const step = Math.max(1, Math.floor(L / 10));
  let bestPos = 0;
  let bestLen = L;
  let best = -1;
  for (let p = 0; p + L <= t.length; p += step) {
    const r = ratio(q, t.slice(p, p + L));
    if (r > best) {
      best = r;
      bestPos = p;
    }
  }
  const lenDelta = Math.max(1, Math.floor(L * 0.1));
  const lenStep = Math.max(1, Math.floor(L * 0.02));
  const from = Math.max(0, bestPos - step);
  const to = Math.min(t.length - 1, bestPos + step);
  for (let p = from; p <= to; p++) {
    for (let len = Math.max(1, L - lenDelta); len <= L + lenDelta; len += lenStep) {
      if (p + len > t.length) break;
      const r = ratio(q, t.slice(p, p + len));
      if (r > best) {
        best = r;
        bestPos = p;
        bestLen = len;
      }
    }
  }
  if (best >= threshold) {
    return { found: true, score: best, exact: false, ...slice(text, n, bestPos, bestPos + bestLen) };
  }
  return { found: false, score: Math.max(0, best), exact: false };
}

/**
 * Looks for `quote` in `text`. A quote with an ellipsis ("…" / "...") is split into parts and every
 * part (>= 15 chars) must be found; `matched` then joins the original spans with " … ".
 */
export function findQuote(quote: string, text: string, threshold = QUOTE_FUZZY_THRESHOLD): QuoteMatch {
  const trimmed = quote.trim().slice(0, QUOTE_MAX_CHARS + 20);
  const parts = trimmed
    .split(/\s*(?:…|\.\.\.|\[\s*\.\.\.\s*\]|\(\s*\.\.\.\s*\))\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length <= 1) return findSingle(trimmed, text, threshold);
  const long = parts.filter((p) => normalizeQuoteText(p).length >= QUOTE_MIN_CHARS);
  if (long.length === 0) return { found: false, score: 0, exact: false, tooShort: true };
  const results = long.map((p) => findSingle(p, text, threshold));
  if (!results.every((r) => r.found)) {
    return { found: false, score: Math.min(...results.map((r) => r.score)), exact: false };
  }
  return {
    found: true,
    score: Math.min(...results.map((r) => r.score)),
    exact: results.every((r) => r.exact),
    matched: results.map((r) => r.matched).join(" … "),
    start: Math.min(...results.map((r) => r.start ?? 0)),
    end: Math.max(...results.map((r) => r.end ?? 0)),
  };
}
