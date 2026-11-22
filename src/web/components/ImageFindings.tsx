import { Collapsible } from "@astryxdesign/core/Collapsible";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import type { VerdictReport } from "../../shared/contracts";
import type { ImageSearchResult, LocalImageSearch } from "../../shared/image-search";
import { imageFileLabel, imageMatchLabel, localImageMatchLabel, localImageScope } from "../../shared/reply-view";
import { paragraphs } from "../lib/format";
import { safeUrl } from "../lib/safeUrl";

export function LocalImageFindings({ search }: { search: LocalImageSearch }) {
  return <VStack gap={1}>
    <Text as="p">{localImageScope(search)}</Text>
    {search.matches.map(match => {
      const href = safeUrl(match.url);
      return <Text as="p" key={match.url}>{localImageMatchLabel(match)} · {href
        ? <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)">{match.title}</Link> : match.title}</Text>;
    })}
  </VStack>;
}

export function GoogleFindings({ search, expanded }: { search: ImageSearchResult; expanded: boolean }) {
  const first = search.matches.filter(m => m.url).slice(0, 3);
  const rest = search.matches.filter(m => !first.includes(m));
  function matchLine(match: ImageSearchResult["matches"][number]) {
    const url = safeUrl(match.url);
    return <Text as="p" key={match.kind + (url ?? match.host)}>{imageMatchLabel(match)} · {url
      ? <Link href={url} isExternalLink rel="noopener noreferrer nofollow" newTabLabel="(otwiera się w nowej karcie)">{match.title || match.host}</Link> : match.host}</Text>;
  }
  return (
    <VStack gap={2}>
      <Text as="p">{search.messagePl}</Text>
      {first.map(matchLine)}
      {rest.length > 0 && (
        <Collapsible trigger={`${first.length ? "Pozostałe dopasowania" : "Dopasowania w Google"} (${rest.length})`} defaultIsOpen={expanded}>
          <VStack gap={2}>{rest.map(matchLine)}</VStack>
        </Collapsible>
      )}
      {(search.usage || search.status === "ok") && <Text as="p" type="supporting" color="secondary">
        {search.usage && `Liczba wywołań Google Vision dla tego wyszukiwania: ${search.usage.requests}. `}Koszt jest nieznany. Kwotę podaje Google w rozliczeniu projektu.
      </Text>}
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
  if (analysis.comparison) return (
    <VStack gap={2}>
      <Text as="p">{summaryPl}</Text>
      {analysis.images.map(({ provenance }, i) => provenance.file && <Text key={i} as="p" type="supporting">Obraz {i + 1} · {imageFileLabel(provenance.file)}</Text>)}
    </VStack>
  );
  if (analysis.visual) return (
    <VStack gap={2}>
      {paragraphs(summaryPl).map((p, i) => <Text key={i} as="p">{p}</Text>)}
      {analysis.visual.mode === "context" && analysis.images.flatMap(image => image.localSearch?.matches ?? []).map(match => {
        const href = safeUrl(match.url);
        return href && <Link key={href} href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)">{match.title} · {match.publisher}</Link>;
      })}
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
      {analysis.images.map(({ search, localSearch }, index) => (
        <VStack key={index} gap={2}>
          {localSearch && <LocalImageFindings search={localSearch} />}
          {search && <GoogleFindings search={search} expanded={expanded} />}
          {!localSearch && !search && <Text as="p">{summaryPl}</Text>}
        </VStack>
      ))}
    </VStack>
  );
  return (
    <VStack gap={3}>
      {analysis.images.map(({ provenance, search }, index) => (
        <VStack gap={2} key={index}>
          {analysis.images.length > 1 && <Text weight="semibold">Obraz {index + 1}</Text>}
          {provenance.file && <Text as="p" type="supporting">{imageFileLabel(provenance.file)}</Text>}
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
