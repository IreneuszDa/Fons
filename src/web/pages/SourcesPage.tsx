// Scaffolded from the Astryx `table` page template (header block + table filling its region); selection/sorting removed.
import { useEffect, useMemo, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { List, ListItem } from "@astryxdesign/core/List";
import { Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { CatalogSource } from "../../shared/contracts";
import { ApiError, fetchSources, NETWORK_ERROR_PL, type SourcesResponse } from "../api";
import { StatusNotice } from "../components/StatusNotice";
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
  const isNarrow = useMediaQuery("(max-width: 767px)");
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
    <Layout
      height="auto"
      contentWidth={1200}
      padding={6}
      header={
        <LayoutHeader hasDivider padding={4}>
          <VStack gap={2}>
            <Heading level={1}>Źródła i metoda</Heading>
            <Text as="p">
              Z przesłanego materiału Fons wyodrębnia tezy. Dla każdej szuka dowodów w katalogu wydawców.
              W raporcie możesz otworzyć publikacje, przeczytać cytaty i sprawdzić, jakich danych zabrakło.
            </Text>
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
            <VStack as="section" gap={1}>
              <Heading level={2}>Sprawdzenia fact-checkerów</Heading>
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
            <VStack as="section" gap={1}>
              <Heading level={2}>Podobne narracje w EUvsDisinfo</Heading>
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
            {data ? (
              <MetadataList orientation="horizontal" columns="multi">
                <MetadataListItem label="Wersja bazy źródeł">
                  <Text type="code">{data.snapshotId}</Text>
                </MetadataListItem>
                <MetadataListItem label="Źródła">{String(rows.length)}</MetadataListItem>
                <MetadataListItem label="Rekordy razem">{total.toLocaleString("pl-PL")}</MetadataListItem>
              </MetadataList>
            ) : null}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent isScrollable={false} padding={4}>
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
        </LayoutContent>
      }
    />
  );
}
