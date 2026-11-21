import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ChartBarIcon, CheckCircleIcon, MinusCircleIcon } from "@heroicons/react/24/outline";
import type { StrengthCard as StrengthCardData } from "../../shared/contracts";
import { formatDate } from "../lib/format";
import { STRENGTH_PL, STRENGTH_VARIANT, STRENGTH_WHY_PL, VERIFIER_PL } from "../lib/report";

export function StrengthCard({ strength }: { strength: StrengthCardData }) {
  const score = typeof strength.score === "number" ? strength.score : null;
  const factors = strength.factors ?? [];
  return (
    <Card padding={3}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={ChartBarIcon} size="sm" color="secondary" />
          <Heading level={5}>
            Siła dowodów: {STRENGTH_PL[strength.level]}
            {score !== null ? ` · ${score}/100` : ""}
          </Heading>
        </HStack>
        {score !== null ? (
          <ProgressBar
            label="Siła dowodów w punktach"
            isLabelHidden
            value={score}
            max={100}
            variant={STRENGTH_VARIANT[strength.level]}
            hasValueLabel
            formatValueLabel={(v) => `${v} / 100`}
          />
        ) : null}
        {factors.length === 0 ? <Text as="p">{STRENGTH_WHY_PL[strength.level]}</Text> : null}
        {factors.length > 0 ? (
          <List header={<Text weight="semibold">Skąd ta ocena</Text>} density="compact">
            {factors.map((f, i) => (
              <ListItem
                key={i}
                align="first-line"
                startContent={
                  <Icon
                    icon={f.effect === "plus" ? CheckCircleIcon : MinusCircleIcon}
                    size="sm"
                    color={f.effect === "plus" ? "success" : "warning"}
                    label={f.effect === "plus" ? "podnosi ocenę" : "obniża ocenę"}
                  />
                }
                label={<Text>{f.textPl}</Text>}
              />
            ))}
          </List>
        ) : null}
        <MetadataList columns="single">
          <MetadataListItem label="Źródła urzędowe lub pierwotne">{String(strength.primarySources)}</MetadataListItem>
          <MetadataListItem label="Niezależni wydawcy">{String(strength.independentPublishers)}</MetadataListItem>
          <MetadataListItem label="Najnowszy dowód">{formatDate(strength.newestEvidenceAt, "brak")}</MetadataListItem>
          <MetadataListItem label="Podwójna kontrola">{VERIFIER_PL[strength.verifierAgreement]}</MetadataListItem>
        </MetadataList>
        {strength.notes.length > 0 ? (
          <List listStyle="disc" density="compact">
            {strength.notes.map((n, i) => (
              <ListItem key={i} label={<Text>{n}</Text>} />
            ))}
          </List>
        ) : null}
      </VStack>
    </Card>
  );
}
