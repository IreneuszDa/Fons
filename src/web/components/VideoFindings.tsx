import { Collapsible } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { VerdictReport } from "../../shared/contracts";

type VideoAnalysis = NonNullable<VerdictReport["videoAnalysis"]>;
type ClaimOrigin = VideoAnalysis["claimOrigins"][number];

const originLabels: Record<ClaimOrigin["source"], string> = {
  speech: "Wypowiedź",
  onscreen: "Tekst na ekranie",
  visual: "Obraz",
  caption: "Opis posta",
};

function timestamp(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VideoClaimOrigin({ origin }: { origin: ClaimOrigin }) {
  return (
    <Text type="supporting" color="secondary" hasTabularNumbers>
      {originLabels[origin.source]}{origin.seconds !== null && ` · ${timestamp(origin.seconds)}`}
    </Text>
  );
}

function TimedPassages({ title, entries, empty }: {
  title: string;
  entries: VideoAnalysis["transcript"];
  empty: string;
}) {
  if (!entries.length) return <Text as="p" type="supporting" color="secondary">{empty}</Text>;
  return (
    <Collapsible trigger={title} chevronPosition="start" defaultIsOpen={false}>
      <List edge="flush" density="compact" hasDividers>
        {entries.map(({ seconds, text }, index) => (
          <ListItem
            key={index}
            align="first-line"
            startContent={<Text type="supporting" color="secondary" hasTabularNumbers>{timestamp(seconds)}</Text>}
            label={<Text wordBreak="break-word">{text}</Text>}
          />
        ))}
      </List>
    </Collapsible>
  );
}

export function VideoFindings({ analysis }: { analysis: VideoAnalysis }) {
  return (
    <VStack gap={2}>
      <Heading level={4}>{analysis.platform === "tiktok" ? "Film z TikToka" : "Film z Instagrama"}</Heading>
      {analysis.caption ? (
        <Collapsible trigger="Opis posta" chevronPosition="start" defaultIsOpen={false}>
          <Text as="p" wordBreak="break-word" style={{ whiteSpace: "pre-wrap" }}>{analysis.caption}</Text>
        </Collapsible>
      ) : analysis.status === "analyzed" && <Text as="p" type="supporting" color="secondary">Opis posta jest niedostępny.</Text>}
      {analysis.status === "analyzed" && (
        <>
          <TimedPassages title="Transkrypcja" entries={analysis.transcript} empty="Nie rozpoznano wypowiedzi w nagraniu." />
          <TimedPassages title="Obraz i napisy" entries={analysis.observations} empty="Brak odczytanych szczegółów obrazu." />
        </>
      )}
    </VStack>
  );
}
