import { Collapsible } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import type { VerdictReport } from "../../shared/contracts";
import type { ImageSearchResult } from "../../shared/image-search";
import { paragraphs } from "../lib/format";
import { safeUrl } from "../lib/safeUrl";

const matchLabel = { page: "Strona z obrazem", full: "Cały obraz", partial: "Fragment obrazu" };

export function GoogleFindings({ search, expanded }: { search: ImageSearchResult; expanded: boolean }) {
  return (
    <VStack gap={2}>
      <Text as="p">{search.messagePl}</Text>
      {search.matches.length > 0 && (
        <Collapsible trigger={`Dopasowania w Google (${search.matches.length})`} defaultIsOpen={expanded}>
          <VStack gap={2}>
            {search.matches.map((match) => {
              const url = safeUrl(match.url);
              return (
                <Text as="p" key={match.kind + (url ?? match.host)}>
                  {matchLabel[match.kind]} · {url ? (
                    <Link href={url} isExternalLink newTabLabel="(otwiera się w nowej karcie)">{match.title || match.host}</Link>
                  ) : match.host}
                </Text>
              );
            })}
          </VStack>
        </Collapsible>
      )}
      {search.factChecks.map((review) => {
        const url = safeUrl(review.url);
        return (
          <Text as="p" key={review.url}>
            {review.publisher} · {url ? (
              <Link href={url} isExternalLink newTabLabel="(otwiera się w nowej karcie)">{review.title}</Link>
            ) : review.title}{review.rating ? ` · Ocena redakcji: ${review.rating}` : ""}
          </Text>
        );
      })}
      {search.factCheckMessagePl ? <Text as="p" color="secondary">{search.factCheckMessagePl}</Text>
        : search.factCheckStatus === "ok" && !search.factChecks.length ? (
          <Text as="p" color="secondary">Google Fact Check Tools nie znalazło powiązanej weryfikacji.</Text>
        ) : null}
    </VStack>
  );
}

export function ImageFindings({ analysis, summaryPl, expanded = false }: {
  analysis: NonNullable<VerdictReport["imageAnalysis"]>;
  summaryPl: string;
  expanded?: boolean;
}) {
  if (analysis.visual) return (
    <VStack gap={2}>
      {paragraphs(summaryPl).map((p, i) => <Text key={i} as="p">{p}</Text>)}
      {analysis.visual.citations.map(({ title, url, quote }) => {
        const href = safeUrl(url);
        return (
          <VStack key={url + quote} gap={0.5}>
            {href ? <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)">{title}</Link> : <Text>{title}</Text>}
            {quote !== title && !summaryPl.includes(quote) && <Text as="p" type="supporting" color="secondary">„{quote}”</Text>}
          </VStack>
        );
      })}
    </VStack>
  );
  if (analysis.focus === "copies") return (
    <VStack gap={2}>
      {analysis.images.map(({ search }, index) => search
        ? <GoogleFindings key={index} search={search} expanded={expanded} />
        : <Text as="p" key={index}>{summaryPl}</Text>)}
    </VStack>
  );
  return (
    <VStack gap={3}>
      {analysis.images.map(({ provenance, search }, index) => (
        <VStack gap={2} key={index}>
          {analysis.images.length > 1 && <Text weight="semibold">Obraz {index + 1}</Text>}
          <Text as="p">{provenance.textPl}</Text>
          {expanded && provenance.declaration === "none" && (
            <Link href="https://synthid.com/" isExternalLink newTabLabel="(otwiera się w nowej karcie)">
              Sprawdź ręcznie znak wodny w Google SynthID
            </Link>
          )}
          {search && <GoogleFindings search={search} expanded={expanded} />}
        </VStack>
      ))}
    </VStack>
  );
}
