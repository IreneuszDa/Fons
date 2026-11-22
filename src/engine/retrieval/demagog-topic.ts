import { z } from "zod";
import type { LlmProvider, ModelUsage } from "../../shared/contracts";
import { fence, UNTRUSTED_DATA_RULES } from "../llm/fence";
import { catalogSourceForUrl } from "../../corpus/catalog";
import { baseFromCatalog } from "../../corpus/ingest/common";
import { isForeignSection, toDemagogRecord, type FactCheckReview } from "../../corpus/ingest/demagog";
import { detectInjection } from "../../security/detector";
import { answerEvidenceItem } from "../answer";
import type { PublishedAnswer } from "../published";
import { truncateWords } from "../text";
import { contentTokens } from "./fts";
import { demagogReviewPages, type IndexUnavailable } from "./google-claimreview";
import { fold, stemToken } from "./stem";

type TopicResult =
  | { status: "hit" | "related"; publication: PublishedAnswer }
  | { status: "clarify"; messagePl: string }
  | { status: "empty" }
  | IndexUnavailable;

interface MatchOptions {
  llm?: LlmProvider;
  onUsage?: (usage: ModelUsage) => void;
}

export type DemagogTopicIndex = (question: string, fetchedAt: Date, signal?: AbortSignal, opts?: MatchOptions) => Promise<TopicResult>;

const REVIEW_FRAME = /(?:demagog(?:a|owi)?\s+(?:(?:to|już|juz|kiedyś|kiedys|wcześniej|wczesniej)\s+)*(?:sprawdz\p{L}*|(?:z?weryfik|zweryfik)\p{L}*|oceni\p{L}*)|(?:weryfikacj\p{L}*|fact[ -]?check\p{L}*|sprawdz\p{L}*|(?:z?weryfik|zweryfik)\p{L}*)\s+(?:(?:to|przez)\s+)?demagog(?:a)?)/iu;

function topicIn(question: string): string {
  const frame = REVIEW_FRAME.exec(question);
  if (!frame) return "";
  let rest = question.slice(frame.index + frame[0].length).trim();
  if (/^[\s?!.]*$/u.test(rest) && /przez\s+demagoga/iu.test(frame[0])) {
    rest = question.slice(0, frame.index).replace(/\s+(?:by[łl][oa]?|zosta[łl][oa]?)\s*$/iu, "");
  }
  if (!rest.replace(/[\s?!.,:;]+/g, "")) rest = question.slice(0, frame.index).replace(/\b(?:czy|i)\s*$/iu, "");
  return rest.replace(/^[\s?!.,:;–—-]*/u, "")
    .replace(/^(?:(?:informację|twierdzenie|tezę|wypowiedź|stwierdzenie)(?:\s+o tym)?(?:\s*,)?\s+)?(?:czy|że|na temat)\s+/iu, "")
    .replace(/^czy\s+/iu, "").replace(/^[„«"]+|[?!.\s”»"]+$/gu, "").trim();
}

function statement(text: string): string {
  // Preserve quantities, negation, word order and mathematical operators.
  return fold(text).replace(/^[\s„"«]+|[\s?!.„”"»]+$/gu, "").replace(/^czy\s+/u, "")
    .replace(/[,;](?=\s)/gu, " ").replace(/\s+/gu, " ").trim();
}

function terms(s: string): Set<string> {
  return new Set(contentTokens(s).map(t => fold(stemToken(t, "pl") ?? t)));
}

function relativeOverlap(asked: Set<string>, review: FactCheckReview): number {
  const available = terms([review.claim, review.title].filter(Boolean).join(" "));
  let matched = 0;
  for (const word of asked) if (available.has(word)) matched++;
  return matched >= 2 ? matched / asked.size : 0;
}

function published(review: FactCheckReview, fetchedAt: Date, match: "claim" | "title" | "related", support?: string): PublishedAnswer | undefined {
  if (isForeignSection(review.url)) return;
  const source = catalogSourceForUrl(review.url);
  if (source?.id !== "demagog") return;
  const record = toDemagogRecord(review, baseFromCatalog(source), fetchedAt.toISOString());
  if (!record?.rating?.raw || !record.claimReviewed) return;
  const excerptStart = truncateWords(record.claimReviewed, 340);
  const excerpt = excerptStart.length < record.claimReviewed.length ? excerptStart + "…" : excerptStart;
  const quote = support && record.claimReviewed.includes(support) ? support : excerptStart;
  const raw = record.rating.raw;
  const answerPl = match === "claim" ? `Tak. Demagog sprawdził tę tezę i podał ocenę „${raw}”.`
    : match === "title" ? `Tak, znalazłem publikację Demagoga o tym tytule. W indeksie ocena „${raw}” dotyczy tezy „${excerpt}”.`
    : `Znalazłem publikację Demagoga na podobny temat. Sprawdzana w niej teza brzmi „${excerpt}”. Czy chodzi Ci o tę tezę?`;
  const evidence = answerEvidenceItem(record, quote);
  evidence.ratingRaw = raw;
  evidence.relation = "INNY_KONTEKST";
  evidence.group = "kontekst";
  if (match === "claim" && record.rating.mapped === "FALSZYWE") { evidence.relation = "OBALA"; evidence.group = "obalajace"; }
  if (match === "claim" && record.rating.mapped === "POTWIERDZONE") { evidence.relation = "WSPIERA"; evidence.group = "wspierajace"; }
  if (match === "claim" && record.rating.mapped === "WPROWADZAJACE") evidence.relation = "CZESCIOWO";
  return { answerPl, evidence: [evidence],
    ...(match === "claim" && record.rating.mapped && { verdict: record.rating.mapped, claimPl: record.claimReviewed }) };
}

const Decision = z.object({
  candidate: z.number().int(), // zero when none matches
  claimQuotes: z.array(z.string()),
});

const MATCH_PROMPT = "Oceń, czy którykolwiek wynik wyszukiwania to rzeczywiście weryfikacja tezy użytkownika. " +
  "Porównaj kto, co zrobił, komu, kiedy, gdzie, liczby i ich role, warunki, wyjątki, negację oraz zakres. " +
  "Dopuszczaj parafrazę lub precyzyjne pytanie o główne sprawdzane twierdzenie dłuższej wypowiedzi. " +
  "Wzmianka o temacie, osobie lub miejscu, podobny nagłówek, zaprzeczenie tezy albo jej rozstrzygnięcie w innym okresie nie wystarczają. " +
  "Pole tytuł pomaga wskazać przedmiot publikacji, ale może przedstawiać wniosek wydawcy przeciwny ocenianej tezie. " +
  "Przy zgodności zwróć numer wyniku i od jednego do trzech krótkich dosłownych fragmentów z pola teza, które wspólnie uzasadniają zgodność. " +
  "Nie rozstrzygaj samodzielnie prawdziwości informacji. W razie rozbieżności lub niepewności zwróć candidate 0 i pustą listę cytatów. " +
  UNTRUSTED_DATA_RULES;

interface Candidate { review: FactCheckReview; score: number }

function numbers(s: string): string[] {
  return s.match(/\d+(?:[.,]\d+)?/g)?.map(x => x.replace(",", ".")) ?? [];
}

function names(s: string): string[] {
  const significant = new Set(contentTokens(s));
  return [...new Set([...s.matchAll(/\p{Lu}[\p{L}-]+/gu)].map(m => m[0]).filter(w => significant.has(w.toLowerCase())))];
}

function queryFor(topic: string): string {
  const named = names(topic);
  const numeric = [...new Set(numbers(topic))];
  // Full questions rarely occur verbatim in Google's index. Proper names and numbers retrieve
  // multiple possible documents; the subsequent claim comparison is independent of these search terms.
  if (named.length) return [...named.slice(0, 3), ...numeric.slice(0, 2)].join(" ");
  return contentTokens(topic).length <= 5 ? topic : contentTokens(topic).slice(0, 4).join(" ");
}

function scopeCompatible(topic: string, review: FactCheckReview): boolean {
  const combined = [review.claim, review.title ?? ""].join(" ");
  const required = numbers(topic);
  const found = new Set(numbers(review.claim));
  if (required.some(n => !found.has(n))) return false;
  const titleNumbers = numbers(review.title ?? "");
  if (required.length && titleNumbers.length && !required.some(n => titleNumbers.includes(n))) return false;
  const candidateWords = terms(combined);
  return names(topic).every(w => candidateWords.has(fold(stemToken(w.toLowerCase(), "pl") ?? w)));
}

function negated(text: string): boolean {
  return /\b(?:nie|nigdy|zaden|zadna|zadne|zadnych)\s+(?!\d)/.test(fold(text));
}

async function matchParaphrase(topic: string, candidates: Candidate[], opts: MatchOptions, signal?: AbortSignal) {
  if (!opts.llm?.available || !candidates.length) return;
  const rows = candidates.map(({ review }, i) => ({
    number: i + 1, teza: truncateWords(review.claim, 1300), tytul: review.title ?? "",
  }));
  try {
    const result = await opts.llm.complete({
      purpose: "publication_match", schemaName: "publication_match", schema: Decision, system: MATCH_PROMPT, signal,
      user: [fence("PYTANIE", topic).text, fence("WYNIKI", JSON.stringify(rows)).text].join("\n"),
      tier: "fast", effort: "low", maxTokens: 500,
    });
    opts.onUsage?.(result.usage);
    const row = rows[result.data.candidate - 1];
    const quotes = result.data.claimQuotes;
    if (!row || !quotes.length || quotes.length > 3 || quotes.some(q => q.trim().length < 10 || !row.teza.includes(q.trim()))) return;
    const support = quotes.join(" ");
    if (negated(topic) !== negated(support)) return;
    const cited = new Set(numbers(support));
    if (numbers(topic).some(n => !cited.has(n))) return;
    // Keep the sentence that actually supported the match, even if it occurs after a long preamble.
    const review = candidates[result.data.candidate - 1]!.review;
    const spans = quotes.map(q => { const literal = q.trim(); return { start: review.claim.indexOf(literal), literal }; });
    const first = Math.min(...spans.map(s => s.start));
    const last = Math.max(...spans.map(s => s.start + s.literal.length));
    const excerpt = last - first <= 340 ? review.claim.slice(first, last) : spans.sort((a, b) => b.literal.length - a.literal.length)[0]!.literal;
    return { review, support: truncateWords(excerpt, 340) };
  } catch {
    return;
  }
}

/** Searches the current Google index first. The publisher's real claim and rating supply the answer. */
export function createDemagogTopicIndex(apiKey?: string, fetchImpl: typeof fetch = fetch): DemagogTopicIndex {
  return async (question, fetchedAt, signal, opts = {}) => {
    const topic = topicIn(question);
    const asked = terms(topic);
    if (topic.length > 400 || asked.size < 2) return { status: "clarify", messagePl: "Podaj treść tezy lub tytuł publikacji Demagoga, którą mam znaleźć w indeksie Google." };
    const needle = statement(topic);
    const selected = new Map<string, Candidate>();
    let incomplete: IndexUnavailable | undefined;
    let titleMatch: PublishedAnswer | undefined;
    const query = queryFor(topic);
    const broaderQuery = names(topic)[0] ?? contentTokens(topic)[0] ?? query;
    for (const search of new Set([query, broaderQuery])) {
      for await (const page of demagogReviewPages(apiKey, fetchImpl, search, signal)) {
        if (page.status === "unavailable") {
          if (page.reason !== "incomplete") return page;
          incomplete = page;
          break;
        }
        for (const review of page.reviews) {
          if (isForeignSection(review.url) || detectInjection([review.claim, review.title, review.rating].join("\n"), "evidence").length) continue;
          if (statement(review.claim) === needle) {
            const publication = published(review, fetchedAt, "claim");
            if (publication) return { status: "hit", publication };
          }
          if (review.title && statement(review.title) === needle) titleMatch ??= published(review, fetchedAt, "title");
          const key = JSON.stringify([review.url, review.claim]);
          if (!selected.has(key)) selected.set(key, { review, score: relativeOverlap(asked, review) });
        }
      }
      if (selected.size || incomplete) break;
    }
    if (titleMatch) return { status: "hit", publication: titleMatch };
    const ranked = [...selected.values()].sort((a,b) => b.score - a.score);
    const candidates = ranked.filter(c => scopeCompatible(topic, c.review)).slice(0, 5);
    const matched = await matchParaphrase(topic, candidates, opts, signal);
    if (matched) {
      const publication = published(matched.review, fetchedAt, "claim", matched.support);
      if (publication) return { status: "hit", publication };
    }
    const related = ranked.find(c => c.score >= 0.5);
    const publication = related && published(related.review, fetchedAt, "related");
    if (publication) return { status: "related", publication };
    return incomplete ?? { status: "empty" };
  };
}
