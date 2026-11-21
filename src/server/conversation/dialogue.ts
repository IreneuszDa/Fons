import type { ConversationDecision } from "../../engine/llm/conversation";
import { MAX_TEXT_CHARS } from "../../engine/normalize";
import type { ConversationReply, InboundMessage } from "../../shared/contracts";
import { addTokens, budgetExceeded } from "../budget";
import type { ServerContext } from "../context";
import { getReportForSender } from "../reports";
import type { SessionRow } from "../sessions";
import { canVerifyWithoutDialogue, conversationReply, localConversationKind } from "./agent";
import { wantsOnlyImageAnalysis } from "./analyze-image";
import { readDocument } from "./document";
import { linksIn, maskedConversationText, resolveUserLink } from "./history";
import type { InboundOptions } from "./index";
import { NO_REPORT_TEXT, TOO_LONG_TEXT, QR, sourcesText, whyText } from "./templates";
import { buildEngineRequest, resultUrlFor, runVerification } from "./verify";

export function lastReport(ctx: ServerContext, session: SessionRow) {
  const token = session.state.lastReportToken;
  return token ? getReportForSender(ctx.db, token, session.senderId, ctx.now()) : undefined;
}

export function reportReply(kind: "sources" | "why", ctx: ServerContext, session: SessionRow): ConversationReply {
  const report = lastReport(ctx, session);
  if (!report) return { kind: "help", textPl: NO_REPORT_TEXT, quickReplies: [QR.help] };
  const resultUrl = resultUrlFor(ctx, report.token);
  return kind === "sources"
    ? { kind, textPl: sourcesText(report, resultUrl), quickReplies: [QR.why, QR.delete], resultUrl }
    : { kind, textPl: whyText(report), quickReplies: [QR.sources, QR.delete], resultUrl };
}

export async function respondToMessage(
  msg: InboundMessage,
  ctx: ServerContext,
  session: SessionRow,
  opts: InboundOptions,
  fallbackCommand?: () => ConversationReply,
): Promise<ConversationReply> {
  if (msg.document) {
    if (msg.text.length > ctx.options.maxInputChars) return { kind: "status", textPl: TOO_LONG_TEXT(ctx.options.maxInputChars), quickReplies: [] };
    const file = ctx.media.get(msg.document.dataRef);
    if (!file) return { kind: "status", textPl: "Dodaj dokument ponownie.", quickReplies: [] };
    let content: string;
    try {
      content = await readDocument(file);
    } catch (error) {
      return { kind: "status", textPl: error instanceof Error ? error.message : "Nie udało się odczytać dokumentu.", quickReplies: [] };
    }
    const text = msg.text.trim() ? `Wiadomość użytkownika: ${msg.text.trim()}

Tekst dokumentu:
${content}` : content;
    if (text.length > MAX_TEXT_CHARS) return { kind: "status", textPl: "Wiadomość z dokumentem przekracza 20 000 znaków. Skróć opis lub prześlij fragment dokumentu.", quickReplies: [] };
    return runVerification(ctx, msg, session, {
      req: { kind: "text", text, channel: msg.channel, receivedAt: msg.receivedAt }, logInput: "[dokument]",
    }, opts);
  }
  const built = buildEngineRequest(msg, ctx);
  if (built.reject) return built.reject;
  const req = built.req!;
  const verifyOriginal = () => runVerification(ctx, msg, session, { req, logInput: built.logInput }, opts);
  if (ctx.security.hasInjection?.(msg.text)) return verifyOriginal();
  if (req.kind === "image" && (!msg.text.trim() || wantsOnlyImageAnalysis(req))) return verifyOriginal();

  const text = maskedConversationText(ctx, msg.text.trim(), session.id);
  const history = session.state.history ?? [];
  const previous = lastReport(ctx, session);
  let decision: ConversationDecision | undefined;
  const now = ctx.now();
  const overBudget = opts.clientOverBudget?.() || budgetExceeded(ctx.db, ctx.cfg, now);
  if (ctx.conversationAgent && !overBudget) {
    try {
      const imageContext = req.kind === "image" ? "attached" : previous?.imageAnalysis ? "previous" : undefined;
      const result = await ctx.conversationAgent({ text, history, hasReport: !!previous, ...(imageContext && { imageContext }) });
      const tokens = result.usage.inputTokens + result.usage.outputTokens;
      addTokens(ctx.db, now, tokens);
      opts.onRoutingTokens?.(tokens);
      decision = result;
    } catch {
      ctx.log.warn({ event: "conversation_agent_unavailable" });
    }
  }
  if (req.kind === "image") {
    if (decision?.kind === "image_origin") req.imageFocus = "origin";
    return verifyOriginal();
  }
  if (!decision) {
    if (fallbackCommand) return fallbackCommand();
    const kind = localConversationKind(text);
    if (kind) return conversationReply(kind);
    if (!ctx.conversationAgent) return verifyOriginal();
    if (!overBudget && !canVerifyWithoutDialogue(text)) {
      return {
        kind: "help",
        textPl: "Mam teraz problem z połączeniem z modelem rozmowy. Jeśli chcesz coś zweryfikować, napisz „Sprawdź” i dodaj konkretne zdanie albo link.",
        quickReplies: [],
      };
    }
    decision = { kind: "verify", query: null };
  }
  if (decision.kind === "image_origin") {
    if (previous?.imageAnalysis) return {
      kind: "help", textPl: previous.imageAnalysis.images.map(image => image.provenance.textPl).join("\n"),
      quickReplies: [], resultUrl: resultUrlFor(ctx, previous.token),
    };
    return { kind: "help", textPl: "Dołącz obraz spinaczem, a sprawdzę, co jego plik mówi o pochodzeniu.", quickReplies: [] };
  }
  if (decision.kind === "reply") return { kind: "help", textPl: decision.text, quickReplies: [] };
  if (decision.kind !== "verify") return reportReply(decision.kind, ctx, session);

  const query = decision.query ?? text;
  const selected = linksIn(query);
  if (selected.length > 0) {
    const url = selected.length === 1 ? resolveUserLink(ctx, selected[0]!, msg.text, history, session.id) : undefined;
    if (!url) return { kind: "help", textPl: "Wklej proszę dokładny link do strony, którą mam teraz sprawdzić.", quickReplies: [] };
    // Keep the user's focus when a link accompanies a specific question. Omit unrelated links from the note.
    let noteText = query;
    if (decision.query === selected[0]) {
      noteText = linksIn(text).includes(selected[0]) ? text : "";
    }
    let note = noteText;
    for (const link of linksIn(noteText)) note = note.replace(link, " ");
    note = note.trim();
    return runVerification(ctx, msg, session, {
      req: { kind: "url", url, ...(note ? { text: note } : {}), channel: msg.channel, receivedAt: msg.receivedAt },
      logInput: maskedConversationText(ctx, url),
    }, opts);
  }
  if (!decision.query || !history.length) return verifyOriginal();
  const contextual = buildEngineRequest({ ...msg, text: decision.query }, ctx);
  if (contextual.reject) return contextual.reject;
  return runVerification(ctx, msg, session, { req: contextual.req!, logInput: contextual.logInput }, opts);
}
