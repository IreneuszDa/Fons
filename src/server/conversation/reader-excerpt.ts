import { z } from "zod";
import { fence, UNTRUSTED_DATA_RULES } from "../../engine/llm/fence";
import { normalizeReaderQuote, readerPassages, type ReaderExcerpt } from "../../shared/chat";
import type { ConversationReply } from "../../shared/contracts";
import type { NewsArticle } from "../../shared/news";
import { addTokens, budgetExceeded } from "../budget";
import type { ServerContext } from "../context";
import { getNewsArticle } from "../news";
import { maskedConversationText } from "./history";
import type { InboundOptions } from "./index";

export interface ResolvedExcerpt {
  article: NewsArticle;
  quote: string;
  before: string;
  after: string;
}

export function resolveReaderExcerpt(ctx: ServerContext, selection: ReaderExcerpt): ResolvedExcerpt | undefined {
  const article = getNewsArticle(ctx, selection.articleId);
  if (!article) return;
  const text = readerPassages(article).join("\n\n");
  const { start, end } = selection;
  if (end <= start || end > text.length) return;
  const quote = normalizeReaderQuote(selection.quote);
  if (!quote || normalizeReaderQuote(text.slice(start, end)) !== quote) return;
  return { article, quote, before: text.slice(Math.max(0, start - 2000), start), after: text.slice(end, end + 2000) };
}

const explanation = z.object({ answerPl: z.string() });
const instructions = [
  "Wyjaśnij po polsku zaznaczony fragment publikacji prostym językiem, w dwóch lub trzech zdaniach.",
  "Zacznij od znaczenia zaznaczonych słów w otaczającym je tekście artykułu Fons.",
  "Rozróżnij autora artykułu i redakcję, która oceniła przytaczane twierdzenie. Ocena dotyczy całej tezy. Sama teza nie jest ustaleniem redakcji.",
  "Opieraj się wyłącznie na podanych danych. Jeżeli w dostępnym materiale brakuje przyczyn lub dowodów, powiedz to zamiast je dopowiadać.",
  "Nie wydawaj własnego werdyktu. Nie dodawaj odsyłaczy.",
  UNTRUSTED_DATA_RULES,
].join(" ");

export async function explainReaderExcerpt(ctx: ServerContext, { article, quote, before, after }: ResolvedExcerpt, opts: InboundOptions): Promise<ConversationReply> {
  const now = ctx.now();
  const llm = ctx.engineDeps?.llm;
  if (llm?.available && !opts.clientOverBudget?.() && !budgetExceeded(ctx.db, ctx.cfg, now)) {
    const content = JSON.stringify({
      tytuł: article.title, wydawca: article.publisher, opublikowano: article.publishedAt,
      sprawdzanaTeza: article.claim, ocena: article.rating, redakcjaOceniająca: article.reviewer,
      dataOceny: article.reviewedAt, źródłaArtykułu: article.sources, tekstPrzedZaznaczeniem: before, tekstPoZaznaczeniu: after,
    });
    try {
      const { data, usage } = await llm.complete({
        purpose: "reader_explanation", tier: "fast", system: instructions,
        user: [fence("PUBLIKACJA", maskedConversationText(ctx, content)).text,
          fence("ZAZNACZENIE", maskedConversationText(ctx, quote)).text].join("\n"),
        schema: explanation, schemaName: "reader_explanation", maxTokens: 600, signal: AbortSignal.timeout(20_000),
      });
      const tokens = usage.inputTokens + usage.outputTokens;
      addTokens(ctx.db, now, tokens);
      opts.onRoutingTokens?.(tokens);
      const answer = maskedConversationText(ctx, data.answerPl.trim());
      if (answer && !ctx.security.hasInjection?.(answer)) return { kind: "help", textPl: answer, quickReplies: [] };
    } catch {
      ctx.log.warn({ event: "reader_explanation_unavailable" });
    }
  }
  const text = `Objaśnienie zaznaczonych słów jest chwilowo niedostępne. W artykule omawiamy twierdzenie „${article.claim}”. Wydawca recenzji (${article.reviewer}) przypisał mu ocenę „${article.rating}”.`;
  return { kind: "help", textPl: maskedConversationText(ctx, text), quickReplies: [] };
}
