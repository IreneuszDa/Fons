import { HStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";

export function SiteFooter() {
  return (
    <HStack gap={2} wrap="wrap" vAlign="center" hAlign="center">
      <Link href="/zrodla" type="supporting">
        Źródła i metoda
      </Link>
    </HStack>
  );
}
