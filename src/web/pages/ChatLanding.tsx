// Scaffolded from the Astryx `ai-chat-landing` page template; frame, gaps and padding kept, content replaced.
import { MessageComposer, type SubmitMessage } from "../components/MessageComposer";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";


export interface Suggestion {
  heading: string;
  body: string;
  prompt: string;
}

export const SUGGESTIONS: Suggestion[] = [
  {
    heading: "Poznaj Fonsa",
    body: "„Co potrafisz?”",
    prompt: "Co potrafisz?",
  },
  {
    heading: "Sprawdź wiadomość",
    body: "„MSZ zakazało wszystkim Polakom wyjazdów do Niemiec.”",
    prompt: "MSZ zakazało wszystkim Polakom wyjazdów do Niemiec.",
  },
  {
    heading: "Sprawdź liczbę",
    body: "„Inflacja w Polsce wynosi teraz 18 procent.”",
    prompt: "Inflacja w Polsce wynosi teraz 18 procent.",
  },
  {
    heading: "Sprawdź datę",
    body: "„Polska jest w Unii Europejskiej od 1 maja 2004 roku.”",
    prompt: "Polska jest w Unii Europejskiej od 1 maja 2004 roku.",
  },
  {
    heading: "Zadaj pytanie",
    body: "„Kiedy Szwecja dołączyła do NATO?”",
    prompt: "Kiedy Szwecja dołączyła do NATO?",
  },
];

export default function ChatLanding({ onSubmit, isDisabled }: { onSubmit: SubmitMessage; isDisabled?: boolean }) {
  return (
    <Layout
      height="fill"
      contentWidth={720}
      padding={6}
      content={
        <LayoutContent>
          {/* Fill the content area so the greeting and composer stay vertically centered. */}
          <VStack gap={8} vAlign="center" minHeight="100%">
            {/* Greeting */}
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Icon icon={ShieldCheckIcon} size="md" color="accent" />
                <Text type="large">Sprawdź informację u źródła</Text>
              </HStack>
              <Text type="display-2" as="h1">
                Cześć, jestem Fons.
              </Text>
              <Text as="p" color="secondary">
                Wklej wiadomość lub link, także do publicznego filmu z TikToka lub Instagrama. Sprawdzę, co o zawartych w nim twierdzeniach mówią źródła.
              </Text>
            </VStack>

            {/* Composer */}
            <MessageComposer onSubmit={onSubmit} isDisabled={isDisabled} />
            <Text type="supporting" color="secondary">
              Nie wpisuj haseł, numerów kart ani danych osobowych. Enter wysyła, Shift+Enter dodaje nową linię.
            </Text>

            {/* Suggestion cards */}
            <VStack gap={3}>
              <Heading level={4} accessibilityLevel={2}>Tak możesz zacząć</Heading>
              <Grid columns={{ minWidth: 240 }} gap={3}>
                {SUGGESTIONS.map((s) => (
                  <ClickableCard key={s.heading} label={`${s.heading}: ${s.prompt}`} variant="muted" padding={3} isDisabled={isDisabled} onClick={() => onSubmit({ text: s.prompt })}>
                    <VStack gap={0.5}>
                      <Heading level={4} accessibilityLevel={3}>
                        {s.heading}
                      </Heading>
                      <Text type="body" color="secondary" size="sm">
                        {s.body}
                      </Text>
                    </VStack>
                  </ClickableCard>
                ))}
              </Grid>
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
