import type { ConversationReply } from "../../shared/contracts";

/** Prosty renderer tekstowy (bez LLM): treść odpowiedzi, odnośnik do wyniku, opcjonalnie lista opcji. */
export function renderReplyText(reply: ConversationReply, opts: { buttons: boolean }): string {
  const parts = [reply.textPl];
  if (reply.resultUrl && (reply.kind === "verdict" || reply.kind === "answer")) parts.push(`Pełny wynik ze źródłami: ${reply.resultUrl}`);
  if (!opts.buttons && reply.quickReplies.length > 0) {
    parts.push(`Możesz odpowiedzieć: ${reply.quickReplies.map((q) => q.labelPl).join(" | ")}`);
  }
  return parts.join("\n\n");
}
