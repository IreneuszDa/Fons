import type { ConversationReply } from "./contracts";
import { replyView, statusOf, STATUS_KEY_TITLE_PL, VERDICT_LABEL_PL } from "./reply-view";

const verdictEmoji = {
  POTWIERDZONE: "✅", FALSZYWE: "❌", WPROWADZAJACE: "⚠️", BRAK_DOWODOW: "❌", NIE_PODLEGA: "➖",
};

export type Reaction = { emoji: string; label: string };
export const reading = { emoji: "👀", label: "Fons czyta wiadomość" };
export const failed = { emoji: "⚠️", label: "Nie udało się odpowiedzieć" };

export function reactionFor(reply: ConversationReply): Reaction {
  const view = replyView(reply);
  if (view === "status") {
    const status = statusOf(reply);
    return { emoji: status === "DOPRECYZUJ" ? "❔" : "⚠️", label: STATUS_KEY_TITLE_PL[status] };
  }
  const report = reply.report;
  if (report?.status === "OK" && report.questionParts?.length) {
    const parts = report.questionParts;
    if (parts.every(part => part.status === "answered")) return { emoji: "✅", label: "Znaleziono odpowiedzi w źródłach" };
    if (parts.every(part => part.status === "insufficient")) return { emoji: "❌", label: VERDICT_LABEL_PL.BRAK_DOWODOW };
    if (parts.every(part => part.status === "unavailable")) return failed;
    return { emoji: "📋", label: "Pytania mają różne wyniki" };
  }
  if (view === "verdict" && report?.mainVerdict) {
    if (report.verdicts.some(claim => claim.verdict !== report.mainVerdict))
      return { emoji: "📋", label: "Twierdzenia mają różne oceny" };
    return { emoji: verdictEmoji[report.mainVerdict], label: VERDICT_LABEL_PL[report.mainVerdict] };
  }
  if (view === "answer") return report?.answer
    ? { emoji: "✅", label: "Znaleziono odpowiedź w źródłach" }
    : { emoji: "❌", label: "Brak odpowiedzi w źródłach" };
  return { emoji: "✅", label: "Fons odpowiedział" };
}
