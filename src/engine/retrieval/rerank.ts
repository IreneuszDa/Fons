/**
 * Tanie przeszeregowanie leksykalne puli kandydatów (po RRF), zanim do modelu trafi 6–8 fragmentów.
 *
 * Wynik = waga rangi z fuzji + pokrycie terminów „obowiązkowych” (nazwy własne, lata, liczby z twierdzenia)
 *       + pokrycie rdzeni zapytań w tytule / tezie fact-checku + pokrycie rdzeni w treści.
 * Funkcja czysta: dostaje rekordy już pobrane z bazy (silnik i tak je pobiera), nie dotyka bazy ani sieci.
 */
import type { CorpusRecord, EvidenceCandidate } from "../../shared/contracts";
import { asksForElectionWinner, electionResultStage } from "../election-result";
import { institutionalMeasure, sourceMeasureValues } from "../verdict/slots";
import { contentTokens } from "./fts";
import { detectLang, fold, mobileEVariant, stemsFor } from "./stem";

export interface RerankOptions {
  /** Tekst twierdzenia/pytania i zapytania dodatkowe. */
  queryTexts: string[];
  /** Nazwy własne, lata, liczby, które trafny rekord powinien zawierać. */
  mustHave?: string[];
  /** Ile kandydatów zwrócić (domyślnie wszystkie). */
  limit?: number;
  weights?: Partial<RerankWeights>;
}

export interface RerankWeights {
  rank: number;
  mustHave: number;
  title: number;
  text: number;
}

export const DEFAULT_RERANK_WEIGHTS: RerankWeights = { rank: 1.0, mustHave: 0.9, title: 0.6, text: 0.5 };

/**
 * Rdzenie zapytania (złożone, bez ogonków) — do dopasowania prefiksowego w tekście rekordu.
 * Tokeny, które mają pasować DOKŁADNIE (liczby, tokeny ≤ 3 znaki), są oznaczone końcowym „$”.
 */
export function queryStems(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const lang = detectLang(t);
    for (const tok of contentTokens(t)) {
      const stems = stemsFor(tok, /[ąćęłńóśźż]/.test(tok) ? "pl" : lang);
      if (stems.some((s) => s === null)) {
        // Numbers and very short tokens („UE”, „PE”) — exactly; short words („Sejm”, „NATO”) — as prefixes,
        // because in the record they are often inflected („Sejmu”, „NATO-wski”).
        const f = fold(tok);
        out.add(/\p{N}/u.test(f) || Array.from(f).length <= 3 ? `${f}$` : f);
        continue;
      }
      // „mixed”: krótszy z rdzeni PL/EN (prefiks obejmuje oba warianty).
      out.add(fold((stems as string[]).reduce((a, b) => (b.length < a.length ? b : a))));
    }
  }
  return [...out];
}

function tokenSet(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function hasPrefix(tokens: string[], stem: string): boolean {
  if (stem.endsWith("$")) return tokens.includes(stem.slice(0, -1));
  const v = mobileEVariant(stem);
  return tokens.some((t) => t.startsWith(stem) || (v !== null && t.startsWith(v)));
}

/** Pokrycie zbioru rdzeni w tokenach (0–1). Liczby i krótkie tokeny — dokładnie, reszta — prefiks. */
function coverage(stems: string[], tokens: string[]): number {
  if (stems.length === 0) return 0;
  let hit = 0;
  for (const s of stems) if (hasPrefix(tokens, s)) hit++;
  return hit / stems.length;
}

/**
 * Termin obowiązkowy („Mark Rutte”, „2024”) jest obecny, gdy obecne są wszystkie jego tokeny.
 * Warianty rozdzielone „|” („Litwa | Lithuania”) są alternatywami — wystarczy jeden.
 */
function mustHaveCoverage(terms: string[], tokens: string[]): number {
  const usable = terms
    .map((t) => t.split("|").map((alt) => queryStems([alt])).filter((s) => s.length > 0))
    .filter((alts) => alts.length > 0);
  if (usable.length === 0) return 0;
  const present = (stems: string[]) => stems.every((s) => hasPrefix(tokens, s));
  let hit = 0;
  for (const alts of usable) if (alts.some(present)) hit++;
  return hit / usable.length;
}

export interface Scored {
  candidate: EvidenceCandidate;
  score: number;
  parts: { rank: number; mustHave: number; title: number; text: number };
}

export function scoreCandidates(
  candidates: EvidenceCandidate[],
  records: Map<string, CorpusRecord>,
  opts: RerankOptions,
): Scored[] {
  const w = { ...DEFAULT_RERANK_WEIGHTS, ...opts.weights };
  const stems = queryStems(opts.queryTexts);
  const must = opts.mustHave ?? [];
  const electionWinner = asksForElectionWinner(opts.queryTexts[0] ?? "");
  const measure = institutionalMeasure(opts.queryTexts[0] ?? "");
  const years = (opts.queryTexts[0] ?? "").match(/\b(?:19|20)\d{2}\b/g) ?? [];
  return candidates.map((c, i) => {
    const r = records.get(c.recordId);
    const rank = 1 / (1 + i * 0.12);
    if (!r) return { candidate: c, score: w.rank * rank, parts: { rank, mustHave: 0, title: 0, text: 0 } };
    const head = tokenSet(`${r.title} ${r.claimReviewed ?? ""}`);
    const body = tokenSet(`${r.title} ${r.claimReviewed ?? ""} ${r.text}`);
    const parts = {
      rank,
      mustHave: mustHaveCoverage(must, body),
      title: coverage(stems, head),
      text: coverage(stems, body),
    };
    // Among relevant official results for the requested election, favor the passage naming the winner.
    const finalResult = electionWinner && parts.title > 0 && electionResultStage(r) === "elected"
      && years.every(year => body.includes(year));
    const suppliesMeasure = measure && r.level === 1 && r.role === "tresc" && r.type === "pierwotne"
      && sourceMeasureValues(measure, r.text, r.sourceId === "sejm-eli").length === 1;
    const score = w.rank * parts.rank + w.mustHave * parts.mustHave + w.title * parts.title + w.text * parts.text
      + (finalResult ? w.rank * parts.text : 0) + (suppliesMeasure ? w.rank + w.title : 0);
    return { candidate: c, score, parts };
  });
}

/** Zwraca kandydatów posortowanych po wyniku przeszeregowania (stabilnie przy remisie). */
export function lexicalRerank(
  candidates: EvidenceCandidate[],
  records: Map<string, CorpusRecord>,
  opts: RerankOptions,
): EvidenceCandidate[] {
  const scored = scoreCandidates(candidates, records, opts)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }) => s.candidate);
  return opts.limit !== undefined ? scored.slice(0, opts.limit) : scored;
}
