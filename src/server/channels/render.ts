import type { ConversationReply } from "../../shared/contracts";

/** Prosty renderer tekstowy (bez LLM): treść odpowiedzi, odnośnik do wyniku, opcjonalnie lista opcji. */
export function renderReplyText(reply: ConversationReply, opts: { buttons: boolean }): string {
  const parts = [reply.textPl];
  const notices = reply.kind === "status" ? reply.report?.warnings.filter(w => w.kind === "incident_domain" || (w.kind === "source_status" && w.links?.length)) ?? [] : [];
  parts.push(...notices.map(w => w.textPl));
  if (reply.resultUrl && (reply.kind === "verdict" || reply.kind === "answer" || reply.report?.videoAnalysis || reply.report?.imageAnalysis || notices.length)) {
    parts.push(reply.kind === "transcription" ? `Transkrypcja nagrania: ${reply.resultUrl}` : `Pełny wynik ze źródłami: ${reply.resultUrl}`);
  }
  if (!opts.buttons && !reply.shortAnswer && reply.quickReplies.length > 0) {
    parts.push(`Możesz odpowiedzieć: ${reply.quickReplies.map((q) => q.labelPl).join(" | ")}`);
  }
  return parts.join("\n\n");
}
