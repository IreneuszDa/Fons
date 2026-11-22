// Scaffolded from the Astryx `ai-chat-landing` page template; frame, gaps and padding kept, content replaced.
import { MessageComposer, type SubmitMessage } from "../components/MessageComposer";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";

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
                Zadaj pytanie, wklej link albo dodaj plik do sprawdzenia. Możesz też podać link do publicznego filmu z TikToka, Instagrama, Facebooka lub YouTube.
              </Text>
            </VStack>

            {/* Composer */}
            <MessageComposer onSubmit={onSubmit} isDisabled={isDisabled} />
            <Text type="supporting" color="secondary">
              Nie wpisuj haseł, numerów kart ani danych osobowych. Enter wysyła, Shift+Enter dodaje nową linię.
            </Text>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
