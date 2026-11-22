/**
 * Open questions („Kto jest…?”, „Ile…?”) — answered ONLY with a verbatim, verified quote from a
 * catalog source, never from model knowledge.
 *
 *  1 retrieval (same branches as for claims) → up to 8 content records (fixed-role records such as
 *    fact-checks are excluded: they quote the false claims they debunk),
 *  2 the main model picks ONE fragment and a verbatim quote that answers the question (or none),
 *  3 quote check in code (contiguous passage in the stored record; detector on the quote;
 *    a quote living only in a flagged sentence is rejected),
 *  4 independent verifier vote („czy cytat wprost odpowiada na pytanie?”) — "sprzeciw" drops the answer,
 *  5 the short answer shows the verified passage. Attribution, publication and retrieval dates
 *    travel with it in the evidence record.
 * No verified quote → no answer; the summary says what was searched and that sources did not answer.
 */
import type { CorpusRecord, EvidenceItem, LlmProvider, ModelUsage, VerdictReport } from "../shared/contracts";
import { passageAssessment, passageKind, passageText } from "../shared/evidence";
import { findQuoteInRecord, type DetectFn, type PreparedRecord } from "./assess";
import { fence } from "./llm/fence";
import { OPEN_ANSWER_SYSTEM, OpenAnswerOut, VERIFIER_SYSTEM, VerifierOut } from "./prompts";
import { QUOTE_MAX_CHARS, findQuote } from "./quotes";
import { formatDatePl, truncateWords } from "./text";

export const MAX_ANSWER_FRAGMENTS = 8;
/** Evidence older than this, for a question about the current state → archival warning. */
export const ARCHIVAL_AFTER_DAYS = 365;
const FRAGMENT_MAX_CHARS = 1800;

export type OpenAnswer = NonNullable<VerdictReport["answer"]>;

export function buildOpenAnswerPrompt(question: string, prepared: PreparedRecord[]): string {
  const parts = ["Pytanie:", fence("PYTANIE", question).text, "\nFragmenty źródeł:"];
  for (const p of prepared) {
    parts.push(
      `[${p.ref}] data publikacji: ${formatDatePl(p.record.publishedAt)}` + (p.record.period ? `; okres danych: ${p.record.period}` : ""),
    );
    parts.push(fence(`FRAGMENT_${p.ref}`, `${p.record.title}\n\n${truncateWords(p.safeText, FRAGMENT_MAX_CHARS)}`).text);
  }
  return parts.join("\n");
}

export async function runOpenAnswer(
  llm: LlmProvider,
  question: string,
  prepared: PreparedRecord[],
  signal?: AbortSignal,
): Promise<{ out: OpenAnswerOut; usage: ModelUsage }> {
  const res = await llm.complete({
    purpose: "open_answer",
    system: OPEN_ANSWER_SYSTEM,
    user: buildOpenAnswerPrompt(question, prepared),
    schema: OpenAnswerOut,
    schemaName: "open_answer",
    tier: "main",
    signal,
  });
  return { out: res.data, usage: res.usage };
}

export type QuoteCheck =
  | { ok: true; record: CorpusRecord; quote: string; score: number; translationPl?: string }
  | { ok: false; reason: "none" | "unknown_ref" | "quote_not_found" | "quote_too_short" | "detector_hit" | "missing_translation"; events?: ReturnType<DetectFn> };

/** Code-side check of the model's pick: the quote must be in the stored record and pass the detector. */
export function checkOpenAnswer(out: OpenAnswerOut, prepared: PreparedRecord[], detect: DetectFn): QuoteCheck {
  if (!out.found || !out.ref.trim() || !out.quote.trim()) return { ok: false, reason: "none" };
  const p = prepared.find((x) => x.ref === out.ref.trim());
  if (!p || p.unusable || p.record.role !== "tresc") return { ok: false, reason: "unknown_ref" };
  const quote = truncateWords(out.quote.trim(), QUOTE_MAX_CHARS);
  const m = findQuoteInRecord(quote, p.record);
  if (!m.found || !m.matched) return { ok: false, reason: m.tooShort ? "quote_too_short" : "quote_not_found" };
  if (p.hits.length > 0 && !findQuote(quote, p.safeText).found) return { ok: false, reason: "detector_hit" };
  const recordQuote = truncateWords(m.matched, QUOTE_MAX_CHARS);
  const qHits = detect(recordQuote, "quote", p.record.id);
  if (qHits.length > 0) return { ok: false, reason: "detector_hit", events: qHits };
  const isPolish = p.record.lang.toLowerCase().split("-")[0] === "pl";
  const translationPl = isPolish ? "" : out.translationPl.trim();
  if (!isPolish && !translationPl) return { ok: false, reason: "missing_translation" };
  if (translationPl) {
    if (translationPl.length > 900 || /https?:\/\//i.test(translationPl)) return { ok: false, reason: "missing_translation" };
    const hits = detect(translationPl, "quote", p.record.id);
    if (hits.length) return { ok: false, reason: "detector_hit", events: hits };
  }
  return { ok: true, record: p.record, quote: recordQuote, score: m.score, ...(translationPl && { translationPl }) };
}

export async function verifyOpenAnswer(
  verifier: LlmProvider,
  question: string,
  quote: string,
  translationPl?: string,
  signal?: AbortSignal,
): Promise<{ vote: "zgoda" | "sprzeciw" | "niepewne"; usage: ModelUsage }> {
  const body = `Rodzaj: odpowiedź\nPytanie: ${question}\nCytat: ${quote}\nZaproponowano: cytat odpowiada na pytanie` +
    (translationPl ? `\nProponowany polski przekład: ${translationPl}` : "");
  const res = await verifier.complete({
    purpose: "verifier",
    system: VERIFIER_SYSTEM + (translationPl ? " Zgoda wymaga też, by proponowany przekład był po polsku, oddawał sens całego cytatu i zachowywał liczby, daty, zastrzeżenia oraz negacje. Odrzuć dopowiedzenia." : ""),
    user: `Oceń każdą pozycję.\n${fence("POZYCJA_V1", body).text}`,
    schema: VerifierOut,
    schemaName: "verifier_votes",
    tier: "fast",
    signal,
  });
  const vote = res.data.votes.find((v) => v.ref.trim() === "V1")?.vote ?? "niepewne";
  return { vote, usage: res.usage };
}

/** Date shown with the answer: publication date, or the fetch date when unknown. */
export function evidenceDate(r: CorpusRecord): string {
  return (r.publishedAt ?? r.fetchedAt).slice(0, 10);
}

export function isArchival(r: CorpusRecord, now: Date): boolean {
  const t = Date.parse(evidenceDate(r));
  return Number.isFinite(t) && now.getTime() - t > ARCHIVAL_AFTER_DAYS * 86_400_000;
}

const PRESENT =
  /(?<!\p{L})(jest|są|obecnie|aktualnie|teraz|dziś|dzisiaj|należy|należą|wynosi|wynoszą|pełni|kieruje|rządzi|currently|now|is|are)(?!\p{L})/iu;

/** Does the question ask about the current state? (model flag OR present-tense markers). */
export function asksAboutPresent(question: string, modelFlag: boolean): boolean {
  return modelFlag || PRESENT.test(question);
}

export function answerEvidenceItem(r: CorpusRecord, quote: string, relation: EvidenceItem["relation"] = "WSPIERA"): EvidenceItem {
  return {
    recordId: r.id,
    title: r.title,
    publisher: r.publisher,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    url: r.url,
    quote,
    lang: r.lang,
    ...passageAssessment(r, quote, relation),
    aspect: "sedno",
    sourceType: r.type,
    level: r.level,
    role: r.role,
    ...(r.rating?.raw && { ratingRaw: r.rating.raw }),
  };
}

/** Template answer — every descriptive field comes from the record, the quote from its stored text. */
export function buildAnswer(questionPl: string, r: CorpusRecord, quote: string, translationPl?: string): OpenAnswer {
  const kind = passageKind(r, quote);
  return {
    questionPl,
    answerPl: translationPl ?? passageText(quote, kind),
    evidence: [answerEvidenceItem(r, quote)],
  };
}

export function archivalAnswerPl(r: CorpusRecord): string {
  return `Materiał ${r.publishedAt ? "opublikowano" : "pobrano"} ${formatDatePl(evidenceDate(r))}, ponad rok temu. Obecna sytuacja mogła się zmienić.`;
}

export function answerSummaryPl(r: CorpusRecord, archival: boolean): string {
  const base = `Podstawą odpowiedzi jest ${passageKind(r, r.text) === "structured_data" ? "rekord danych" : "fragment publikacji"} wydawcy ${r.publisher} (${r.publishedAt ? "opublikowano" : "pobrano"} ${formatDatePl(evidenceDate(r))}).`;
  return archival ? `${base} Uwaga: to materiał sprzed ponad roku, stan mógł się zmienić.` : base;
}

export function noAnswerSummaryPl(searchedPl: string[], unavailablePl: string[]): string {
  const down = unavailablePl.length > 0 ? ` Nie udało się sprawdzić w: ${unavailablePl.join(", ")}.` : "";
  if (!searchedPl.length) return `Brak wystarczających dowodów. Nie uzyskaliśmy wyników wyszukiwania dla tego pytania.${down}`;
  return (
    `Brak wystarczających dowodów: szukaliśmy odpowiedzi w: ${searchedPl.join(", ")}, ale źródła z katalogu Fons nie odpowiadają wprost na to pytanie. ` +
    `Nie podajemy odpowiedzi z pamięci modelu.${down}`
  );
}
