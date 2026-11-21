import { Badge } from "@astryxdesign/core/Badge";
import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { CheckCircleIcon, InformationCircleIcon, ScaleIcon, XCircleIcon } from "@heroicons/react/24/outline";
import type { ClaimVerdict, EvidenceItem } from "../../shared/contracts";
import { formatDate, hostOf } from "../lib/format";
import {
  ASPECT_PL,
  conflictSides,
  EVIDENCE_GROUP_ORDER,
  EVIDENCE_GROUP_TITLE_PL,
  groupEvidence,
  RELATION_PL,
  SOURCE_TYPE_PL,
} from "../lib/report";
import { safeUrl } from "../lib/safeUrl";

const GROUP_ICON = { wspierajace: CheckCircleIcon, obalajace: XCircleIcon, kontekst: InformationCircleIcon } as const;
const GROUP_ICON_COLOR = { wspierajace: "success", obalajace: "error", kontekst: "secondary" } as const;

/** Title as an external link — only for http/https URLs; anything else is shown as plain text. */
export function SourceTitle({ item }: { item: Pick<EvidenceItem, "title" | "url"> }) {
  const href = safeUrl(item.url);
  if (!href) return <Text weight="semibold">{item.title}</Text>;
  return (
    <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)" weight="semibold" rel="noopener noreferrer nofollow">
      {item.title}
    </Link>
  );
}

export function EvidenceEntry({ item }: { item: EvidenceItem }) {
  const host = hostOf(item.url);
  return (
    <VStack gap={1}>
      <SourceTitle item={item} />
      <Text type="supporting" color="secondary">
        {item.publisher}
        {host ? ` · ${host}` : ""} · {SOURCE_TYPE_PL[item.sourceType]} · poziom {item.level}
      </Text>
      <Text type="supporting" color="secondary">
        Opublikowano: {formatDate(item.publishedAt)} · Pobrano: {formatDate(item.fetchedAt)}
      </Text>
      <Blockquote cite={item.publisher}>„{item.quote}”</Blockquote>
      <Text type="supporting" color="secondary">
        Ten fragment {RELATION_PL[item.relation]} (dotyczy: {ASPECT_PL[item.aspect]})
        {item.ratingRaw ? ` · ocena w źródle: „${item.ratingRaw}”` : ""}
      </Text>
    </VStack>
  );
}

export function EvidenceGroups({ evidence, headingLevel = 5 }: { evidence: EvidenceItem[]; headingLevel?: 4 | 5 | 6 }) {
  const groups = groupEvidence(evidence);
  return (
    <VStack gap={4}>
      {EVIDENCE_GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => (
        <VStack key={g} gap={3}>
          <HStack gap={2} vAlign="center">
            <Icon icon={GROUP_ICON[g]} size="sm" color={GROUP_ICON_COLOR[g]} />
            <Heading level={headingLevel}>{EVIDENCE_GROUP_TITLE_PL[g]}</Heading>
            <Badge label={groups[g].length} variant="neutral" />
          </HStack>
          {groups[g].map((item, i) => (
            <VStack key={item.recordId} gap={3}>
              {i > 0 ? <Divider /> : null}
              <EvidenceEntry item={item} />
            </VStack>
          ))}
        </VStack>
      ))}
    </VStack>
  );
}

function ConflictColumn({ title, items }: { title: string; items: EvidenceItem[] }) {
  return (
    <Card padding={3}>
      <VStack gap={3}>
        <Heading level={6}>{title}</Heading>
        {items.length === 0 ? <Text color="secondary">Brak.</Text> : null}
        {items.map((it) => (
          <VStack key={it.recordId} gap={1}>
            <SourceTitle item={it} />
            <Text type="supporting" color="secondary">
              {it.publisher} · {formatDate(it.publishedAt)}
            </Text>
            <Blockquote>„{it.quote}”</Blockquote>
          </VStack>
        ))}
      </VStack>
    </Card>
  );
}

/** Rule 5: both sides side by side, with dates, without naming a winner. */
export function ConflictingSources({ verdict }: { verdict: ClaimVerdict }) {
  const sides = conflictSides(verdict);
  if (!sides) return null;
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Icon icon={ScaleIcon} size="sm" color="secondary" />
        <Heading level={5}>Źródła są sprzeczne</Heading>
      </HStack>
      <Text as="p">Pokazujemy obie strony z datami. Nie wskazujemy, która ma rację.</Text>
      <Grid columns={{ minWidth: 240 }} gap={3}>
        <ConflictColumn title="Według tych źródeł — prawda" items={sides.supporting} />
        <ConflictColumn title="Według tych źródeł — nieprawda" items={sides.refuting} />
      </Grid>
    </VStack>
  );
}
