/**
 * Kontrola dosłowna — kod (bez modelu) porównuje NAZWY WŁASNE i LICZBY z twierdzenia z cytatem.
 *
 * To trzecia, niezależna od modeli kontrola odczytu cytatu. Nigdy nie ustala werdyktu ani relacji —
 * tylko potwierdza (albo nie) to, co ocenił czytelnik, i wpływa wyłącznie na siłę dowodów:
 *  - WSPIERA jest „zgodne dosłownie”, gdy wszystkie liczby i nazwy z twierdzenia występują w cytacie,
 *    a cytat dotyczy tego samego (≥ połowa pozostałych słów treści twierdzenia jest w cytacie);
 *  - OBALA jest „zgodne dosłownie”, gdy cytat dotyczy tego samego (jak wyżej), a w miejscu nazwy lub
 *    liczby z twierdzenia stoi inna: nazwy z twierdzenia nie ma w cytacie i cytat ma nazwę, której nie
 *    ma w twierdzeniu (np. „Jakub Siuda” ↔ „Karol Nawrocki”), albo analogicznie dla liczb („5” ↔ „4”).
 *
 * Odmiana: słowa porównujemy po wspólnym początku (≥ 3 znaki i najwyżej 2 znaki różnicy względem
 * krótszego słowa), po sprowadzeniu do małych liter bez diakrytyków: „Siuda” = „Siudy”, „polski” = „Polskiej”.
 * Nazwa = słowo z wielkiej litery; pierwsze słowo zdania tylko wtedy, gdy następne też jest z wielkiej
 * (np. „Jakub Siuda …”). Ciąg sąsiednich nazw tworzy frazę („Dr Karol Nawrocki”).
 */
import type { Relation } from "../../shared/contracts";

export interface LiteralResult {
  consistent: boolean;
  /** Nazwy/liczby z twierdzenia, których nie ma w cytacie (tylko przy OBALA). */
  claimOnly: string[];
  /** Nazwy/liczby z cytatu, których nie ma w twierdzeniu (tylko przy OBALA). */
  quoteOnly: string[];
  kind: "names" | "numbers" | "match" | null;
}

const NONE: LiteralResult = { consistent: false, claimOnly: [], quoteOnly: [], kind: null };

const STOP = new Set([
  "to", "jest", "sa", "byl", "byla", "bylo", "byli", "beda", "bedzie", "oraz", "ale", "czy", "jak", "jako",
  "ten", "ta", "te", "tym", "tego", "tej", "ktory", "ktora", "ktore", "ktorzy", "sie", "nie", "tak", "juz",
  "dla", "przez", "pod", "nad", "przy", "lub", "albo", "the", "and", "for", "with", "that", "this", "was",
  "are", "has", "have", "from", "into", "jego", "jej", "ich", "takze", "tez", "wiec", "gdy", "kiedy",
]);

interface Tok {
  raw: string;
  norm: string;
  name: boolean;
  num: boolean;
  /** Indeks frazy nazw (ciąg sąsiednich nazw) albo -1. */
  phrase: number;
  /** Pozycja tokenu w tekście (do szukania frazy najbliższej tematowi). */
  pos: number;
}

function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

const WORD_RE = /\d+(?:[.,]\d+)*|[\p{L}][\p{L}'’-]*/gu;
const CAP_RE = /^\p{Lu}/u;

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  // Granice zdań: po . ! ? … i na początku tekstu.
  const sentenceStarts = new Set<number>([0]);
  for (const m of text.matchAll(/[.!?…]\s+/g)) sentenceStarts.add((m.index ?? 0) + m[0].length);
  const matches = [...text.matchAll(WORD_RE)];
  let phrase = -1;
  let phraseId = 0;
  let prevName = false;
  let prevEnd = 0;
  matches.forEach((m, i) => {
    const raw = m[0];
    const at = m.index ?? 0;
    // Fraza nazw nie przechodzi przez interpunkcję („Nawrocki – Prezydent” to dwie frazy).
    const gapHasPunct = /\S/.test(text.slice(prevEnd, at));
    prevEnd = at + raw.length;
    const num = /^\d/.test(raw);
    let name = !num && CAP_RE.test(raw) && raw.length >= 2;
    if (name && isSentenceStart(text, at, sentenceStarts)) {
      const next = matches[i + 1]?.[0] ?? "";
      name = CAP_RE.test(next) && !/^\d/.test(next);
    }
    if (name) {
      if (!prevName || gapHasPunct) phrase = phraseId++;
    }
    out.push({ raw, norm: fold(raw.replace(/[’']/g, "")), name, num, phrase: name ? phrase : -1, pos: i });
    prevName = name;
  });
  return out;
}

function isSentenceStart(text: string, at: number, starts: Set<number>): boolean {
  if (starts.has(at)) return true;
  // Pomijamy znaki otwierające („ " ( –) między granicą zdania a słowem.
  let j = at - 1;
  while (j >= 0 && /[\s„"“«(\-–—]/.test(text[j]!)) j--;
  return j < 0 || /[.!?…]/.test(text[j]!);
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return false;
  const min = Math.min(a.length, b.length);
  if (min < 3) return false;
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  return p >= 3 && p >= min - 2;
}

function normNum(s: string): string {
  return s.replace(/,/g, ".").replace(/\.0+$/, "");
}

function isContent(t: Tok): boolean {
  return !t.num && t.norm.length >= 3 && !STOP.has(t.norm);
}

/**
 * Frazy nazw, których WSZYSTKIE słowa spełniają `pick`. Gdy podano `anchors` (pozycje słów wspólnych
 * z twierdzeniem), frazy są posortowane od najbliższej — „Dr Karol Nawrocki – Prezydent …” przed
 * „Zgromadzeniem Narodowym” w dalszej części cytatu.
 */
function phrases(toks: Tok[], pick: (t: Tok) => boolean, anchors: number[] = []): string[] {
  const by = new Map<number, Tok[]>();
  for (const t of toks) if (t.phrase >= 0) by.set(t.phrase, [...(by.get(t.phrase) ?? []), t]);
  const out: { text: string; dist: number }[] = [];
  for (const group of by.values()) {
    if (!group.every(pick) || group.every((t) => t.norm.length < 3)) continue;
    const dist = anchors.length === 0 ? 0 : Math.min(...group.flatMap((t) => anchors.map((a) => Math.abs(a - t.pos))));
    out.push({ text: group.map((t) => t.raw).join(" "), dist });
  }
  return out.sort((a, b) => a.dist - b.dist).map((x) => x.text);
}

export function literalCheck(claimText: string, quote: string, relation: Relation): LiteralResult {
  if (relation !== "WSPIERA" && relation !== "OBALA") return NONE;
  const c = tokenize(claimText);
  const q = tokenize(quote);
  if (c.length === 0 || q.length === 0) return NONE;

  const inQuote = (t: Tok) => q.some((x) => sameWord(t.norm, x.norm));
  const inClaim = (t: Tok) => c.some((x) => sameWord(t.norm, x.norm));

  const claimNums = c.filter((t) => t.num).map((t) => normNum(t.norm));
  const quoteNums = q.filter((t) => t.num).map((t) => normNum(t.norm));
  const claimNames = c.filter((t) => t.name && t.norm.length >= 3);
  const quoteNames = q.filter((t) => t.name && t.norm.length >= 3);

  // Temat: słowa treści twierdzenia (nazwy i pozostałe, bez liczb) — co najmniej połowa musi być w cytacie.
  const topicBase = c.filter(isContent);
  if (topicBase.length === 0) return NONE;
  const topic = topicBase.filter(inQuote).length / topicBase.length;
  if (topic < 0.5) return NONE;

  if (relation === "WSPIERA") {
    const numsOk = claimNums.every((n) => quoteNums.includes(n));
    const namesOk = claimNames.every(inQuote);
    return numsOk && namesOk ? { consistent: true, claimOnly: [], quoteOnly: [], kind: "match" } : NONE;
  }

  // OBALA: w miejscu nazwy albo liczby stoi inna.
  const anchors = q.filter((t) => isContent(t) && inClaim(t)).map((t) => t.pos);
  const missingNames = phrases(c, (t) => !inQuote(t));
  const extraNames = phrases(q, (t) => !inClaim(t), anchors);
  if (missingNames.length > 0 && extraNames.length > 0 && claimNames.length > 0 && quoteNames.length > 0) {
    return { consistent: true, claimOnly: missingNames.slice(0, 2), quoteOnly: extraNames.slice(0, 1), kind: "names" };
  }
  const missingNums = [...new Set(claimNums.filter((n) => !quoteNums.includes(n)))];
  const extraNums = [...new Set(quoteNums.filter((n) => !claimNums.includes(n)))];
  if (missingNums.length > 0 && extraNums.length > 0) {
    return { consistent: true, claimOnly: missingNums.slice(0, 2), quoteOnly: extraNums.length === 1 ? extraNums : [], kind: "numbers" };
  }
  return NONE;
}

/**
 * Liczba fraz nazw własnych w tekście (te same zasady co wyżej: pierwsze słowo zdania liczy się tylko,
 * gdy następne też jest z wielkiej litery). Używa tego reguła 8 (slots.ts) do oceny, czy twierdzenie ma
 * poza datą lub liczbą jeszcze inne szczegóły.
 */
export function namePhraseCount(text: string): number {
  return new Set(tokenize(text).filter((t) => t.phrase >= 0).map((t) => t.phrase)).size;
}

/** Czynnik dla karty siły (prosty polski). */
export function literalFactorPl(r: LiteralResult): string | null {
  if (!r.consistent) return null;
  if (r.kind === "match") return "Kod (bez modeli) sprawdził, że nazwy i liczby z twierdzenia występują w cytacie ze źródła.";
  const quoteSide = (xs: string[]) => xs.map((x) => `„${x}”`).join(", ");
  if (r.kind === "names") {
    return `Kod (bez modeli) porównał nazwy: źródło podaje ${quoteSide(r.quoteOnly)}, a twierdzenie ${quoteSide(r.claimOnly)}.`;
  }
  return r.quoteOnly.length > 0
    ? `Kod (bez modeli) porównał liczby: źródło podaje ${quoteSide(r.quoteOnly)}, a twierdzenie ${quoteSide(r.claimOnly)}.`
    : `Kod (bez modeli) porównał liczby: liczby ${quoteSide(r.claimOnly)} z twierdzenia nie ma w źródle, które podaje inną.`;
}
