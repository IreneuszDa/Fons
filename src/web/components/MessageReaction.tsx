import { useEffect, useState } from "react";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ConversationReply } from "../../shared/contracts";
import { replyView, statusOf, STATUS_KEY_TITLE_PL, VERDICT_LABEL_PL } from "../lib/report";

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

export const reactionStyles = `
  .fons-reaction-anchor { position: relative; margin-block-start: var(--spacing-3); }
  .fons-reaction {
    position: absolute; z-index: 1; inset-inline-start: 0; inset-block-start: 0;
    translate: -34% -62%; display: grid; place-items: center;
    inline-size: var(--spacing-8); block-size: var(--spacing-8); border-radius: 50%;
    background: var(--color-background-muted); box-shadow: 0 0 0 var(--spacing-0-5) var(--color-background-surface);
    line-height: 1; cursor: default;
  }
  .fons-reaction::before, .fons-reaction::after {
    content: ""; position: absolute; border-radius: 50%; background: inherit;
    inline-size: var(--spacing-2); block-size: var(--spacing-2); left: 0; bottom: 0;
  }
  .fons-reaction::after { inline-size: var(--spacing-1); block-size: var(--spacing-1); left: -12%; bottom: -12%; }
  .fons-answer-reaction {
    width: fit-content;
  }
  .fons-answer-reaction .fons-reaction {
    position: relative; inset: auto; translate: none; flex-shrink: 0;
  }
  .fons-reaction-glyph { grid-area: 1 / 1; }
  .fons-reaction-out {
    animation: fons-glyph-out 145ms cubic-bezier(.32,0,.67,0) both;
  }
  .fons-reaction-in {
    animation: fons-glyph-in 255ms cubic-bezier(.23,1,.32,1) 85ms both;
  }
  @keyframes fons-glyph-out {
    to { opacity: 0; transform: translateY(12%) scale(.72); }
  }
  @keyframes fons-glyph-in {
    from { opacity: 0; transform: translateY(14%) scale(.84); }
    56% { opacity: 1; transform: scale(1.12); }
    80% { transform: scale(.98); }
    to { transform: none; }
  }
  .fons-message-sent { transform-origin: right bottom; animation: fons-send 240ms cubic-bezier(.23,1,.32,1) both; }
  .fons-reaction-live, .fons-answer-reaction-live .fons-reaction {
    transform-origin: 20% 92%;
    animation: fons-tapback 300ms cubic-bezier(.22,.75,.3,1) both;
  }
  .fons-answer-reaction-live .fons-reaction { animation-delay: 440ms; }
  .fons-answer-reaction-live .fons-reaction-caption { animation: fons-fade 150ms ease-out 520ms both; }
  @keyframes fons-send {
    from { opacity: 0; transform: translateY(var(--spacing-4)) scale(.95); }
    to { opacity: 1; transform: none; }
  }
  @keyframes fons-tapback {
    from { opacity: 0; transform: scale(.22); }
    60% { opacity: 1; transform: scale(1.08); }
    to { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fons-message-sent, .fons-reaction-live, .fons-answer-reaction-live .fons-reaction, .fons-reaction-in {
      animation-name: fons-fade; animation-duration: 150ms;
    }
    .fons-reaction-out { animation-name: fons-fade-out; }
  }
  @keyframes fons-fade-out { to { opacity: 0; } }
  @keyframes fons-fade { from { opacity: 0; } to { opacity: 1; } }
`;

const EYES_DELAY = 440;
const EYES_HOLD = 720;
const RESULT_DELAY = 160;

function ReactionMark({ reaction, animate = false, replacingEyes = false }: { reaction?: Reaction; animate?: boolean; replacingEyes?: boolean }) {
  if (!reaction) return null;
  return <Text className={animate ? "fons-reaction fons-reaction-live" : "fons-reaction"}
    role="img" aria-label={reaction.label}>
    {replacingEyes && <Text className="fons-reaction-glyph fons-reaction-out" aria-hidden>{reading.emoji}</Text>}
    <Text key={reaction.emoji} className={replacingEyes ? "fons-reaction-glyph fons-reaction-in" : "fons-reaction-glyph"} aria-hidden>{reaction.emoji}</Text>
  </Text>;
}

function LiveReaction({ startedAt, reaction }: { startedAt: number; reaction?: Reaction }) {
  const [eyesAt] = useState(() => startedAt + EYES_DELAY);
  const [now, setNow] = useState(Date.now);
  const [resultAt, setResultAt] = useState<number | null>(() =>
    reaction && reaction !== reading ? eyesAt + EYES_HOLD : null);
  const hasResult = !!reaction && reaction !== reading;

  useEffect(() => {
    if (hasResult) setResultAt(previous => previous ?? Math.max(eyesAt + EYES_HOLD, Date.now() + RESULT_DELAY));
  }, [hasResult, eyesAt]);

  const next = now < eyesAt ? eyesAt : resultAt !== null && now < resultAt ? resultAt : null;
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(() => setNow(Math.max(next, Date.now())), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);

  if (now < eyesAt) return null;
  const showingResult = resultAt !== null && now >= resultAt;
  const shown = showingResult ? reaction : reading;
  const enteredAt = showingResult ? resultAt : eyesAt;
  const isFresh = now - enteredAt < 300;
  return <ReactionMark reaction={shown} animate={!showingResult && isFresh} replacingEyes={showingResult && isFresh} />;
}

export function MessageReaction({ reaction, attemptAt }: { reaction?: Reaction; attemptAt?: number }) {
  return attemptAt === undefined ? <ReactionMark reaction={reaction} />
    : <LiveReaction key={attemptAt} startedAt={attemptAt} reaction={reaction} />;
}


export function AnswerReaction({ reaction, live }: { reaction: Reaction; live: boolean }) {
  return <HStack className={live ? "fons-answer-reaction fons-answer-reaction-live" : "fons-answer-reaction"}
    gap={1.5} paddingInline={2} paddingBlock={1} vAlign="center">
    <Text className="fons-reaction" aria-hidden>{reaction.emoji}</Text>
    <Text className="fons-reaction-caption" type="supporting">{reaction.label}</Text>
  </HStack>;
}
