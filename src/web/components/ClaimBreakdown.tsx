import { Badge } from "@astryxdesign/core/Badge";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { VerdictReport } from "../../shared/contracts";
import { claimRows, STRENGTH_PL, VERDICT_LABEL_PL, VERDICT_TONE } from "../lib/report";
import { ClaimDetails } from "./VerdictCard";
import { VERDICT_ICON } from "./verdictIcons";

/** An assessment belongs to a statement, including when the surrounding material contains other opinions or facts. */
export function ClaimBreakdown({ report, anchorId }: { report: VerdictReport; anchorId?: string }) {
  const rows = claimRows(report);
  return (
    <VStack as="section" gap={2} width="100%">
      <HStack gap={2} vAlign="center">
        <Heading level={3} id={anchorId}>Sprawdzone twierdzenia</Heading>
        <Badge label={rows.length} variant="neutral" />
      </HStack>
      <CollapsibleGroup type="multiple" hasDividers density="balanced">
        {rows.map(row => {
          const assessment = row.verdict;
          const kind = report.claims.find(claim => claim.id === row.claimId)?.type;
          const label = kind === "opinia" ? "Opinia" : kind === "prognoza" ? "Prognoza"
            : assessment.conflicting ? "Sprzeczne źródła" : VERDICT_LABEL_PL[assessment.verdict];
          return (
            <Collapsible key={row.claimId} value={row.claimId} trigger={
              <VStack gap={1} hAlign="start">
                <Text weight="semibold" wordBreak="break-word">{row.text}</Text>
                <HStack gap={1.5} vAlign="center" wrap="wrap">
                  <Icon icon={VERDICT_ICON[assessment.verdict]} size="sm" color={VERDICT_TONE[assessment.verdict]} />
                  <Text type="supporting">{label}</Text>
                  {assessment.strength.score != null &&
                    <Text type="supporting" color="secondary">· Siła dowodów {STRENGTH_PL[assessment.strength.level]}</Text>}
                </HStack>
              </VStack>
            }>
              <VStack paddingBlock={3}><ClaimDetails verdict={assessment} /></VStack>
            </Collapsible>
          );
        })}
      </CollapsibleGroup>
    </VStack>
  );
}
