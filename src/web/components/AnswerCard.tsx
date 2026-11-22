import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowTopRightOnSquareIcon, BookOpenIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { EvidenceItem, VerdictReport } from "../../shared/contracts";
import { formatDate, hostOf, paragraphs } from "../lib/format";
import { hasArchivalWarning, SOURCE_TYPE_PL, WARNING_TITLE_PL } from "../lib/report";
import { resultPathFor, safeUrl } from "../lib/safeUrl";
import { EvidencePassage, SourceTitle } from "./Evidence";
import { ReportWarnings } from "./VerdictCard";
import { TransparencyBlock } from "./TransparencyBlock";

export const ANSWER_TITLE_PL = "Odpowiedź ze źródła";
export const NO_ANSWER_TITLE_PL = "Nie znalazłem odpowiedzi w źródłach";
export const ANSWER_DISCLAIMER_PL =
  "Przy każdym fragmencie znajdziesz publikację i datę źródła.";

function ResultLink({ token }: { token: string }) {
  const path = resultPathFor(token);
  if (!path) return null;
  return (
    <HStack gap={1} vAlign="center">
      <Link href={path} weight="semibold">
        Pełny wynik
      </Link>
      <Icon icon={ArrowTopRightOnSquareIcon} size="xsm" color="accent" />
    </HStack>
  );
}

/** Where the quote comes from: title (link only for http/https), publisher, both dates and the address. */
export function AnswerSource({ item }: { item: EvidenceItem }) {
  const href = safeUrl(item.url);
  const host = hostOf(item.url);
  return (
    <VStack gap={3}>
      <EvidencePassage item={item} />
      <MetadataList columns="single">
        <MetadataListItem label="Tytuł">
          <SourceTitle item={item} />
        </MetadataListItem>
        <MetadataListItem label="Wydawca">{`${item.publisher} · ${SOURCE_TYPE_PL[item.sourceType]} · poziom ${item.level}`}</MetadataListItem>
        <MetadataListItem label="Data publikacji">{formatDate(item.publishedAt)}</MetadataListItem>
        <MetadataListItem label="Data pobrania">{formatDate(item.fetchedAt)}</MetadataListItem>
        {href ? (
          <MetadataListItem label="Adres">
            <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)" rel="noopener noreferrer nofollow">
              {host || href}
            </Link>
          </MetadataListItem>
        ) : null}
      </MetadataList>
    </VStack>
  );
}

/**
 * Card for an open question (report.inputMode "question_open"): the answer sentence assembled by code from a verified
 * quote, the quote itself and its source. Without report.answer it says plainly that no source answered the question.
 */
export function AnswerCard({ report, showResultLink = true, anchorId, inChat = false }: { report: VerdictReport; showResultLink?: boolean; anchorId?: string; inChat?: boolean }) {
  const answer = report.answer;
  const question = answer?.questionPl || report.inputEchoMasked;
  const archivalOnlyInStrength = hasArchivalWarning(report) && !report.warnings.some((w) => w.kind === "archival_material");
  const [first, ...more] = answer?.evidence ?? [];
  const warnings = (
    <>
      <ReportWarnings warnings={report.warnings} />
      {archivalOnlyInStrength ? (
        <Banner
          status="warning"
          title={WARNING_TITLE_PL.archival_material}
          description="Źródło jest starsze. Sprawdź, czy informacja jest nadal aktualna."
          collapsible={false}
        />
      ) : null}
    </>
  );

  if (inChat && !answer) {
    return (
      <VStack gap={3}>
        <Text as="p" id={anchorId}>
          {NO_ANSWER_TITLE_PL}. Masz link albo fragment wiadomości, od której zaczęło się pytanie? Mogę sprawdzić go osobno.
        </Text>
        <TransparencyBlock report={report} />
        {warnings}
        {showResultLink ? <ResultLink token={report.token} /> : null}
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <Card variant={answer ? "teal" : "blue"} padding={4}>
        <VStack gap={2}>
          <Text type="supporting" color="secondary" id={anchorId}>
            {answer ? "Odpowiedź na pytanie" : "Wynik wyszukiwania"}
          </Text>
          <HStack gap={2} vAlign="center">
            <Icon icon={answer ? BookOpenIcon : MagnifyingGlassIcon} size="lg" color="accent" />
            <Heading level={3}>{answer ? ANSWER_TITLE_PL : NO_ANSWER_TITLE_PL}</Heading>
          </HStack>
          {question ? (
            <Text as="p" color="secondary">
              Pytanie: {question}
            </Text>
          ) : null}
          {answer ? (
            <Text as="p" weight="medium">
              {answer.answerPl}
            </Text>
          ) : (
            paragraphs(report.summaryPl || "W źródłach z katalogu nie ma fragmentu, który odpowiada na to pytanie.").map((p, i) => (
              <Text key={i} as="p">
                {p}
              </Text>
            ))
          )}
        </VStack>
      </Card>
      <TransparencyBlock report={report} />
      {warnings}
      {first ? (
        <VStack gap={3}>
          <Heading level={4}>Źródło odpowiedzi</Heading>
          <AnswerSource item={first} />
          {more.map((item) => (
            <VStack key={item.recordId} gap={3}>
              <Divider />
              <AnswerSource item={item} />
            </VStack>
          ))}
          <Text type="supporting" color="secondary">
            {ANSWER_DISCLAIMER_PL}
          </Text>
        </VStack>
      ) : (
        <Text as="p" color="secondary">
          Nie zgaduję odpowiedzi. Spróbuj zapytać inaczej albo wklej konkretną informację do sprawdzenia.
        </Text>
      )}
      {showResultLink ? <ResultLink token={report.token} /> : null}
    </VStack>
  );
}
