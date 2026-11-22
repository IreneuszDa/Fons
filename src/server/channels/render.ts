import { reportEvidence, type ConversationReply } from "../../shared/contracts";
import { safeHttpUrl } from "../util";

/** Prosty renderer tekstowy (bez LLM): treść odpowiedzi, odnośnik do wyniku, opcjonalnie lista opcji. */
export function renderReplyText(reply: ConversationReply, opts: { buttons: boolean }): string {
  const parts = [reply.textPl];
  const report = reply.report;
  const sources = reply.shortAnswer?.sources ?? (report?.status === "OK" ? reportEvidence(report) : []);
  const analysis = report?.imageAnalysis;
  const imageSources = [
    ...(analysis?.visual?.citations ?? []),
    ...(analysis?.images.flatMap(image => [
      ...(image.localSearch?.matches ?? []),
      ...(image.search?.matches ?? []),
      ...(image.search?.factChecks ?? []),
    ]) ?? []),
  ];
  const urls = new Set([...sources, ...imageSources].map(source => source.url && safeHttpUrl(source.url)));
  for (const url of urls) {
    if (url && !reply.textPl.includes(url)) parts.push(`Źródło: ${url}`);
  }
  if (reply.resultUrl && (reply.kind === "verdict" || reply.kind === "answer" || reply.kind === "sources" || reply.kind === "why" || reply.report?.videoAnalysis || reply.report?.imageAnalysis)) {
    parts.push(reply.kind === "transcription" ? `Transkrypcja nagrania: ${reply.resultUrl}` : `Pełny wynik ze źródłami: ${reply.resultUrl}`);
  }
  if (!opts.buttons && !reply.report && reply.quickReplies.length > 0) {
    parts.push(`Możesz odpowiedzieć: ${reply.quickReplies.map((q) => q.labelPl).join(" | ")}`);
  }
  return parts.join("\n\n");
}
