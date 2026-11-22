/**
 * Reguła 8b — „twierdzenie sprowadza się do obalonego aspektu” (PLAN §4). Czyste funkcje, bez modelu.
 *
 * Kod nie rozumie składni, więc sprawdza jawne cechy tekstu twierdzenia:
 *  - `isSingleDateClaim` — czy twierdzenie podaje wprost JEDNĄ datę i poza nią tylko podmiot i orzeczenie:
 *    jedno zdanie, bez spójników łączących kolejne stwierdzenia, najwyżej dwie nazwy własne, krótkie,
 *    bez innych liczb. Przykład: „Polska wstąpiła do NATO w 2004 roku.” Gdy twierdzenie ma więcej
 *    szczegółów, obalona data to „szczegół przy niesprawdzonym sednie” → reguła 9. (Dla liczby reguła
 *    zostaje przy dawnym warunku „cyfra w tekście”: twierdzenia liczbowe to zwykle sama liczba, często
 *    kilka liczb tego samego wyliczenia, np. „350 miliardów, o 200 miliardów więcej niż Europa”.)
 *  - `quoteCorrectsSlot` — czy cytat podaje dla tego miejsca INNĄ wartość. Porównujemy same liczby
 *    (lata, wartości), więc działa także dla cytatów po angielsku („Poland 1999”). Służy wyłącznie
 *    do notki w raporcie („kod porównał: źródło podaje 1999, a twierdzenie 2004”) — nie zmienia werdyktu.
 */
import type { Aspect } from "../../shared/contracts";
import { namePhraseCount } from "./literal";
import { stemToken } from "../retrieval/stem";

/** Aspekty, które kod potrafi porównać w cytacie (liczbowo). */
export type NumericAspect = Extract<Aspect, "czas" | "liczba">;

export function isNumericAspect(a: Aspect): a is NumericAspect {
  return a === "czas" || a === "liczba";
}

/** Najwięcej słów w twierdzeniu „jednej daty”. */
export const SINGLE_DATE_MAX_WORDS = 14;
/** Najwięcej fraz nazw własnych (podmiot + np. organizacja) w twierdzeniu „jednej daty”. */
export const SINGLE_DATE_MAX_NAMES = 2;

const MONTHS =
  "stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrzesnia|pazdziernika|listopada|grudnia|" +
  "styczen|luty|marzec|kwiecien|maj|czerwiec|lipiec|sierpien|wrzesien|pazdziernik|listopad|grudzien|" +
  "january|february|march|april|may|june|july|august|september|october|november|december";

const YEAR = "(?:1[0-9]|20)\\d{2}";

/** Wyrażenia daty (po złożeniu do małych liter bez diakrytyków); grupa 1/2/3/4 = rok. */
const DATE_RE = new RegExp(
  [
    `\\b\\d{1,2}\\s+(?:${MONTHS})\\s+(${YEAR})\\b`, // 12 marca 1999, 12 march 1999
    `\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+(${YEAR})\\b`, // march 12, 1999
    `\\b\\d{1,2}[./]\\d{1,2}[./](${YEAR})\\b`, // 12.03.1999
    `\\b(${YEAR})-\\d{2}(?:-\\d{2})?\\b`, // 1999-03-12, 1999-03
    `\\b(${YEAR})\\b(?![.,]\\d)`, // 1999 (sam rok)
    `\\b\\d{1,2}\\s+(?:${MONTHS})\\b`, // 18 maja (data bez roku — nie jest wartością)
    `\\b(?:${MONTHS})\\s+\\d{1,2}\\b(?![.,]?\\s*\\d)`, // may 18
  ].join("|"),
  "g",
);

const MULTIPLIER: [RegExp, number][] = [
  [/^(?:tys\w*|thousand\w*)\b/, 1e3],
  [/^(?:mln|milion\w*|million\w*)\b/, 1e6],
  [/^(?:mld|miliard\w*|billion\w*|bn)\b/, 1e9],
  [/^(?:bln|bilion\w*|trillion\w*)\b/, 1e12],
];

function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}

export interface Slots {
  /** Lata z wyrażeń daty (bez powtórzeń). */
  years: string[];
  /** Pozostałe liczby (wartości), z mnożnikiem tys./mln/mld. */
  values: number[];
}

/** Lata i wartości liczbowe w tekście. Dzień i miesiąc w dacie nie są wartościami. */
export function extractSlots(text: string): Slots {
  let t = fold(text)
    // „1 500 000” → „1500000” (spacja jako separator tysięcy)
    .replace(/(\d)[\s ](?=\d{3}(?!\d))/g, "$1");
  const years = new Set<string>();
  t = t.replace(DATE_RE, (_m, ...groups: unknown[]) => {
    const y = groups.slice(0, 5).find((g): g is string => typeof g === "string");
    if (y) years.add(y);
    return " ";
  });
  const values: number[] = [];
  for (const m of t.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const raw = m[0];
    // „15,5” i „15.5” → 15.5; „1,500,000” / „1.500.000” → 1500000
    const parts = raw.split(/[.,]/);
    const grouped = parts.length > 2 && parts.slice(1).every((p) => p.length === 3);
    let n = grouped ? Number(parts.join("")) : Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const after = t.slice((m.index ?? 0) + raw.length).trimStart();
    for (const [re, mul] of MULTIPLIER) {
      if (re.test(after)) {
        n *= mul;
        break;
      }
    }
    values.push(n);
  }
  return { years: [...years], values };
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Exact, unqualified Polish assertions about a single quantity. All words in the subject
 * and in the unit must match; the user's number is deliberately excluded from retrieval. */
export interface InstitutionalMeasure {
  subject: string;
  unit: string;
  value: number;
  kind: "term" | "count";
  negated?: true;
}

const yearsWritten: Record<string, number> = {
  jedno: 1, dwu: 2, trzy: 3, cztero: 4, piecio: 5, szescio: 6, siedmio: 7, osmio: 8, dziewiecio: 9, dziesiecio: 10,
};

export function institutionalMeasure(text: string): InstitutionalMeasure | undefined {
  const line = fold(text).trim().replace(/^czy /, "").replace(/[.?!]+$/, "");
  const duration = /^kadencja ([a-z ]{3,65}?) trwa (\d{1,2}) (?:rok|lata|lat)$/.exec(line);
  if (duration) return { kind: "term", subject: duration[1]!, value: Number(duration[2]), unit: "kadencja" };
  const count = /^([a-z ]{3,65}?) (nie )?(?:liczy|sklada sie (?:ze|z)) (\d{1,6}) ([a-z]+)$/.exec(line);
  if (count) return { kind: "count", subject: count[1]!, unit: count[4]!, value: Number(count[3]), ...(count[2] && { negated: true }) };
}

function subjectKey(subject: string, polishLaw: boolean): string {
  // In a Polish statute an unqualified chamber can be compared to an explicit "RP".
  const name = polishLaw ? subject.replace(/ (?:rp|rzeczypospolitej polskiej)$/, "") : subject;
  return name.split(/ +/).map(word => stemToken(word, "pl") ?? word).join(" ");
}

export function sourceMeasureValues(claim: InstitutionalMeasure, quote: string, polishLaw: boolean): number[] {
  const subject = subjectKey(claim.subject, polishLaw);
  const values = new Set<number>();
  for (const sentence of fold(quote).matchAll(/([^.!?;\n]+)([.!?;\n]+|$)/g)) {
    const line = sentence[1]!.trim();
    if (sentence[2]?.includes("?") || /^czy\b/.test(line)) continue;
    const other = institutionalMeasure(line);
    if (other?.kind === claim.kind && !other.negated && other.unit === claim.unit && subjectKey(other.subject, polishLaw) === subject) values.add(other.value);
    if (claim.kind !== "term") continue;
    const adjective = /^([a-z ]{3,80}?) (?:sa wybieran[ei]|jest wybieran[ay]) na ([a-z]+)letni[a-z]* kadencj[a-z]*$/.exec(line);
    if (!adjective || !Object.hasOwn(yearsWritten, adjective[2]!)) continue;
    if (/\b(?:dawniej|wczesniej|przedtem|jesli|jezeli|gdy|gdyby|kiedys|dotychczas|historycznie|wowczas|wedlug|w|przed|po)\b/.test(adjective[1]!)) continue;
    if (adjective[1]!.split(/ (?:i|oraz) /).some(s => subjectKey(s, polishLaw) === subject)) values.add(yearsWritten[adjective[2]!]!);
  }
  return [...values];
}

/** Spójniki i zaimki względne łączące kolejne stwierdzenia (po złożeniu, bez diakrytyków). */
const CLAUSE_RE =
  /\b(?:i|oraz|a|ale|lecz|natomiast|jednak|choc|czyli|bo|poniewaz|gdyz|gdy|kiedy|zeby|aby|ktor\w*|and|but|which|who|while)\b/;

function words(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Czy twierdzenie podaje wprost jedną datę i poza nią tylko podmiot i orzeczenie: dokładnie jeden rok
 * (w dowolnym zapisie daty; albo żaden, gdy `resolvedDate` — data względna typu „wczoraj” ustalona przez
 * ekstrakcję), żadnej innej liczby, jedno zdanie bez spójników, ≤ 14 słów, ≤ 2 nazwy własne.
 */
export function isSingleDateClaim(text: string, opts: { resolvedDate?: boolean } = {}): boolean {
  // Przecinek między cyframi to ułamek („15,5”), nie granica zdania.
  const punct = fold(text).replace(/(\d)[.,](\d)/g, "$1$2");
  if (/[,;:]/.test(punct) || CLAUSE_RE.test(punct)) return false;
  if (words(text).length > SINGLE_DATE_MAX_WORDS) return false;
  if (namePhraseCount(text) > SINGLE_DATE_MAX_NAMES) return false;
  const s = extractSlots(text);
  return s.values.length === 0 && (s.years.length === 1 || (s.years.length === 0 && !!opts.resolvedDate));
}

export interface SlotCorrection {
  claim: string[];
  quote: string[];
}

function fmt(n: number): string {
  return String(Number(n.toPrecision(12))).replace(".", ",");
}

/**
 * Czy cytat podaje INNĄ wartość dla miejsca, które twierdzenie wypełnia:
 *  czas   — cytat ma rok, a żadnego roku z twierdzenia w nim nie ma („Poland 1999” vs „2004”);
 *  liczba — cytat ma wartość, żadnej wartości twierdzenia w nim nie ma (po przeliczeniu tys./mln/mld),
 *           a jeśli obie strony podają rok okresu, to ten sam (inny okres to nie korekta, tylko inne dane).
 * Zwraca wartości obu stron (do notki w raporcie) albo null.
 */
export function quoteCorrectsSlot(claimText: string, quote: string, aspect: NumericAspect): SlotCorrection | null {
  const c = extractSlots(claimText);
  const q = extractSlots(quote);
  if (aspect === "czas") {
    if (c.years.length === 0 || q.years.length === 0) return null;
    if (c.years.some((y) => q.years.includes(y))) return null;
    return { claim: c.years, quote: q.years };
  }
  if (c.values.length === 0 || q.values.length === 0) return null;
  if (c.values.some((v) => q.values.some((w) => sameValue(v, w)))) return null;
  if (c.years.length > 0 && q.years.length > 0 && !c.years.some((y) => q.years.includes(y))) return null;
  return { claim: c.values.map(fmt), quote: q.values.map(fmt) };
}
