/**
 * Dzielenie tekstu strony na fragmenty (~1200 znaków) i leksykalne punktowanie względem twierdzenia
 * (lekkie BM25 po fragmentach jednego przebiegu, z prostym rdzeniowaniem polskiej fleksji).
 * Bez sieci, bez modeli — czysta funkcja, łatwa do testowania.
 */
import { splitSentences } from "../../security/text";
import { STOPWORDS } from "./fts";

export const PASSAGE_TARGET_CHARS = 1200;
/** Twarda górna granica długości fragmentu (rekord korpusu ma ≤ ~1500 znaków). */
export const PASSAGE_MAX_CHARS = 1500;
export const PASSAGE_MIN_CHARS = 40;

/** Składa polskie znaki diakrytyczne (w tym „ł”) i zamienia na małe litery. */
export function foldToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    .toLowerCase();
}

/**
 * Rdzeń do porównań leksykalnych: liczby i krótkie słowa (≤ 4 znaki) dokładnie, dłuższe — pierwsze 5 znaków
 * po złożeniu diakrytyków („sankcji”, „sankcje”, „sankcjami” → „sankc”; „Szwecja”, „Szwecji” → „szwec”).
 */
export function stemToken(token: string): string {
  const t = foldToken(token);
  if (/\p{N}/u.test(t)) return t;
  const chars = Array.from(t);
  return chars.length <= 4 ? t : chars.slice(0, 5).join("");
}

const FOLDED_STOPWORDS: ReadonlySet<string> = new Set([...STOPWORDS].map(foldToken));

/** Rdzenie znaczących słów (bez stopwords, min. 2 znaki, unikalne). */
export function queryStems(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of text.normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 2) continue;
      const folded = foldToken(raw);
      if (FOLDED_STOPWORDS.has(folded)) continue;
      const stem = stemToken(raw);
      if (seen.has(stem)) continue;
      seen.add(stem);
      out.push(stem);
    }
  }
  return out;
}

function stemCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of text.normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const s = stemToken(raw);
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

/** Tnie zbyt długi akapit na zdania, a zdanie dłuższe niż limit — na granicy słowa. */
function splitLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  const parts: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = "";
  };
  for (const s of splitSentences(paragraph)) {
    let sentence = s.text.trim();
    while (sentence.length > max) {
      let cut = sentence.lastIndexOf(" ", max);
      if (cut < max * 0.5) cut = max;
      if (cur) flush();
      parts.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (cur.length + sentence.length + 1 > max) flush();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  flush();
  return parts;
}

/**
 * Dzieli czytelny tekst strony na fragmenty ~`target` znaków: akapity są łączone do osiągnięcia celu,
 * zbyt długie — dzielone po zdaniach. Fragmenty krótsze niż `PASSAGE_MIN_CHARS` odpadają.
 */
export function chunkText(
  text: string,
  opts: { target?: number; max?: number; maxPassages?: number } = {},
): string[] {
  const target = opts.target ?? PASSAGE_TARGET_CHARS;
  const max = Math.min(opts.max ?? PASSAGE_MAX_CHARS, PASSAGE_MAX_CHARS);
  const maxPassages = opts.maxPassages ?? 60;
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.length >= PASSAGE_MIN_CHARS) out.push(cur);
    cur = "";
  };
  for (const p of paragraphs) {
    for (const piece of splitLong(p, max)) {
      if (cur && cur.length + piece.length + 1 > max) flush();
      cur = cur ? `${cur}\n${piece}` : piece;
      if (cur.length >= target) flush();
    }
    if (out.length >= maxPassages) break;
  }
  if (out.length < maxPassages) flush();
  return out.slice(0, maxPassages);
}

export interface PassageInput {
  /** Dowolny klucz (np. indeks) zwracany w wyniku. */
  key: string;
  title: string;
  text: string;
}

export interface ScoredPassage {
  key: string;
  score: number;
  /** Ile różnych rdzeni zapytania występuje we fragmencie. */
  matched: number;
  coverage: number;
}

/**
 * BM25-podobne punktowanie fragmentów względem rdzeni zapytania. IDF liczony po fragmentach bieżącego
 * przebiegu (kilka stron), tytuł strony daje dodatkowy sygnał. Fragmenty bez dopasowania lub z pokryciem
 * zapytania poniżej progu (`minCoverage`, domyślnie 0,3; przy ≥ 2 rdzeniach zawsze ≥ 2 dopasowane) odpadają.
 */
export function scorePassages(
  passages: PassageInput[],
  stems: string[],
  opts: { minCoverage?: number } = {},
): ScoredPassage[] {
  if (passages.length === 0 || stems.length === 0) return [];
  const minCoverage = opts.minCoverage ?? 0.3;
  const docs = passages.map((p) => ({ p, tf: stemCounts(p.text), title: new Set(stemCounts(p.title).keys()), len: p.text.length }));
  const n = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / n || 1;
  const df = new Map<string, number>();
  for (const stem of stems) df.set(stem, docs.filter((d) => d.tf.has(stem) || d.title.has(stem)).length);
  const k1 = 1.2;
  const b = 0.5;
  const need = stems.length >= 2 ? 2 : 1;
  const out: ScoredPassage[] = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const stem of stems) {
      const tf = d.tf.get(stem) ?? 0;
      const inTitle = d.title.has(stem);
      if (tf === 0 && !inTitle) continue;
      matched++;
      const dfi = df.get(stem) ?? 0;
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
      const norm = tf > 0 ? (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avgLen)) : 0;
      score += idf * (norm + (inTitle ? 0.5 : 0));
    }
    const coverage = matched / stems.length;
    if (matched < need || coverage < minCoverage) continue;
    out.push({ key: d.p.key, score: score * (0.5 + coverage), matched, coverage });
  }
  return out.sort((a, b2) => b2.score - a.score);
}

/** Zapytanie ze słów kluczowych (bez stopwords, ≤ 8 słów) — drugie wyszukiwanie, gdy nie ma tłumaczenia. */
export function keywordQuery(text: string, maxWords = 8): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.normalize("NFC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || FOLDED_STOPWORDS.has(foldToken(raw))) continue;
    const key = foldToken(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= maxWords) break;
  }
  return out.join(" ");
}
