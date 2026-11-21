import { Collapsible } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import type { SourceActivity, VerdictReport } from "../../shared/contracts";
import { countLabel, formatDate, formatDateTime, formatDuration, paragraphs } from "../lib/format";
import { SOURCE_TYPE_PL } from "../lib/report";
import { safeUrl } from "../lib/safeUrl";
import { SourceTitle } from "./Evidence";
import { GoogleFindings } from "./ImageFindings";

const PURPOSE_PL: Record<string, string> = {
  claims: "wydzielenie twierdzeń",
  assess: "ocena dowodów",
  verifier: "druga kontrola cytatów",
  smooth: "wygładzenie tekstu",
  router: "rozpoznanie prośby",
  vision: "odczyt obrazu",
  image_question: "odpowiedź na pytanie o obraz",
  image_caption: "odczyt podpisów ze źródeł",
  video_analysis: "odczyt obrazu i dźwięku z filmu",
  open_answer: "wybór cytatu-odpowiedzi",
};

function purposeLabel(purpose: string): string {
  if (purpose.endsWith(":failed")) {
    const base = purpose.slice(0, -":failed".length);
    return `${PURPOSE_PL[base] ?? base} · nieudana próba`;
  }
  return PURPOSE_PL[purpose] ?? purpose;
}

const fragments = (count: number) => countLabel(count, "fragment", "fragmenty", "fragmentów");

function branchOutcome(branch: SourceActivity["branches"][number]): string {
  switch (branch.status) {
    case "unavailable": return "Wyszukiwanie niedostępne";
    case "skipped": return "Pominięto";
    case "partial": return `Częściowe wyniki · ${fragments(branch.candidateCount)}`;
    case "completed": return fragments(branch.candidateCount);
  }
}

function SearchActivity({ activity }: { activity: SourceActivity }) {
  if (!activity.branches.length) return <Text as="p">W tym sprawdzeniu nie zarejestrowano przeszukania źródeł.</Text>;
  return (
    <VStack gap={2}>
      <List header={<Text weight="semibold">Gdzie szukałem</Text>} density="compact">
        {activity.branches.map(branch => (
          <ListItem key={branch.id} label={<Text>{branch.labelPl}</Text>}
            description={<Text type="supporting" color="secondary">{branchOutcome(branch)}</Text>} />
        ))}
      </List>
      <Text as="p">
        Po pominięciu powtórzeń znalazłem {fragments(activity.candidateCount)}.
        {" "}Model ocenił {fragments(activity.assessedCount)}.
      </Text>
      {activity.assessedCount > 0 && (
        <Text as="p" color="secondary">
          Przy wyborze fragmentów liczy się zgodność z tematem, w tym nazwy, daty i liczby. Cytat musi mieć pokrycie w źródle.
        </Text>
      )}
    </VStack>
  );
}

function CitedPassages({ report }: { report: VerdictReport }) {
  const evidence = [...(report.answer?.evidence ?? []), ...report.verdicts.flatMap(v => v.evidence)];
  const passages = new Map(evidence.map(item => [JSON.stringify([safeUrl(item.url) ?? item.recordId, item.quote]), item]));
  if (!passages.size) return null;
  return (
    <List header={<Text weight="semibold">Cytowane fragmenty</Text>} density="compact">
      {Array.from(passages, ([key, item]) => (
        <ListItem key={key} label={<SourceTitle item={item} />}
          description={
            <VStack gap={1}>
              <Text type="supporting" color="secondary">{item.publisher} · {SOURCE_TYPE_PL[item.sourceType]} · {formatDate(item.publishedAt, "brak daty publikacji")}</Text>
              <Text as="p">„{item.quote}”</Text>
            </VStack>
          } />
      ))}
    </List>
  );
}

function ImageActivity({ analysis }: { analysis: NonNullable<VerdictReport["imageAnalysis"]> }) {
  return (
    <VStack gap={2}>
      {analysis.images.map(({ provenance, search }, index) => (
        <VStack key={index} gap={1}>
          {analysis.images.length > 1 && <Text weight="semibold">Obraz {index + 1}</Text>}
          <Text as="p">{provenance.textPl}</Text>
          {search && (analysis.visual || !analysis.only
            ? <GoogleFindings search={search} expanded />
            : <Text as="p">{search.messagePl}</Text>)}
        </VStack>
      ))}
    </VStack>
  );
}

export function TransparencyBlock({ report }: { report: VerdictReport }) {
  const total = report.timingsMs["total"];
  return (
    <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<Text weight="semibold">Jak sprawdziłem</Text>}>
      <VStack gap={3} paddingBlock={2}>
        {report.cacheHit && <Text as="p">Odczytałem zapisany wynik. Poniżej widać przebieg wcześniejszego sprawdzenia.</Text>}
        {report.imageAnalysis && <ImageActivity analysis={report.imageAnalysis} />}
        {report.sourceActivity && <SearchActivity activity={report.sourceActivity} />}
        {!report.imageAnalysis?.only && <CitedPassages report={report} />}
        {paragraphs(report.transparencyPl).map((p, i) => <Text key={i} as="p">{p}</Text>)}
        {report.imageAnalysis?.visual && report.warnings.map((warning, i) => <Text key={i} as="p" color="secondary">{warning.textPl}</Text>)}
        {!report.imageAnalysis?.only && <Link href="/zrodla">Katalog źródeł i kryteria wyboru</Link>}
        <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<Text type="supporting">Szczegóły techniczne</Text>}>
          <VStack gap={2}>
            <MetadataList columns="single">
              {!!report.verdicts.length && !report.imageAnalysis?.only && (
                <MetadataListItem label="Sposób oceny">
                  {report.verdictMode === "rules" ? "Werdykt wyliczył kod według jawnych reguł" : "Model zaproponował werdykt, kod sprawdził warunki"}
                </MetadataListItem>
              )}
              <MetadataListItem label="Data raportu">{formatDateTime(report.createdAt)}</MetadataListItem>
              <MetadataListItem label="Wersja bazy źródeł">{report.corpusSnapshot}</MetadataListItem>
              <MetadataListItem label="Wersja programu">{report.pipelineVersion}</MetadataListItem>
              {typeof total === "number" && <MetadataListItem label="Czas sprawdzania">{formatDuration(total)}</MetadataListItem>}
              {!report.sourceActivity && report.unavailableBranches.length > 0 && (
                <MetadataListItem label="Niedostępne metody wyszukiwania">{report.unavailableBranches.join(", ")}</MetadataListItem>
              )}
            </MetadataList>
            {report.models.length > 0 && (
              <List header={<Text weight="semibold">Użyte modele</Text>} density="compact" listStyle="disc">
                {report.models.map((m, i) => <ListItem key={i} label={<Text>{m.provider} / {m.model} · {purposeLabel(m.purpose)}</Text>} />)}
              </List>
            )}
          </VStack>
        </Collapsible>
      </VStack>
    </Collapsible>
  );
}

