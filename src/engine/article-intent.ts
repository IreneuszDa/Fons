import { foldForMatch } from "./text";
import { z } from "zod";
import { LlmUnavailableError, type LlmProvider, type ModelUsage } from "../shared/contracts";
import { fence, UNTRUSTED_DATA_RULES } from "./llm/fence";

// Skip the router for short, unambiguous structural requests; other wording is classified semantically.
const SIMPLE_REVIEW = /^(?:hej |czesc |dzien dobry )?(?:prosze )?(?:(?:sprawdz|zweryfikuj|przeanalizuj|ocen)(?: mi)?(?: prosze)?(?: (?:to|ten (?:artykul|tekst|wpis)|te strone|ten link))?(?: czy to prawda)?|czy to prawda)$/;

export function asksToCheckMaterial(note = ""): boolean {
  return !note.trim() || SIMPLE_REVIEW.test(foldForMatch(note));
}

const ArticleRequest = z.object({ intent: z.enum(["review", "question"]) });

/** Route on the sender's note only. An article never chooses its own verification path. */
export async function routeArticleRequest(note: string | undefined, llm: LlmProvider, signal?: AbortSignal):
Promise<{ review: boolean; usage?: ModelUsage }> {
  if (!note || asksToCheckMaterial(note)) return { review: true };
  const fallback = { review: !/[?]|(?:^|\s)(?:czy|kiedy|ile|gdzie|dlaczego|kto)\s/iu.test(note) };
  if (!llm.available) return fallback;
  try {
    const result = await llm.complete({
      purpose: "router", schemaName: "article_request", tier: "fast", schema: ArticleRequest, signal,
      system: "Ustal cel wiadomości dołączonej do artykułu. review = analiza wiarygodności artykułu, argumentów lub tez wybranych z tekstu, również w zawężonym temacie. question = autor wiadomości zadaje konkretne pytania merytoryczne, podaje własne twierdzenie do sprawdzenia lub porównuje konkretny dokument. Samo pytanie o prawdziwość materiału to review. " + UNTRUSTED_DATA_RULES,
      user: fence("PROSBA", note.slice(0, 1400)).text,
    });
    return { review: result.data.intent === "review", usage: result.usage };
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
    return fallback;
  }
}
