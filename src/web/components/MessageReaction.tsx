import { Text } from "@astryxdesign/core/Text";
import type { ConversationReply } from "../../shared/contracts";
import { replyView, statusOf, STATUS_KEY_TITLE_PL, VERDICT_LABEL_PL } from "../lib/report";

const verdictEmoji = {
  POTWIERDZONE: "✅", FALSZYWE: "❌", WPROWADZAJACE: "⚠️", BRAK_DOWODOW: "❔", NIE_PODLEGA: "➖",
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
  if (view === "verdict" && report?.mainVerdict) {
    if (report.verdicts.some(claim => claim.verdict !== report.mainVerdict))
      return { emoji: "📋", label: "Twierdzenia mają różne oceny" };
    return { emoji: verdictEmoji[report.mainVerdict], label: VERDICT_LABEL_PL[report.mainVerdict] };
  }
  if (view === "answer" && !report?.answer && !report?.questionParts?.length)
    return { emoji: "❔", label: "Brak odpowiedzi w źródłach" };
  return { emoji: "✅", label: "Fons odpowiedział" };
}

export const reactionStyles = `
  .fons-reaction-anchor { position: relative; margin-block-start: var(--spacing-3); }
  .fons-reaction {
    position: absolute; z-index: 1; inset-inline-start: 0; inset-block-start: 0;
    transform: translate(-34%, -62%); display: grid; place-items: center;
    inline-size: var(--spacing-8); block-size: var(--spacing-8); border-radius: 50%;
    background: var(--color-background-muted); box-shadow: 0 0 0 var(--spacing-0-5) var(--color-background-surface);
    line-height: 1; cursor: default;
  }
  .fons-reaction::before, .fons-reaction::after {
    content: ""; position: absolute; border-radius: 50%; background: inherit;
    inline-size: var(--spacing-2); block-size: var(--spacing-2); left: 0; bottom: 0;
  }
  .fons-reaction::after { inline-size: var(--spacing-1); block-size: var(--spacing-1); left: -12%; bottom: -12%; }
  @media (prefers-reduced-motion: no-preference) {
    .fons-reaction-glyph { animation: fons-reaction-pop 300ms cubic-bezier(.2,.8,.3,1) both; }
  }
  @keyframes fons-reaction-pop {
    from { transform: scale(.55); opacity: 0; }
    65% { transform: scale(1.12); }
    to { transform: scale(1); opacity: 1; }
  }
`;

export function MessageReaction({ reaction }: { reaction?: Reaction }) {
  if (!reaction) return null;
  return <Text className="fons-reaction" role="img" aria-label={reaction.label}>
    <Text key={reaction.emoji} className="fons-reaction-glyph" aria-hidden>{reaction.emoji}</Text>
  </Text>;
}
