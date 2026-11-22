import { Banner } from "@astryxdesign/core/Banner";
import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { ClaimVerdict, ReportWarning, Verdict, VerdictReport } from "../../shared/contracts";
import { mediaClaimSubject } from "../../shared/attachments";
import { paragraphs } from "../lib/format";
import {
  claimRows,
  VERDICT_LABEL_PL,
  VERDICT_MEANING_PL,
  VERDICT_TONE,
  WARNING_SEVERITY,
  WARNING_TITLE_PL,
} from "../lib/report";
import { resultPathFor, safeUrl } from "../lib/safeUrl";
import { ConflictingSources, EvidenceGroups } from "./Evidence";
import { TransparencyBlock } from "./TransparencyBlock";
import { StrengthCard } from "./StrengthCard";
import { VERDICT_ICON } from "./verdictIcons";
import { VideoClaimOrigin, VideoFindings } from "./VideoFindings";

/** Icon + text label + colour together (WCAG 1.4.1: colour is never the only signal). */
export function VerdictLabel({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" }) {
  return (
    <HStack gap={1.5} vAlign="center">
      <Icon icon={VERDICT_ICON[verdict]} size={size} color={VERDICT_TONE[verdict]} />
      <Text weight="bold">{VERDICT_LABEL_PL[verdict]}</Text>
    </HStack>
  );
}

export function ReportWarnings({ warnings }: { warnings: ReportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <VStack gap={2}>
      {warnings.map((w, i) => (
        <Banner key={`${w.kind}-${i}`} status={WARNING_SEVERITY[w.kind]} title={WARNING_TITLE_PL[w.kind]} description={w.textPl} collapsible={false}>
          {w.links?.length ? (
            <VStack gap={1}>
              {w.links.map(({ title, url }) => {
                const href = safeUrl(url);
                return href ? (
                  <Link key={url} href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)" rel="noopener noreferrer nofollow">
                    {title}
                  </Link>
                ) : null;
              })}
            </VStack>
          ) : null}
        </Banner>
      ))}
    </VStack>
  );
}

function ClaimSection({ index, total, text, isMain, verdict, origin }: {
  index: number;
  total: number;
  text: string;
  isMain: boolean;
  verdict: ClaimVerdict;
  origin?: NonNullable<VerdictReport["videoAnalysis"]>["claimOrigins"][number];
}) {
  const title = total > 1 ? `Twierdzenie ${index + 1}${isMain ? " (główne)" : ""}` : "Sprawdzone twierdzenie";
  return (
    <VStack gap={3}>
      <Heading level={4}>{title}</Heading>
      {origin && <VideoClaimOrigin origin={origin} />}
      {text ? <Blockquote>{text}</Blockquote> : null}
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text color="secondary">Wynik:</Text>
        <VerdictLabel verdict={verdict.verdict} size="sm" />
      </HStack>
      <ClaimDetails verdict={verdict} />
    </VStack>
  );
}

export function ClaimDetails({ verdict }: { verdict: ClaimVerdict }) {
  return (
    <VStack gap={3}>
      <Text as="p">{verdict.reasonPl}</Text>
      {verdict.missingContext ? (
        <Text as="p">
          <Text weight="semibold">Brakujący kontekst: </Text>
          {verdict.missingContext}
        </Text>
      ) : null}
      {verdict.triedPl ? (
        <Text as="p">
          <Text weight="semibold">Co próbowaliśmy ustalić: </Text>
          {verdict.triedPl}
        </Text>
      ) : null}
      <ConflictingSources verdict={verdict} />
      {verdict.parts?.length && verdict.parts.every(part => part.evidence !== undefined) ? verdict.parts.map((part, i) => (
        <VStack key={i} gap={2}>
          <Heading level={5}>{part.text}</Heading>
          <VerdictLabel verdict={part.verdict} size="sm" />
          {part.reasonPl && <Text as="p">{part.reasonPl}</Text>}
          {part.evidence!.length > 0 && <EvidenceGroups evidence={part.evidence!} headingLevel={6} />}
        </VStack>
      )) : verdict.evidence.length > 0 ? (
        <EvidenceGroups evidence={verdict.evidence} />
      ) : verdict.verdict !== "NIE_PODLEGA" ? (
        <Text as="p" color="secondary">
          Nie znaleźliśmy pasujących fragmentów w źródłach z katalogu.
        </Text>
      ) : null}
      <StrengthCard strength={verdict.strength} />
    </VStack>
  );
}

/** Full verdict card rendered from a VerdictReport with status OK. */
export function VerdictCard({ report, showResultLink = true, anchorId }: { report: VerdictReport; showResultLink?: boolean; anchorId?: string }) {
  const main = report.mainVerdict;
  const rows = claimRows(report);
  const mainStatement = rows.find(row => row.isMain)?.text;
  const heading = report.videoAnalysis ? `Ocena głównego twierdzenia z ${mediaClaimSubject(report.videoAnalysis)}`
    : rows.length > 1 ? "Ocena głównego twierdzenia" : "Wynik sprawdzenia";
  const resultPath = showResultLink ? resultPathFor(report.token) : null;
  if (!main) return null;
  return (
    <VStack gap={4}>
      <Card variant={VERDICT_TONE[main]} padding={4}>
        <VStack gap={2}>
          <Text type="supporting" color="secondary" id={anchorId}>
            {heading}
          </Text>
          <HStack gap={2} vAlign="center">
            <Icon icon={VERDICT_ICON[main]} size="lg" color={VERDICT_TONE[main]} />
            <Heading level={3}>{VERDICT_LABEL_PL[main]}</Heading>
          </HStack>
          {(report.videoAnalysis || rows.length > 1) && mainStatement && <Blockquote>{mainStatement}</Blockquote>}
          <Text as="p" weight="medium">
            {VERDICT_MEANING_PL[main]}
          </Text>
          {paragraphs(report.summaryPl).map((p, i) => (
            <Text key={i} as="p">
              {p}
            </Text>
          ))}
        </VStack>
      </Card>
      {report.videoAnalysis && <VideoFindings analysis={report.videoAnalysis} />}
      <TransparencyBlock report={report} />
      <ReportWarnings warnings={report.warnings} />
      {rows.map((r, i) => (
        <VStack key={r.claimId} gap={4}>
          {i > 0 ? <Divider /> : null}
          <ClaimSection index={i} total={rows.length} text={r.text} isMain={r.isMain} verdict={r.verdict}
            origin={report.videoAnalysis?.claimOrigins.find(origin => origin.claimId === r.claimId)} />
        </VStack>
      ))}
      {resultPath ? (
        <HStack gap={1} vAlign="center">
          <Link href={resultPath} weight="semibold">
            Pełny wynik
          </Link>
          <Icon icon={ArrowTopRightOnSquareIcon} size="xsm" color="accent" />
        </HStack>
      ) : null}
    </VStack>
  );
}
