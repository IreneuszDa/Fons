import { Collapsible } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { Claim, VideoAnalysis } from "../../shared/contracts";
import { safeUrl } from "../lib/safeUrl";

type ClaimOrigin = VideoAnalysis["claimOrigins"][number];

const originLabels: Record<ClaimOrigin["source"], string> = {
  speech: "Wypowiedź",
  subtitles: "Napisy platformy",
  onscreen: "Tekst na ekranie",
  visual: "Obraz",
  caption: "Opis posta",
};

const platformLabels: Record<VideoAnalysis["platform"], string> = {
  tiktok: "Film z TikToka", instagram: "Film z Instagrama", facebook: "Film z Facebooka", youtube: "Film z YouTube",
  upload_audio: "Przesłane nagranie audio", upload_video: "Przesłany film",
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

export function VideoFindings({ analysis, pendingClaims = [] }: { analysis: VideoAnalysis; pendingClaims?: Claim[] }) {
  const thumbnail = safeUrl(analysis.thumbnailUrl);
  return (
    <VStack gap={2}>
      <Heading level={4}>{platformLabels[analysis.platform]}</Heading>
      {analysis.title && <Text weight="semibold">{analysis.title}</Text>}
      {analysis.author && <Text type="supporting" color="secondary">Autor: {analysis.author}</Text>}
      {thumbnail && <Link href={thumbnail} isExternalLink newTabLabel="(otwiera się w nowej karcie)" referrerPolicy="no-referrer" type="supporting">Zobacz miniaturę filmu</Link>}
      {analysis.caption ? (
        <Collapsible trigger="Opis posta" chevronPosition="start" defaultIsOpen={false}>
          <Text as="p" wordBreak="break-word" style={{ whiteSpace: "pre-wrap" }}>{analysis.caption}</Text>
        </Collapsible>
      ) : analysis.status === "analyzed" && analysis.platform !== "upload_video" && <Text as="p" type="supporting" color="secondary">Opis posta jest niedostępny.</Text>}
      {analysis.status === "subtitles_only" && <Text as="p" type="supporting">Dostępne są napisy platformy. Obraz filmu pozostaje niesprawdzony.</Text>}
      {analysis.status === "caption_only" && <Text as="p" type="supporting">Odczytano wyłącznie publiczny opis posta.</Text>}
      {analysis.status === "transcript_only" && <Text as="p" type="supporting">{analysis.platform === "upload_audio" ? "Sprawdzono treść transkrypcji nagrania." : "Sprawdzono transkrypcję dźwięku. Obraz filmu pozostaje niesprawdzony."}</Text>}
      {analysis.status === "analyzed" && analysis.provider === "openai" &&
        <Text as="p" type="supporting" color="secondary">OpenAI przeanalizował wybrane klatki filmu.</Text>}
      {analysis.transcriptSource === "openai" &&
        <Text as="p" type="supporting" color="secondary">Czas przy wypowiedzi wskazuje początek fragmentu dźwięku.</Text>}
      {analysis.mediaIssue && <Text as="p" type="supporting" color="secondary">{analysis.mediaIssue}</Text>}
      {analysis.status !== "unavailable" && analysis.status !== "caption_only" &&
        <TimedPassages title={analysis.transcriptSource === "platform" ? "Napisy platformy" : "Transkrypcja"} entries={analysis.transcript} empty="Nie rozpoznano wypowiedzi w nagraniu." />}
      {analysis.status === "analyzed" &&
        <TimedPassages title="Obraz i napisy" entries={analysis.observations} empty="Brak odczytanych szczegółów obrazu." />}
      {pendingClaims.length > 0 && (
        <List edge="flush" density="compact" hasDividers header={<Text weight="semibold">Twierdzenia bez oceny</Text>}>
          {pendingClaims.map(claim => {
            const origin = analysis.claimOrigins.find(item => item.claimId === claim.id);
            return (
              <ListItem key={claim.id} label={<Text wordBreak="break-word">{claim.text}</Text>}
                description={origin && <VideoClaimOrigin origin={origin} />} />
            );
          })}
        </List>
      )}
    </VStack>
  );
}
