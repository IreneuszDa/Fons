import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { VerdictReport } from "../../shared/contracts";
import { AnswerSource } from "./AnswerCard";

export function QuestionBreakdown({ parts, anchorId }: { parts: NonNullable<VerdictReport["questionParts"]>; anchorId?: string }) {
  return (
    <VStack as="section" gap={3}>
      <Heading level={3} id={anchorId}>Odpowiedzi na Twoje pytania</Heading>
      {parts.map((part, index) => (
        <VStack key={index} gap={2}>
          {index > 0 && <Divider />}
          <Heading level={4}>{part.questionPl}</Heading>
          <Text as="p" wordBreak="break-word">{part.answerPl}</Text>
          {part.evidence.length > 0 && (
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger="Pokaż źródła odpowiedzi">
              <VStack gap={3} paddingBlock={2}>
                {part.evidence.map(item => <AnswerSource key={item.recordId} item={item} />)}
              </VStack>
            </Collapsible>
          )}
        </VStack>
      ))}
    </VStack>
  );
}
