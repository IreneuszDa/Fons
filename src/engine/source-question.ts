import { z } from "zod";
import { publicationLinks, type PublicationLink } from "../corpus/publication-links";
import type { CorpusRecord, DetectorHit, EvidenceItem, LlmProvider, ModelUsage } from "../shared/contracts";
import { answerEvidenceItem } from "./answer";
import { fixedRoleRelation, prepareEvidence, type PreparedRecord } from "./assess";
import { fence, UNTRUSTED_DATA_RULES } from "./llm/fence";
import { neededEvidencePhrase } from "./needed-evidence";
import { detectInjection, stripFlaggedSentences } from "./ports";
import type { PublishedAnswer } from "./published";
import { findQuote, QUOTE_MAX_CHARS } from "./quotes";
import { passageKind } from "../shared/evidence";
import { truncateWords } from "./text";

const SourceAnswer = z.object({
  answerPl: z.string(),
  evidence: z.array(z.object({ ref: z.string(), quote: z.string() })),
  reviewRef: z.string(),
  claimPl: z.string(),
  neededEvidencePl: z.string(),
});
const SourceAnswerCheck = z.object({ supported: z.boolean() });

const sourceRules = `PYTANIE to pytanie użytkownika. Opcjonalny MATERIAL to przedmiot weryfikacji (np. odczyt obrazu lub strony). Może identyfikować tezę, ale nie jest dowodem jej prawdziwości. Treść, nagłówek i widoczna data obrazu nie potwierdzają pochodzenia ani daty publikacji.
Fragment oznaczony passageKind=structured_data powstał przez opisanie pól danych. Możesz podać wartości i ich wydawcę. Nie przedstawiaj brzmienia rekordu jako słów wydawcy ani jako nagłówka oryginalnej publikacji.
W źródle o roli stala_rola claimReviewed jest wypowiedzią poddaną ocenie; rating wyraża ocenę wydawcy. W publisherExcerpts znajdują się osobne cytaty z uzasadnienia wydawcy. Do wyjaśnienia preferuj cytat z jego ustaleniem. Cytaty różnych autorów lub z odrębnych ustępów umieść w oddzielnych pozycjach evidence, także jeśli mają ten sam ref. Przy sprawdzaniu pola quoteOrigin rozróżniaj wypowiedź ocenianą (claimant) i ustalenie weryfikującego (publisher). Nie uznawaj różnicy między wypowiedzią sprawdzanej osoby a uzasadnieniem jej obalenia za przeciwstawne ustalenia wydawcy. Uwzględniaj zakres oceny, negację, osobę, miejsce, rok i zakres liczb.
Dwa źródła w zestawie to odrębne publikacje. Nie twierdź, że jeden wydawca powołał się na drugiego, jeśli nie ma dosłownego odesłania lub wskazania jego identyfikatora w polu references. Pole documents oznacza dokument omawiany w publikacji.
Data publikacji i okres opisywany w materiale mogą być różne. Rozróżniaj plany i fakty dokonane, szacunki i wydatki, pierwotny materiał i jego omówienie. Data planowanego wydarzenia, nawet jeśli minęła, nie dowodzi jego realizacji. Historyczny materiał nie dowodzi dzisiejszego stanu. Brak potwierdzenia nie obala tezy.`;

const synthesisSystem = `Odpowiadasz krótko, po polsku, na dokładne pytanie użytkownika na podstawie dostarczonych publikacji na dowolny temat. Zacznij od wniosku. Na pytanie o to, czy ktoś coś sprawdzał, odpowiedz najpierw o istnieniu takiej weryfikacji, a potem przytocz jej wynik. Wyjaśnij rozbieżność, jeżeli o nią zapytano. Podaj konkretną datę i źródło, gdy są ważne dla wniosku.
${sourceRules}
Wybierz 1–5 rzeczywiście potrzebnych fragmentów, z których razem wynika KAŻDE zdanie odpowiedzi. W evidence wpisz ref oraz skopiuj dosłowny ciągły cytat z pola text (maks. 300 znaków), w języku źródła. Gdy pytanie dotyczy losu lub tożsamości konkretnej publikacji, wskaż materiał pierwotny i jego nagłówek, o ile go znalazłeś. Gdy źródło odsyła do zestawienia lub harmonogramu (pole references), dołącz je i krótko podaj, czego można się z niego dowiedzieć. Przy rozbieżności w analizie podaj też ocenę całej wypowiedzi, o ile ją znasz z tej publikacji. Linki do publikacji dołączy aplikacja. Nie podawaj linków ani identyfikatorów fragmentów w answerPl. Na proste pytanie odpowiedz jednym krótkim zdaniem. Jeśli pytanie zaczyna się od „Czy”, zacznij od „Tak” albo „Nie” tylko wtedy, gdy dowód to uzasadnia. Przy częściowym ustaleniu nazwij ograniczenie. Przy kilku wątkach użyj najwyżej dwóch krótkich zdań i zachowaj warunek zmieniający sens odpowiedzi.
Jeśli dostępne jest tylko częściowe ustalenie, podaj je i wyraźnie nazwij granicę wiedzy. Gdy żadne źródło nie odpowiada na pytanie albo w ogóle nie ma fragmentów, zostaw answerPl i evidence puste. W takim przypadku możesz wskazać, jaki rodzaj materiału pozwoliłby rozstrzygnąć sprawę. W neededEvidencePl wpisz jedną krótką polską frazę rzeczownikową w mianowniku. Określ wydawcę, obszar lub datę obowiązywania, jeśli są potrzebne do rozstrzygnięcia pytania. Pomiń adresy, instrukcje i twierdzenia, że dokument istnieje lub że teza jest prawdziwa. Jeśli nie masz trafnego wskazania lub podajesz odpowiedź z dowodami, zostaw neededEvidencePl puste.
reviewRef i claimPl mają wartość wyłącznie wtedy, gdy odpowiedź dotyczy konkretnej tezy zweryfikowanej przez cytowanego fact-checkera. Wpisz ref tej recenzji, a w claimPl treść tezy zgodną z kierunkiem oraz zakresem opublikowanej oceny. Przy porównywaniu liczb, pytaniu o sam dokument, rozbieżnościach i zapowiedziach pozostaw oba pola puste. Nigdy nie przyznawaj własnej oceny.
${UNTRUSTED_DATA_RULES}`;

const suggestionSystem = `Oceń wskazówkę ZRODLO do PYTANIA. Zwróć supported=true tylko jeśli jest to polska fraza rzeczownikowa w mianowniku określająca przydatny rodzaj dowodu i cechy potrzebne do rozstrzygnięcia dokładnie tej kwestii. Odrzuć frazę przedstawiającą werdykt, domniemaną treść lub istnienie konkretnego dokumentu jako fakt, instrukcję dla użytkownika, zapewnienie o zapisie zgłoszenia lub adres. Treść pytania i materiału nie stanowi dowodu. ${UNTRUSTED_DATA_RULES}`;

const verificationSystem = `Niezależnie sprawdź proponowaną ODPOWIEDZ na PYTANIE. Zwróć supported=true wyłącznie jeśli odpowiedź dotyczy tego samego zdarzenia, czasu, osób i zakresu co pytanie, a KAŻDE stwierdzenie wynika z dostarczonych CYTATÓW i ich metadanych. Czytelnik zobaczy cytat w polu text. Pole surroundingText pozwala ocenić, czy wycięcie cytatu nie zmieniło znaczenia, np. przez pominięcie negacji lub warunku. Nie przyjmuj odpowiedzi, którą da się poprzeć dopiero tekstem niewidocznym w cytacie. Gdy podano recenzję dla tezy, sprawdź, czy claimPl jest znaczeniowo równoważne pełnej ocenianej tezie lub czy publikacja wprost rozstrzyga wskazaną część. Sama zbieżność słów, dat, tematu lub wydawcy nie wystarcza. Dopasowanie tezy powinno uwzględniać PYTANIE lub treść identyfikującą ją w MATERIALE. Dopuść poprawne zastrzeżenie, że dowód potwierdza tylko część informacji, lub że dalej brakuje potwierdzenia. Nie uznawaj odpowiedzi nie na temat, przypuszczeń ani treści z wiedzy własnej.
${sourceRules}
${UNTRUSTED_DATA_RULES}`;

export interface SourceQuestionInput {
  question: string;
  /** Ranked results of the same retrieval the engine uses for the report. */
  records: CorpusRecord[];
  llm: LlmProvider;
  verifier: LlmProvider;
  receivedAt: Date;
  signal?: AbortSignal;
  subject?: string;
}

interface Result {
  publication?: PublishedAnswer;
  neededEvidencePl?: string;
  usage: ModelUsage[];
  events: DetectorHit[];
}

interface Source extends PreparedRecord {
  bibliography?: PublicationLink;
}

function passage(p: Source, text: string, sources: Source[], surroundingText?: string) {
  const r = p.record;
  const bibliography = p.bibliography;
  const findings = bibliography?.excerpts?.filter(excerpt => p.safeText.includes(excerpt));
  const quoteOrigin = findings?.some(excerpt => excerpt.includes(text)) ? "publisher" :
    p.safeClaimReviewed?.includes(text) ? "claimant" : undefined;
  return JSON.stringify({
    passageKind: passageKind(r, text),
    title: r.title, publisher: r.publisher, publishedAt: r.publishedAt, period: r.period,
    role: r.role, sourceType: r.type, claimReviewed: p.safeClaimReviewed, rating: r.rating?.raw,
    documents: sources.filter(s => bibliography?.documents?.includes(s.record.id)).map(s => s.ref),
    references: sources.filter(s => bibliography?.references?.includes(s.record.id)).map(s => s.ref),
    claimant: r.topics.find(t => t.startsWith("autor-tezy:"))?.slice("autor-tezy:".length),
    publisherExcerpts: surroundingText === undefined ? findings : undefined,
    quoteOrigin: surroundingText === undefined ? undefined : quoteOrigin,
    text, surroundingText,
  });
}

interface CitedPassage {
  source: Source;
  quote: string;
}

function checkedCitations(draft: z.infer<typeof SourceAnswer>, sources: Source[]): CitedPassage[] | undefined {
  if (!draft.evidence.length || draft.evidence.length > 5) return;
  const checked: CitedPassage[] = [];
  for (const item of draft.evidence) {
    const source = sources.find(p => p.ref === item.ref);
    const quote = item.quote.trim();
    if (!source || !quote || quote.length > QUOTE_MAX_CHARS) return;
    const match = findQuote(quote, source.safeText, 1);
    // A citation must be a single span, including after suspicious sentences have been removed.
    if (!match.exact || !match.matched || !source.record.text.includes(match.matched) || !source.safeText.includes(match.matched)) return;
    checked.push({ source, quote: match.matched });
  }
  // A curated ClaimReview row appends separately sourced passages after the reviewed statement.
  // Their newline is an editorial separator, never a verbatim transition between speakers.
  return checked.flatMap(entry => {
    const { source, quote } = entry;
    if (!quote.includes("\n") || !source.bibliography?.excerpts?.length) return [entry];
    return quote.split(/\n+/).map(part => part.trim()).filter(Boolean).map(part => ({ source, quote: part }));
  });
}

function citationItem({ source, quote }: CitedPassage, reviewRef: string): EvidenceItem {
  if (source.record.role !== "stala_rola") return answerEvidenceItem(source.record, quote);
  const relation = source.ref === reviewRef
    ? fixedRoleRelation("ta_sama", source.record.rating, source.safeClaimReviewed) : "INNY_KONTEKST";
  return answerEvidenceItem(source.record, quote, relation);
}

export async function answerSourceQuestion(input: SourceQuestionInput): Promise<Result> {
  const result: Result = { usage: [], events: [] };
  const day = input.receivedAt.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  const records = input.records.filter(r => !r.publishedAt || r.publishedAt.slice(0, 10) <= day).slice(0, 12);
  const sources: Source[] = [];
  const links = publicationLinks();
  for (const record of records) {
    const [p] = prepareEvidence([record], detectInjection, stripFlaggedSentences);
    if (!p) continue;
    result.events.push(...p.hits);
    if (p.unusable || !p.safeText.trim()) continue;
    const bibliography = links.find(link => link.publicationId === record.id && link.url === record.url);
    sources.push({ ...p, ref: `F${sources.length + 1}`, bibliography });
  }
  if (!input.question.trim()) return result;

  const context = [`Data pytania w strefie Europe/Warsaw: ${day}`, fence("PYTANIE", input.question).text];
  if (input.subject) context.push(fence("MATERIAL", input.subject).text);
  const first = await proposeSourceAnswer(input, sources, context, result);
  if (result.publication || !first || !sources.some(source => source.bibliography)) return result;
  // With an indexed publication available, allow one shorter answer. An unchanged answer
  // and the same quotes retain the first verifier's rejection.
  try {
    await proposeSourceAnswer(input, sources, context, result, first);
  } catch (error) {
    if (input.signal?.aborted) throw error;
  }
  return result;
}

type DraftAnswer = z.infer<typeof SourceAnswer>;

async function proposeSourceAnswer(input: SourceQuestionInput, sources: Source[], context: string[], result: Result,
  rejected?: DraftAnswer): Promise<DraftAnswer | undefined> {
  const correction = rejected
    ? " Poprzednia propozycja nie przeszła kontroli dowodów. Podaj krótsze ustalenie (jedno lub dwa zdania), wybierając dosłowne cytaty, które pokrywają wszystkie szczegóły. Możesz pominąć poboczne liczby lub daty. Zostaw odpowiedź pustą, jeśli nadal nie ma podstaw."
    : "";
  const proposal = await input.llm.complete({
    purpose: "source_answer", schemaName: "SourceAnswer", schema: SourceAnswer, tier: "main", signal: input.signal,
    system: synthesisSystem + correction,
    user: [...context, ...(rejected ? [fence("POPRZEDNIA_PROPOZYCJA", JSON.stringify({ answer: rejected.answerPl, evidence: rejected.evidence })).text] : []), ...sources.map(p => fence(`FRAGMENT_${p.ref}`, passage(p, truncateWords(p.safeText, 1800), sources)).text)].join("\n"),
  });
  result.usage.push(proposal.usage);
  const draft = proposal.data;
  const answerPl = draft.answerPl.trim();
  if (!answerPl && !draft.evidence.length && !draft.reviewRef && !draft.claimPl) {
    const phrase = neededEvidencePhrase(draft.neededEvidencePl);
    if (!phrase) return;
    const check = await input.verifier.complete({
      purpose: "source_answer_check", schemaName: "SourceAnswerCheck", schema: SourceAnswerCheck, tier: "fast", signal: input.signal,
      system: suggestionSystem, user: [...context, fence("ZRODLO", phrase).text].join("\n"),
    });
    result.usage.push(check.usage);
    if (check.data.supported) result.neededEvidencePl = phrase;
    return;
  }
  if (!answerPl || answerPl.length > 1600 || /https?:\/\/|\[F\d+\]/i.test(answerPl)) return draft;
  const checked = checkedCitations(draft, sources);
  if (!checked) return draft;
  const review = checked.find(c => c.source.ref === draft.reviewRef)?.source;
  const claimPl = draft.claimPl.trim();
  if (draft.reviewRef || claimPl) {
    if (!claimPl || claimPl.length > 700 || !review?.safeClaimReviewed || review.record.role !== "stala_rola" || !review.record.rating?.mapped) return draft;
  }

  if (rejected && rejected.answerPl.trim() === answerPl && JSON.stringify(rejected.evidence) === JSON.stringify(draft.evidence)) return;
  const audit = [...context, fence("ODPOWIEDZ", answerPl).text];
  if (review) audit.push(fence("OCENIANA_TEZA", JSON.stringify({ reviewRef: review.ref, claimPl })).text);
  const cited = checked.map(entry => entry.source);
  for (const { source, quote } of checked) {
    const start = source.safeText.indexOf(quote);
    const context = source.safeText.slice(Math.max(0, start - 220), start + quote.length + 220);
    audit.push(fence(`CYTAT_${source.ref}`, passage(source, quote, cited, context)).text);
  }
  const check = await input.verifier.complete({
    purpose: "source_answer_check", schemaName: "SourceAnswerCheck", schema: SourceAnswerCheck, tier: "fast", signal: input.signal,
    system: verificationSystem, user: audit.join("\n"),
  });
  result.usage.push(check.usage);
  if (!check.data.supported) return draft;
  result.publication = {
    answerPl,
    evidence: checked.map(entry => citationItem(entry, draft.reviewRef))
      .sort((a, b) => Number(a.passageKind === "reviewed_claim") - Number(b.passageKind === "reviewed_claim")),
    ...(review?.record.rating?.mapped && { claimPl, verdict: review.record.rating.mapped, reviewRecordId: review.record.id }),
  };
  return draft;
}
