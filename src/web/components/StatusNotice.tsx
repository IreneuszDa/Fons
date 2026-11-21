import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { paragraphs } from "../lib/format";

/**
 * Technical status (NIEPELNE / AWARIA / DOPRECYZUJ / POZA_ZAKRESEM / rate limit).
 * Deliberately neutral (muted surface, wrench icon, "to nie jest ocena") — never verdict colours or icons.
 */
export function StatusNotice({
  title,
  message,
  hint,
  actions,
  headingLevel = 3,
}: {
  title: string;
  message: string;
  hint?: string;
  actions?: ReactNode;
  headingLevel?: 2 | 3 | 4;
}) {
  const parts = paragraphs(message);
  return (
    <Card variant="muted" padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={WrenchScrewdriverIcon} size="md" color="secondary" />
          <Heading level={headingLevel}>{title}</Heading>
        </HStack>
        <Text weight="semibold">To nie jest ocena informacji.</Text>
        {parts.map((p, i) => (
          <Text key={i} as="p">
            {p}
          </Text>
        ))}
        {hint && !parts.some((p) => p.includes(hint)) ? (
          <Text as="p" color="secondary">
            {hint}
          </Text>
        ) : null}
        {actions}
      </VStack>
    </Card>
  );
}
