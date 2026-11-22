// Scaffolded from the Astryx `table` page template (header block + table filling its region); selection/sorting removed.
import { useEffect, useMemo, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { CatalogSource } from "../../shared/contracts";
import { ApiError, fetchSources, NETWORK_ERROR_PL, type SourcesResponse } from "../api";
import { StatusNotice } from "../components/StatusNotice";
import { MaterialArchive } from "../components/MaterialArchive";
import { safeUrl } from "../lib/safeUrl";
import { SOURCE_TYPE_PL } from "../lib/report";

type Row = CatalogSource & { records: number };

const LEVEL_PL: Record<number, string> = {
  1: "1 — urzędowe, pierwotne",
  2: "2 — fact-check, instytucje UE/NATO",
  3: "3 — wiarygodne wtórne",
};

export function sourceRows(data: SourcesResponse): Row[] {
  return data.catalog
    .map((s) => ({ ...s, records: data.counts[s.id] ?? 0 }))
    .sort((a, b) => a.level - b.level || a.publisher.localeCompare(b.publisher, "pl"));
}

function PublisherCell({ row: r }: { row: Row }) {
  const href = safeUrl(r.homepage);
  return (
    <VStack gap={0.5}>
      {href ? (
        <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)" rel="noopener noreferrer nofollow">
          {r.publisher}
        </Link>
      ) : (
        <Text>{r.publisher}</Text>
      )}
      <Text type="supporting" color="secondary">
        {r.qualification}
      </Text>
    </VStack>
  );
}

export default function SourcesPage() {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const archiveLink = useMemo(() => {
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    if (!hash.startsWith("#archiwum?")) return null;
    const params = new URLSearchParams(hash.slice("#archiwum?".length));
    return { initialUrl: params.get("url")?.slice(0, 2048), recordId: params.get("record")?.slice(0, 160) };
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetchSources()
      .then((d) => alive && setData(d))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const rows = useMemo(() => (data ? sourceRows(data) : []), [data]);
  // Below tablet width six columns do not fit: the same facts render as list rows instead.
  const isNarrow = useMediaQuery("(max-width: 59.99rem)");
  const total = rows.reduce((a, r) => a + r.records, 0);

  const columns: TableColumn<Row>[] = [
    {
      key: "publisher",
      header: "Wydawca",
      renderCell: (r) => <PublisherCell row={r} />,
    },
    { key: "hosts", header: "Adresy (dokładne)", renderCell: (r) => <Text type="code">{r.hosts.join(", ")}</Text> },
    {
      key: "type",
      header: "Typ",
      renderCell: (r) => (
        <Text>
          {SOURCE_TYPE_PL[r.type]}
          {r.ifcnEfcsn ? " (IFCN/EFCSN)" : ""}
        </Text>
      ),
    },
    { key: "level", header: "Poziom", renderCell: (r) => <Text>{LEVEL_PL[r.level] ?? String(r.level)}</Text> },
    { key: "licence", header: "Licencja", renderCell: (r) => <Text>{r.licence}</Text> },
    { key: "records", header: "Rekordy", align: "end", renderCell: (r) => <Text hasTabularNumbers>{r.records.toLocaleString("pl-PL")}</Text> },
  ];

  return (
    <VStack className="fons-sources" width="100%" hAlign="center" paddingInline={4} paddingBlockEnd={10}>
      <style>{`
        .fons-sources { background: var(--color-background-surface); }
        .fons-sources .sources-nav { position: relative; min-height: 3.5rem; }
        .fons-sources .sources-brand, .fons-sources .sources-title {
          font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; letter-spacing: -.045em;
        }
        .fons-sources .sources-brand { position: absolute; left: 50%; transform: translateX(-50%); font-size: 1.55rem; }
        .fons-sources .sources-title { font-size: clamp(2.7rem, 6vw, 4.4rem); line-height: 1.06; }
        .fons-sources .sources-intro { text-align: center; text-wrap: pretty; line-height: 1.6; }
        .fons-sources .sources-method > * + * { border-block-start: thin solid var(--color-border); }
        .fons-sources .sources-method > * { padding-block: var(--spacing-2); }
        .fons-sources .sources-catalog { border-block-start: thin solid var(--color-border); }
        .fons-sources .sources-catalog { overflow-wrap: anywhere; }
      `}</style>
      <HStack as="nav" aria-label="Nawigacja główna" className="sources-nav" width="100%" vAlign="center">
        <Link href="/" type="supporting">← Wróć do czatu</Link>
        <Text className="sources-brand">Fons</Text>
      </HStack>
      <VStack width="100%" maxWidth="44rem" gap={5} paddingBlock={8}>
        <VStack hAlign="center" gap={3} paddingBlock={5}>
          <Heading className="sources-title" level={1}>Źródła i metoda</Heading>
          <Text as="p" className="sources-intro" type="large" weight="normal" color="secondary">
            Z przesłanego materiału Fons wyodrębnia tezy. Dla każdej szuka dowodów w katalogu wydawców.
            W raporcie możesz otworzyć publikacje, przeczytać cytaty i sprawdzić, jakich danych zabrakło.
          </Text>
        </VStack>
        <VStack className="sources-method" width="100%">
            <Collapsible defaultIsOpen={Boolean(archiveLink)} chevronPosition="start" trigger="Moje archiwum materiałów">
              <MaterialArchive {...archiveLink} />
            </Collapsible>
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger="Jak dobieramy i porównujemy dowody">
              <VStack gap={2} paddingBlock={2}>
                <Text as="p">Wyszukiwanie porównuje słowa oraz znaczenie pytania z dokumentami w bazie.
                  W trybie online Fons szuka także publikacji w internecie. Raport pokazuje, które metody zadziałały podczas konkretnego sprawdzenia.</Text>
                <Text as="p">Przy porównaniu liczą się data zdarzenia, okres danych i pochodzenie publikacji. Dwa przedruki jednego tekstu
                  mogą opierać się na tej samej informacji. Sprzeczne dowody możesz przeczytać obok siebie w szczegółach twierdzenia.</Text>
                <Text as="p">Opinię lub prognozę oznaczamy osobno. Siłę dowodów obliczamy na podstawie rodzaju i niezależności źródeł,
                  aktualności materiału oraz wyniku kontroli cytatów.</Text>
              </VStack>
            </Collapsible>
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger="Materiały o standardach weryfikacji">
              <VStack gap={2} paddingBlock={2}>
                <Text as="p">IFCN i EFCSN opisują zasady pracy organizacji fact-checkingowych, w tym dokumentowanie źródeł i publikowanie korekt.
                  EDMO opisuje niezależność pracy redakcyjnej i badawczej. NASK pokazuje, jak sprawdzać pochodzenie wiadomości i szukać potwierdzenia
                  poza platformą społecznościową.</Text>
                <Link href="https://ifcncodeofprinciples.poynter.org/the-commitments" isExternalLink rel="noopener noreferrer">Kodeks IFCN</Link>
                <Link href="https://efcsn.com/code-of-standards/" isExternalLink rel="noopener noreferrer">Europejski kodeks EFCSN</Link>
                <Link href="https://belux.edmo.eu/about-us/guiding-principles-for-the-edmo-network/" isExternalLink rel="noopener noreferrer">Zasady sieci EDMO</Link>
                <Link href="https://oad.nask.pl/aktualnosci/jak-obywatele-moga-pomoc-w-zwalczaniu-dezinformacji" isExternalLink rel="noopener noreferrer">Wskazówki Ośrodka Analizy Dezinformacji NASK</Link>
              </VStack>
            </Collapsible>
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger="Sprawdzenia fact-checkerów">
              <VStack gap={2} paddingBlock={2}>
              <Text as="p">
                Fons indeksuje sprawdzenia Stowarzyszenia Demagog. Kiedy pytasz o konkretną analizę tej redakcji,
                przeszukuje też Google Fact Check Tools na żywo i porównuje znalezioną tezę z Twoim pytaniem.
                Ocena przy publikacji pochodzi od jej wydawcy. W publicznym Fact Check Explorerze znajdziesz również
                sprawdzenia innych redakcji.
              </Text>
              <HStack gap={2} wrap="wrap">
                <Link
                  href="https://developers.google.com/fact-check/tools/api/reference/rest?hl=pl"
                  isExternalLink
                  newTabLabel="(otwiera się w nowej karcie)"
                  rel="noopener noreferrer nofollow"
                >
                  Dokumentacja Google Fact Check Tools API
                </Link>
                <Link
                  href="https://toolbox.google.com/factcheck/explorer/search/list:recent;hl=pl"
                  isExternalLink
                  newTabLabel="(otwiera się w nowej karcie)"
                  rel="noopener noreferrer nofollow"
                >
                  Google Fact Check Explorer
                </Link>
              </HStack>
              </VStack>
            </Collapsible>
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger="Podobne narracje w EUvsDisinfo">
              <VStack gap={2} paddingBlock={2}>
              <Text as="p">
                Fons porównuje twierdzenia z przypadkami opisanymi przez EUvsDisinfo, korzystając także z angielskich
                wariantów zapytania. W wynikach pokazuje możliwe podobieństwa i odnośniki do przypadków. Do ustalenia,
                czy sprawdzana treść pochodzi z operacji informacyjnej, potrzeba osobnych dowodów.
              </Text>
              <Link
                href="https://euvsdisinfo.eu/disinformation-cases/"
                isExternalLink
                newTabLabel="(otwiera się w nowej karcie)"
                rel="noopener noreferrer nofollow"
              >
                Baza przypadków EUvsDisinfo
              </Link>
              </VStack>
            </Collapsible>
        </VStack>
      </VStack>
      <VStack as="section" className="sources-catalog" width="100%" maxWidth="72rem" gap={4} paddingBlockStart={6}>
        <Heading level={2}>Katalog wydawców</Heading>
        <Link href="/api/sources">Otwórz katalog w formacie JSON</Link>
        {data ? (
              <MetadataList orientation="horizontal" columns="multi">
                <MetadataListItem label="Wersja bazy źródeł">
                  <Text type="code">{data.snapshotId}</Text>
                </MetadataListItem>
                <MetadataListItem label="Źródła">{String(rows.length)}</MetadataListItem>
                <MetadataListItem label="Rekordy razem">{total.toLocaleString("pl-PL")}</MetadataListItem>
              </MetadataList>
            ) : null}
          {error ? (
            <StatusNotice
              headingLevel={2}
              title="Nie udało się wczytać listy źródeł"
              message={error}
              actions={<Button label="Spróbuj ponownie" variant="primary" onClick={() => setAttempt((a) => a + 1)} />}
            />
          ) : !data ? (
            <Spinner size="lg" label="Wczytuję listę źródeł…" aria-label="Wczytuję listę źródeł" />
          ) : (
            isNarrow ? (
              <List hasDividers>
                {rows.map((r) => (
                  <ListItem
                    key={r.id}
                    align="start"
                    label={<PublisherCell row={r} />}
                    description={
                      <VStack gap={0.5}>
                        <Text type="supporting">Adresy: {r.hosts.join(", ")}</Text>
                        <Text type="supporting">
                          Typ: {SOURCE_TYPE_PL[r.type]}
                          {r.ifcnEfcsn ? " (IFCN/EFCSN)" : ""} · Poziom: {LEVEL_PL[r.level] ?? String(r.level)}
                        </Text>
                        <Text type="supporting">Licencja: {r.licence}</Text>
                        <Text type="supporting">Rekordy: {r.records.toLocaleString("pl-PL")}</Text>
                      </VStack>
                    }
                  />
                ))}
              </List>
            ) : (
              <Table<Row> data={rows} columns={columns} idKey="id" verticalAlign="top" />
            )
          )}
      </VStack>
    </VStack>
  );
}
