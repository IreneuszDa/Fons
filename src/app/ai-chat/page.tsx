// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx ai-chat template for the Fons conversation.
import { useEffect, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
import {
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { useLightbox } from "@astryxdesign/core/Lightbox";
import { Link } from "@astryxdesign/core/Link";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import type { ConversationReply } from "../../shared/contracts";
import type { VerificationStage } from "../../shared/chat";
import { AnswerReaction, MessageReaction, failed, reactionFor, reactionStyles, reading, type Reaction } from "../../web/components/MessageReaction";
import { QuickReplies, ReplyContent } from "../../web/components/ReplyContent";
import { StatusNotice } from "../../web/components/StatusNotice";
import { replyView } from "../../web/lib/report";
import { resultPathFor } from "../../web/lib/safeUrl";
import { MessageComposer, type ComposerDraftRef, type SubmitMessage } from "../../web/components/MessageComposer";
import { Token } from "@astryxdesign/core/Token";
import { Icon } from "@astryxdesign/core/Icon";
import { PaperClipIcon } from "@heroicons/react/24/outline";

export type ChatEntry =
  | { id: string; role: "user"; text: string; fileName?: string; imageSrc?: string; comparisonSrc?: string; sentAt?: number; attemptAt?: number }
  | { id: string; role: "assistant"; replyTo?: string; reply: ConversationReply }
  | { id: string; role: "error"; replyTo?: string; text: string; retry?: () => void };

export type PendingPhase = "responding" | "verifying" | "image" | VerificationStage;
export const progressLabels = {
  verifying: "Rozpoczynam sprawdzanie…",
  image: "Analizuję obraz…",
  fetching_video: "Odczytuję post…",
  analyzing_video: "Odczytuję obraz i wypowiedzi z filmu…",
  transcribing_audio: "Odczytuję nagranie głosowe…",
  searching: "Szukam źródeł…",
  assessing: "Czytam znalezione fragmenty…",
  checking_quotes: "Sprawdzam cytaty…",
} satisfies Record<Exclude<PendingPhase, "responding">, string>;

const replyAnchorId = (entryId: string | undefined) => `odpowiedz-${entryId ?? ""}`;

function SentImage({ src, name, reaction, attemptAt }: { src: string; name?: string; reaction?: Reaction; attemptAt?: number }) {
  const [failed, setFailed] = useState(false);
  const alt = name ? `Przesłane zdjęcie: ${name}` : "Przesłane zdjęcie";
  const lightbox = useLightbox({ media: { src, alt }, hasZoom: true });
  return <VStack className="fons-reaction-anchor" style={{ maxWidth: "min(82%, 20rem)" }}>
    <MessageReaction attemptAt={attemptAt} reaction={reaction} />
    {failed ? <Text type="supporting">{name ?? "Zdjęcie"} · podgląd niedostępny</Text> : (
    <img src={src} alt={alt} {...lightbox.triggerProps}
      aria-label={name ? `Powiększ zdjęcie ${name}` : "Powiększ zdjęcie"}
      onError={() => setFailed(true)}
      style={{
        display: "block", width: "auto", height: "auto", maxWidth: "100%",
        maxHeight: "min(42svh, 20rem)", borderRadius: "var(--radius-chat)", cursor: "zoom-in",
      }}
    />)}
    {lightbox.isOpen && lightbox.element}
  </VStack>;
}

export default function ChatConversation({
  entries,
  pending,
  pendingUserId,
  draftRef,
  onSubmit,
  onAction,
}: {
  entries: ChatEntry[];
  pending: PendingPhase | null;
  pendingUserId?: string;
  draftRef?: ComposerDraftRef;
  onSubmit: SubmitMessage;
  onAction: (id: string, label: string) => void;
}) {
  const isPending = pending !== null;
  const reactions = new Map<string, Reaction>();
  entries.forEach((entry, index) => {
    if (entry.role === "user") return;
    const previous = entries[index - 1];
    const target = entry.replyTo ?? (previous?.role === "user" ? previous.id : undefined);
    if (target) reactions.set(target, entry.role === "error" ? failed : reactionFor(entry.reply));
  });
  if (pending && pendingUserId) reactions.set(pendingUserId, reading);
  const lastAssistant = [...entries].reverse().find((e) => e.role === "assistant");
  const lastAssistantId = lastAssistant?.id;
  const lastView = lastAssistant?.role === "assistant" ? replyView(lastAssistant.reply) : null;
  const lastIsVerdict = lastView === "verdict" || lastView === "answer";

  // A verdict / answer card is long: show its top (the result itself) instead of the list's auto-scroll to the bottom.
  useEffect(() => {
    if (!lastIsVerdict) return;
    // The list's own stick-to-bottom (smooth) scroll can override one early jump, so retry a few times while the
    // result's top is still off-screen; once it is visible (or the user scrolled there) nothing more happens.
    const timers = [350, 900, 1600].map((ms) =>
      window.setTimeout(() => {
        const el = document.getElementById(replyAnchorId(lastAssistantId));
        if (!el) return;
        const top = el.getBoundingClientRect().top;
        if (top < 0 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: "start", behavior: "auto" });
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [lastAssistantId, lastIsVerdict]);
  return (
    <VStack width="100%" height="100%">
      <style>{reactionStyles}</style>
      <Layout
        height="fill"
        content={
          <LayoutContent padding={0}>
            <VisuallyHidden as="h1">Rozmowa — sprawdzanie informacji</VisuallyHidden>
            <VStack width="100%" height="100%">
              <ChatLayout
                density="spacious"
                composer={<MessageComposer onSubmit={onSubmit} isDisabled={isPending} draftRef={draftRef} />}>
                <ChatMessageList align="top" gap={6} isStreaming={isPending}>
                  {entries.map((e) => {
                    if (e.role === "user") {
                      return (
                        <ChatMessage key={e.id} sender="user" className={e.sentAt && Date.now() - e.sentAt < 300 ? "fons-message-sent" : undefined} name={<VisuallyHidden>Twoja wiadomość</VisuallyHidden>}>
                          {e.imageSrc && <SentImage src={e.imageSrc} name={e.comparisonSrc ? "Obraz 1" : e.fileName} attemptAt={e.attemptAt} reaction={reactions.get(e.id)} />}
                          {e.comparisonSrc && <SentImage src={e.comparisonSrc} name="Obraz 2" />}
                          {(e.text || (!e.imageSrc && e.fileName)) && <ChatMessageBubble className={e.imageSrc ? undefined : "fons-reaction-anchor"}>
                            {!e.imageSrc && <MessageReaction attemptAt={e.attemptAt} reaction={reactions.get(e.id)} />}
                            <VStack gap={1}>
                              {!e.imageSrc && e.fileName && <Token label={e.fileName} icon={<Icon icon={PaperClipIcon} size="sm" />} />}
                              {e.text && <Text type="large" weight="normal">{e.text}</Text>}
                            </VStack>
                          </ChatMessageBubble>}
                        </ChatMessage>
                      );
                    }
                    if (e.role === "error") {
                      return (
                        <ChatMessage key={e.id} sender="assistant" name={<VisuallyHidden>Fons</VisuallyHidden>}>
                          <ChatMessageBubble variant="ghost" width="100%">
                            <StatusNotice
                              title="Nie udało się wysłać wiadomości"
                              message={e.text}
                              actions={e.retry ? <Button label="Spróbuj ponownie" variant="primary" onClick={e.retry} isDisabled={isPending} /> : undefined}
                            />
                          </ChatMessageBubble>
                        </ChatMessage>
                      );
                    }
                    const reply = e.reply;
                    const showLink = !reply.report?.imageAnalysis?.only && (replyView(reply) === "text" || (reply.kind === "status" && (reply.report?.imageAnalysis || reply.report?.videoAnalysis)));
                    const resultPath = showLink ? resultPathFor(reply.report?.token, reply.resultUrl) : null;
                    return (
                      <ChatMessage key={e.id} sender="assistant" name={<VisuallyHidden>Fons</VisuallyHidden>}>
                        <ChatMessageBubble variant="ghost" width="100%">
                          <VStack gap={3}>
                            <AnswerReaction reaction={reactionFor(reply)} live={!!e.replyTo && e === entries.at(-1)} />
                            <ReplyContent reply={reply} anchorId={replyAnchorId(e.id)} animateText={!pending && e === entries.at(-1)} />
                            {resultPath ? <Link href={resultPath}>Pełny wynik ze źródłami</Link> : null}
                            {e.id === lastAssistantId ? <QuickReplies reply={reply} onAction={onAction} isDisabled={isPending} /> : null}
                          </VStack>
                        </ChatMessageBubble>
                      </ChatMessage>
                    );
                  })}
                  {pending === "responding" ? (
                    <HStack gap={1} paddingBlock={2} vAlign="center" role="img" aria-label="Fons pisze…">
                      {[0, 1, 2].map(index => (
                        <StatusDot key={index} variant="neutral" label="Pisanie" aria-hidden isPulsing
                          style={{ animationDelay: `calc(var(--duration-fast) * ${index})` }} />
                      ))}
                    </HStack>
                  ) : pending ? (
                    <ChatToolCalls calls={[{ name: progressLabels[pending], status: "running" }]} />
                  ) : null}
                </ChatMessageList>
              </ChatLayout>
            </VStack>
          </LayoutContent>
        }
      />
    </VStack>
  );
}
