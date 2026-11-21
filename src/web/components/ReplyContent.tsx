import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useStreamingText } from "@astryxdesign/core/hooks";
import { useEffect, useState } from "react";
import type { ConversationReply } from "../../shared/contracts";
import { paragraphs } from "../lib/format";
import { replyView, STATUS_HINT_PL, STATUS_KEY_TITLE_PL, statusOf } from "../lib/report";
import { AnswerCard } from "./AnswerCard";
import { ImageFindings } from "./ImageFindings";
import { StatusNotice } from "./StatusNotice";
import { TransparencyBlock } from "./TransparencyBlock";
import { ReportWarnings, VerdictCard } from "./VerdictCard";
import { VideoFindings } from "./VideoFindings";

export function QuickReplies({
  reply,
  onAction,
  isDisabled,
}: {
  reply: ConversationReply;
  onAction: (id: string, label: string) => void;
  isDisabled?: boolean;
}) {
  if (reply.quickReplies.length === 0) return null;
  return (
    <HStack gap={2} wrap="wrap">
      {reply.quickReplies.map((q) => (
        <Button key={q.id} label={q.labelPl} variant="secondary" isDisabled={isDisabled} onClick={() => onAction(q.id, q.labelPl)} />
      ))}
    </HStack>
  );
}

/** Assistant reply body: verdict card, answer card, status notice (never verdict styling) or plain text. */
export function ReplyContent({ reply, anchorId, animateText = false }: { reply: ConversationReply; anchorId?: string; animateText?: boolean }) {
  const analysis = reply.report?.imageAnalysis;
  if (analysis) return (
    <VStack gap={3}>
      <ImageFindings analysis={analysis} />
      {reply.report && (analysis.only || (reply.kind === "status" && reply.report.status === "DOPRECYZUJ")) &&
        <TransparencyBlock report={reply.report} />}
      {!analysis.only && (reply.kind === "status" && reply.report?.status === "DOPRECYZUJ"
        ? <Text as="p">{reply.report.statusMessagePl || reply.textPl}</Text>
        : <ReplyBody reply={reply} anchorId={anchorId} />)}
      {reply.kind === "status" && reply.report && <ReportWarnings warnings={reply.report.warnings} />}
    </VStack>
  );
  if (animateText && reply.kind === "help" && !reply.report && reply.textPl.length <= 600) {
    return <TypingReply text={reply.textPl} />;
  }
  return <ReplyBody reply={reply} anchorId={anchorId} />;
}

function TypingReply({ text }: { text: string }) {
  const [finished, setFinished] = useState(false);
  const displayed = useStreamingText(text, !finished);
  useEffect(() => {
    if (displayed === text) setFinished(true);
  }, [displayed, text]);

  if (displayed === text) return <ReplyParagraphs text={text} />;
  return (
    <>
      <VisuallyHidden>{text}</VisuallyHidden>
      <VStack aria-hidden="true">
        <ReplyParagraphs text={displayed} />
      </VStack>
    </>
  );
}

function ReplyBody({ reply, anchorId }: { reply: ConversationReply; anchorId?: string }) {
  const view = replyView(reply);
  if (view === "answer" && reply.report) return <AnswerCard report={reply.report} anchorId={anchorId} inChat />;
  if (view === "verdict" && reply.report) return <VerdictCard report={reply.report} anchorId={anchorId} />;
  if (view === "status") {
    const key = statusOf(reply);
    const message = reply.report?.statusMessagePl || reply.textPl;
    const hint = key === "RATE_LIMITED" || key === "GENERIC" ? undefined : STATUS_HINT_PL[key];
    return (
      <VStack gap={3}>
        <StatusNotice title={STATUS_KEY_TITLE_PL[key]} message={message} hint={reply.report?.videoAnalysis ? undefined : hint} />
        {reply.report?.videoAnalysis && (
          <>
            <VideoFindings analysis={reply.report.videoAnalysis} />
            <ReportWarnings warnings={reply.report.warnings} />
          </>
        )}
        {reply.report && <TransparencyBlock report={reply.report} />}
      </VStack>
    );
  }
  return <ReplyParagraphs text={reply.textPl} />;
}

function ReplyParagraphs({ text }: { text: string }) {
  return (
    <VStack gap={2}>
      {paragraphs(text).map((p, i) => (
        <Text key={i} as="p">
          {p}
        </Text>
      ))}
    </VStack>
  );
}
