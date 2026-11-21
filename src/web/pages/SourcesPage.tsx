// Scaffolded from the Astryx `table` page template (header block + table filling its region); selection/sorting removed.
import { useEffect, useMemo, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
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
              Dowodem są tylko fragmenty ze źródeł z tej listy. Poziom źródła przypisujemy do dokładnego adresu strony, a nie do odpowiedzi modelu. Treść,
              którą przysyłasz, nigdy nie jest dowodem.
            </Text>
            <VStack as="section" gap={1}>
              <Heading level={2}>Sprawdzenia fact-checkerów</Heading>
              <Text as="p">
                Podczas aktualizacji bazy Fons pobiera przez Google Fact Check Tools API metadane sprawdzeń Stowarzyszenia
                Demagog. W tej bazie Fons szuka też treści sformułowanych innymi słowami i sprawdza, czy dotyczą tego samego
                twierdzenia. Oceny pochodzą od wydawcy. W publicznym Fact Check Explorerze możesz przeglądać sprawdzenia
                innych redakcji.
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
