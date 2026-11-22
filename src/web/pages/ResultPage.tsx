// Scaffolded from the Astryx `blank` page template (one heading slot, one content region).
import { useEffect, useState } from "react";

import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { DocumentMagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { VerdictReport } from "../../shared/contracts";
import { ApiError, fetchReport, NETWORK_ERROR_PL } from "../api";
import { AnswerCard } from "../components/AnswerCard";
import { ArticleOrigin } from "../components/Evidence";
import { QuestionBreakdown } from "../components/QuestionBreakdown";
import { ImageFindings } from "../components/ImageFindings";
import { StatusNotice } from "../components/StatusNotice";
import { TransparencyBlock } from "../components/TransparencyBlock";
import { ReportWarnings, VerdictCard } from "../components/VerdictCard";
import { VideoFindings } from "../components/VideoFindings";
import { formatDateTime } from "../lib/format";
import { isOpenQuestion, STATUS_HINT_PL, STATUS_TITLE_PL } from "../lib/report";

type State = { kind: "loading" } | { kind: "notfound" } | { kind: "error"; message: string } | { kind: "ok"; report: VerdictReport };

export default function ResultPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    fetchReport(token)
      .then((report) => alive && setState(report ? { kind: "ok", report } : { kind: "notfound" }))
      .catch((err: unknown) => alive && setState({ kind: "error", message: err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL }));
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  return (
    <Layout
      height="auto"
      contentWidth={720}
      padding={6}
      content={
        <LayoutContent isScrollable={false}>
          <VStack gap={6}>
            <Heading level={1}>{state.kind === "ok" && state.report.inputMode === "transcription" ? "Transkrypcja nagrania" : "Wynik sprawdzenia"}</Heading>
            {state.kind === "loading" ? <Spinner size="lg" label="Wczytuję wynik…" aria-label="Wczytuję wynik" /> : null}
            {state.kind === "notfound" ? (
              <EmptyState
                headingLevel={2}
                icon={<Icon icon={DocumentMagnifyingGlassIcon} size="lg" />}
                title="Nie znaleźliśmy tego wyniku"
                description="Link mógł wygasnąć albo zawiera błąd. Wyniki przechowujemy tylko przez ograniczony czas. Możesz sprawdzić informację jeszcze raz."
                actions={<Button label="Sprawdź informację" variant="primary" href="/" />}
              />
            ) : null}
            {state.kind === "error" ? (
              <StatusNotice
                headingLevel={2}
                title="Nie udało się wczytać wyniku"
                message={state.message}
                actions={<Button label="Spróbuj ponownie" variant="primary" onClick={() => setAttempt((a) => a + 1)} />}
              />
            ) : null}
            {state.kind === "ok" ? <ReportView report={state.report} /> : null}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function ReportView({ report }: { report: VerdictReport }) {
  if (report.inputMode === "transcription" || report.videoAnalysis?.status === "metadata_only") return (
    <VStack gap={3}>
      <Text as="p">{report.summaryPl}</Text>
      <Text as="p" type="supporting" color="secondary">{report.transparencyPl}</Text>
      <ReportWarnings warnings={report.warnings} />
      <Button label="Wróć do czatu" variant="secondary" href="/" />
    </VStack>
  );
  return (
    <VStack gap={6}>
      <VStack gap={2}>
        <Text color="secondary">
          Sprawdzono {formatDateTime(report.createdAt)}. {isOpenQuestion(report) ? "Pytanie" : "Sprawdzana treść"} (dane osobowe ukryte):
        </Text>
        <Blockquote>{report.inputEchoMasked}</Blockquote>
      </VStack>
      {report.article && <ArticleOrigin article={report.article} />}
      {report.imageAnalysis?.only && <ImageFindings analysis={report.imageAnalysis} summaryPl={report.summaryPl} expanded />}
      {report.imageAnalysis?.only && !report.imageAnalysis.visual && report.status !== "OK" && <ReportWarnings warnings={report.warnings} />}
      {report.questionParts?.length ? (
        <>
          <QuestionBreakdown parts={report.questionParts} />
          <ReportWarnings warnings={report.warnings} />
          <TransparencyBlock report={report} />
        </>
      ) : report.imageAnalysis?.only ? <TransparencyBlock report={report} /> : report.status === "OK" && isOpenQuestion(report) ? (
        <AnswerCard report={report} showResultLink={false} />
      ) : report.status === "OK" && report.mainVerdict ? (
        <VerdictCard report={report} showResultLink={false} />
      ) : (
        <>
          <StatusNotice
            headingLevel={2}
            title={STATUS_TITLE_PL[report.status]}
            message={report.statusMessagePl || report.summaryPl}
            hint={report.status === "OK" || report.videoAnalysis ? undefined : STATUS_HINT_PL[report.status]}
          />
          {report.videoAnalysis && (
            <VideoFindings analysis={report.videoAnalysis} pendingClaims={report.claims} />
          )}
          <ReportWarnings warnings={report.warnings} />
          <TransparencyBlock report={report} />
        </>
      )}
      <Button label="Sprawdź kolejną informację" variant="secondary" href="/" />
    </VStack>
  );
}
