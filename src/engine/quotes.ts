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
    norm += out;
    // indexOf and slice return UTF-16 offsets, including both units of a preceding emoji.
    for (let unit = 0; unit < out.length; unit++) {
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

// Keep words and decimal values whole. Trimming the end of „10,5” would change the evidence.
function splitsToken(text: string, at: number): boolean {
  const left = text[at - 1] ?? "";
  const right = text[at] ?? "";
  return (/[\p{L}\p{N}]/u.test(left) && /[\p{L}\p{N}]/u.test(right))
    || (/\d/u.test(left) && /[.,]\d/u.test(text.slice(at, at + 2)))
    || (/\d[.,]/u.test(text.slice(Math.max(0, at - 2), at)) && /\d/u.test(right));
}

/** indexOf that only accepts whole words and numbers. */
function indexOfWord(t: string, q: string): number {
  let from = 0;
  for (;;) {
    const i = t.indexOf(q, from);
    if (i < 0) return -1;
    if (!splitsToken(t, i) && !splitsToken(t, i + q.length)) return i;
    from = i + 1;
  }
}

function findSingle(quote: string, text: string, threshold: number, anchoredPart = false): QuoteMatch {
  const q = normalizeQuoteText(quote);
  const n = normalizeWithMap(text);
  const t = n.norm;
  if (q.length < QUOTE_MIN_CHARS) {
    const shortOk = (anchoredPart && q.length > 0) || (q.length >= QUOTE_SHORT_EXACT_MIN_CHARS && /\d/.test(q) && q.includes(" "));
    const idx = shortOk ? indexOfWord(t, q) : -1;
    if (idx >= 0) return { found: true, score: 1, exact: true, ...slice(text, n, idx, idx + q.length) };
    return { found: false, score: 0, exact: false, tooShort: true };
  }
  if (t.length === 0) return { found: false, score: 0, exact: false };

  const idx = indexOfWord(t, q);
  if (idx >= 0) return { found: true, score: 1, exact: true, ...slice(text, n, idx, idx + q.length) };
  if (threshold >= 1 || t.includes(q)) return { found: false, score: 0, exact: false };

  // A typographical match may restore accents. It must never substitute a number or a negation.
  const anchors = (s: string) => JSON.stringify(s.match(/\d+(?:[.,]\d+)*|(?<!\p{L})(?:nie|nigdy|bez|no|not|never|without)(?!\p{L})/gu) ?? []);
  const critical = anchors(q);

  const L = q.length;
  if (t.length <= L) {
    const r = ratio(q, t);
    return r >= threshold && anchors(t) === critical ? { found: true, score: r, exact: false, ...slice(text, n, 0, t.length) } : { found: false, score: r, exact: false };
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
    let end = bestPos + bestLen;
    while (splitsToken(t, bestPos)) bestPos--;
    while (splitsToken(t, end)) end++;
    const candidate = t.slice(bestPos, end);
    const score = ratio(q, candidate);
    if (score >= threshold && anchors(candidate) === critical) {
      return { found: true, score, exact: false, ...slice(text, n, bestPos, end) };
    }
  }
  return { found: false, score: Math.max(0, best), exact: false };
}

/**
 * Accept omissions only in source order. Return the full original span, so an elided negation or
 * qualification is visible to both the verifier and the reader. Reject spans too long to display.
 */
export function findQuote(quote: string, text: string, threshold = QUOTE_FUZZY_THRESHOLD): QuoteMatch {
  const trimmed = quote.trim().slice(0, QUOTE_MAX_CHARS + 20);
  const parts = trimmed
    .split(/\s*(?:…|\.\.\.|\[\s*\.\.\.\s*\]|\(\s*\.\.\.\s*\))\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length <= 1) return findSingle(trimmed, text, threshold);
  if (!parts.some(p => normalizeQuoteText(p).length >= QUOTE_MIN_CHARS)) return { found: false, score: 0, exact: false, tooShort: true };
  let start = 0;
  let end = 0;
  let score = 1;
  let exact = true;
  for (const [i, part] of parts.entries()) {
    const remaining = text.slice(end);
    const match = findSingle(part, remaining, threshold, true);
    if (!match.found || match.start === undefined || match.end === undefined) return { found: false, score: match.score, exact: false };
    if (i === 0) start = match.start;
    end += match.end;
    score = Math.min(score, match.score);
    exact = exact && match.exact;
  }
  if (end - start > QUOTE_MAX_CHARS) return { found: false, score: 0, exact: false };
  return { found: true, score, exact, matched: text.slice(start, end), start, end };
}
