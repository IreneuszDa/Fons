import { HStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";

export const FOOTER_TEXT_PL = "Prototyp. Pomaga ocenić informację — nie jest automatycznym sędzią prawdy.";

export function SiteFooter() {
  return (
    <HStack gap={2} wrap="wrap" vAlign="center" hAlign="center">
      <Text type="supporting" color="secondary">
        {FOOTER_TEXT_PL}
      </Text>
      <Link href="/zrodla" type="supporting">
        Źródła i metoda
      </Link>
    </HStack>
  );
}
