import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { BookOpenIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useStreamingText } from "@astryxdesign/core/hooks";
import { useEffect, useState } from "react";
import type { ConversationReply, VerdictReport } from "../../shared/contracts";
import { citizenAnswerPl } from "../../shared/citizen-answer";
import { hostOf, paragraphs } from "../lib/format";
import { claimRows, replyView, STATUS_HINT_PL, STATUS_KEY_TITLE_PL, statusOf } from "../lib/report";
import { resultPathFor, safeUrl } from "../lib/safeUrl";
import { AnswerCard } from "./AnswerCard";
import { ClaimBreakdown } from "./ClaimBreakdown";
import { ArticleOrigin } from "./Evidence";
import { QuestionBreakdown } from "./QuestionBreakdown";
import { ImageFindings } from "./ImageFindings";
import { StatusNotice } from "./StatusNotice";
import { VerdictCard } from "./VerdictCard";
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
  if (reply.report?.status === "OK" || reply.kind === "image_analysis" || reply.quickReplies.length === 0) return null;
  return (
    <HStack gap={2} wrap="wrap">
      {reply.quickReplies.map((q) => {
        const icon = q.id === "sources" ? BookOpenIcon : q.id === "why" ? MagnifyingGlassIcon : undefined;
        return <Button key={q.id} label={q.labelPl} variant={icon ? "ghost" : "secondary"} size="sm"
          icon={icon && <Icon icon={icon} size="sm" />} isDisabled={isDisabled} onClick={() => onAction(q.id, q.labelPl)} />;
      })}
    </HStack>
  );
}

/** Successful text checks use a concise answer. Media and technical statuses retain their specialized views. */
export function ReplyContent({ reply, anchorId, animateText = false }: { reply: ConversationReply; anchorId?: string; animateText?: boolean }) {
  const report = reply.report;
  const analysis = report?.imageAnalysis;
  if (analysis && report) return (
    <VStack gap={3}>
      {analysis.only && <ImageFindings analysis={analysis} summaryPl={report.summaryPl} />}
      {!analysis.only && (reply.kind === "status" && report.status === "DOPRECYZUJ"
        ? <Text as="p">{report.statusMessagePl || reply.textPl}</Text>
        : <ReplyBody reply={reply} anchorId={anchorId} />)}
      {analysis.only && <FullResultLink report={report} resultUrl={reply.resultUrl} />}
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

/** Stored conversations may predate the shortAnswer field. */
function reportSummary(report: VerdictReport): NonNullable<ConversationReply["shortAnswer"]> {
  return {
    bodyPl: citizenAnswerPl(report),
    sources: report.answer?.evidence ?? claimRows(report)[0]?.verdict.evidence ?? [],
  };
}

function ReplyBody({ reply, anchorId }: { reply: ConversationReply; anchorId?: string }) {
  const report = reply.report;
  const view = replyView(reply);
  const plainReport = (view === "answer" || view === "verdict") && !report?.imageAnalysis && !report?.videoAnalysis;
  if (report?.status === "OK" && (reply.shortAnswer || plainReport)) {
    const short = reply.shortAnswer ?? reportSummary(report);
    const publications = new Map<string, (typeof short.sources)[number]>();
    for (const source of short.sources) {
      const href = safeUrl(source.url);
      if (href && !publications.has(href)) publications.set(href, source);
    }
    const showClaims = view === "verdict" && report.verdicts.length > 1;
    const parts = report.questionParts;
    const answerAnchor = report.article ? undefined : anchorId;
    return (
      <VStack gap={2}>
        {report.article && <ArticleOrigin article={report.article} anchorId={anchorId} />}
        {parts?.length ? <QuestionBreakdown parts={parts} anchorId={answerAnchor} /> :
          showClaims ? <ClaimBreakdown report={report} anchorId={answerAnchor} /> :
          paragraphs(short.bodyPl).map((p, i) => <Text key={i} as="p" type="large" weight="normal" id={i === 0 ? answerAnchor : undefined}>{p}</Text>)}
        {!showClaims && !parts?.length && Array.from(publications).slice(0, 1).map(([href, source]) => (
          <Link key={href} href={href} label={`Źródło · ${source.title} (otwiera się w nowej karcie)`} isExternalLink newTabLabel="(otwiera się w nowej karcie)" rel="noopener noreferrer nofollow">
            Źródło · {hostOf(href).replace(/^www\./u, "")}
          </Link>
        ))}
        <FullResultLink report={report} resultUrl={reply.resultUrl} />
      </VStack>
    );
  }
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
          <VideoFindings analysis={reply.report.videoAnalysis} pendingClaims={reply.report.claims} />
        )}
      </VStack>
    );
  }
  return <ReplyParagraphs text={reply.textPl} />;
}

function FullResultLink({ report, resultUrl }: { report: VerdictReport; resultUrl?: string }) {
  const href = resultPathFor(report.token, resultUrl);
  return href && <Link href={href} type="supporting">Pełny wynik ze źródłami</Link>;
}

function ReplyParagraphs({ text }: { text: string }) {
  return (
    <VStack gap={2}>
      {paragraphs(text).map((p, i) => (
        <Text key={i} as="p" type="large" weight="normal">
          {p}
        </Text>
      ))}
    </VStack>
  );
}
