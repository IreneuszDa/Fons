import { foldForMatch } from "./text";
import { z } from "zod";
import { LlmUnavailableError, type LlmProvider, type ModelUsage, type NormalizedInput } from "../shared/contracts";
import { detectInjection } from "../security/detector";
import { fence, UNTRUSTED_DATA_RULES } from "./llm/fence";

// Skip the router for short, unambiguous structural requests; other wording is classified semantically.
const SIMPLE_REVIEW = /^(?:hej |czesc |dzien dobry )?(?:prosze )?(?:(?:sprawdz|zweryfikuj|przeanalizuj|ocen)(?: mi)?(?: prosze)?(?: (?:to|ten (?:artykul|tekst|wpis)|te strone|ten link))?(?: czy to prawda)?|czy to prawda)$/;

export function asksToCheckMaterial(note = ""): boolean {
  return !note.trim() || SIMPLE_REVIEW.test(foldForMatch(note));
}

const ArticleRequest = z.object({ intent: z.enum(["review", "question", "claim"]) });

/** Recognise an attribution after a complete statement, without treating the linked page as that statement. */
function citedStatement(note: string): string | undefined {
  const match = /^(.{10,}?)[,.!;\s]+(?:zobacz(?:cie)? (?:sam[aie]?|tutaj|również)|(?:źródło|źródłem jest|dowód|link do źródła)|tak (?:piszą|jest napisane) (?:tu|tutaj))\s*[:.]?$/iu.exec(note);
  return match && !match[1]!.includes("?") ? match[1]!.trim() : undefined;
}

/** Asking what a publication says is distinct from asking whether the world matches its account. */
export function asksWhatArticleReports(question: string): boolean {
  const text = foldForMatch(question);
  return /^(?:co (?:ustala|opisuje|przedstawia|podaje|relacjonuje|mowi|pokazuje) (?:ten |ta |wskazany |wskazana |zalaczony |zalaczona )?(?:material|artykul|tekst|relacja|publikacja)|co wynika z (?:tego |tej )?(?:materialu|artykulu|relacji|publikacji))$/.test(text);
}

export async function readArticleAccount(input: NormalizedInput, llm: LlmProvider, verifier: LlmProvider, signal?: AbortSignal):
Promise<{ answerPl?: string; usage: ModelUsage[] }> {
  const usage: ModelUsage[] = [];
  const text = input.attachmentText?.slice(0, 10000);
  const host = URL.parse(input.submittedUrl ?? "")?.hostname;
  if (!text || !host || input.detectorHits.length) return { usage };
  const draft = await llm.complete({
    purpose: "source_answer", schemaName: "article_account", tier: "main", signal,
    schema: z.object({ quote: z.string(), summaryPl: z.string() }),
    system: "Wskaż główne ustalenie podane przez autora artykułu. Skopiuj z bloku TEKST ciągły cytat do 25 słów i 300 znaków. Wybierz samodzielny fragment, który najlepiej dokumentuje główne ustalenie i zawiera ewentualne przypisanie autorowi szacunku lub wypowiedzi. Zachowaj dokładną pisownię i interpunkcję. W summaryPl streść wyłącznie ten cytat po polsku, w jednym zdaniu. Zachowaj przypisanie wypowiedzi, czas, niepewność i status szacunków. Jeśli brak takiego cytatu, zostaw oba pola puste. " + UNTRUSTED_DATA_RULES,
    user: [fence("TYTUL", input.pageTitle ?? "").text, fence("TEKST", text).text].join("\n"),
  });
  usage.push(draft.usage);
  const quote = draft.data.quote.trim(), summary = draft.data.summaryPl.trim();
  const start = text.indexOf(quote);
  if (start < 0 || quote.length < 15 || quote.length > 300 || quote.split(/\s+/u).length > 25) return { usage };
  const safeSummary = summary.length <= 500 && !/https?:\/\//iu.test(summary) && !detectInjection(summary, "fetched_page").length ? summary : "";
  const check = await verifier.complete({
    purpose: "source_answer_check", schemaName: "article_account_check", tier: "fast", signal,
    schema: z.object({ quoteStandsAlone: z.boolean(), supported: z.boolean() }),
    system: "Oceń osobno cytat i polskie streszczenie. quoteStandsAlone oznacza, że sam CYTAT wprost dokumentuje główne ustalenie materiału, dotyczy tematu w TYTULE i po wyjęciu z KONTEKSTU zachowuje sens oraz przypisanie liczb lub wypowiedzi. supported oznacza, że STRESZCZENIE wiernie przedstawia CYTAT z uwzględnieniem KONTEKSTU. Sprawdź negacje, zakres, autorstwo i status planu lub szacunku. Zwróć supported=false dla pustego lub nadinterpretującego streszczenia. " + UNTRUSTED_DATA_RULES,
    user: [fence("TYTUL", input.pageTitle ?? "").text, fence("CYTAT", quote).text, fence("KONTEKST", text.slice(Math.max(0, start - 350), start + quote.length + 350)).text, fence("STRESZCZENIE", safeSummary).text].join("\n"),
  });
  usage.push(check.usage);
  if (!check.data.quoteStandsAlone) return { usage };
  const source = host.replace(/^www\./, "");
  if (!safeSummary || !check.data.supported) return { usage, answerPl: `W relacji serwisu ${source} czytamy „${quote}”.` };
  return { usage, answerPl: `Wskazany materiał opublikował serwis ${source}. ${safeSummary} W oryginale czytamy „${quote}”.` };
}

/** Route on the sender's note only. An article never chooses its own verification path. */
export async function routeArticleRequest(note: string | undefined, llm: LlmProvider, signal?: AbortSignal):
Promise<{ review: boolean; claim?: string; usage?: ModelUsage }> {
  if (!note || asksToCheckMaterial(note)) return { review: true };
  const claim = citedStatement(note);
  if (claim) return { review: false, claim };
  const fallback = { review: !/[?]|(?:^|\s)(?:czy|kiedy|ile|gdzie|dlaczego|kto)\s/iu.test(note) };
  if (!llm.available) return fallback;
  try {
    const result = await llm.complete({
      purpose: "router", schemaName: "article_request", tier: "fast", schema: ArticleRequest, signal,
      system: "Ustal cel wiadomości dołączonej do artykułu. review = analiza wiarygodności artykułu, argumentów lub tez wybranych z tekstu, również w zawężonym temacie. question = konkretne pytanie merytoryczne, prośba o ustalenie informacji lub porównanie dokumentów. claim = nadawca podaje własne twierdzenie, link jest sugerowanym źródłem. Samo pytanie o prawdziwość materiału to review. " + UNTRUSTED_DATA_RULES,
      user: fence("PROSBA", note.slice(0, 1400)).text,
    });
    return { review: result.data.intent === "review", ...(result.data.intent === "claim" && { claim: note }), usage: result.usage };
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
    return fallback;
  }
}
