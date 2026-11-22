// Built from the Astryx `dashboard` template's bands (headline tiles, then supporting tables); charts left out.
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/Layout";
import { Table, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { formatDateTime, formatDuration, formatUsd } from "../lib/format";
import { STATUS_TITLE_PL, VERDICT_LABEL_PL } from "../lib/report";
import { fetchMetrics } from "./adminApi";
import {
  abstentionOf,
  countRows,
  fixedRows,
  intPl,
  modelCostRows,
  percent,
  purposeRows,
  stepRows,
  type CountRow,
  type ModelCostRow,
  type PurposeRow,
  type StepRow,
} from "./metricsView";
import { PanelState, SectionHeader, StatTile } from "./parts";
import { useAdminData } from "./useAdminData";

const BRANCH_PL: Record<string, string> = {
  bm25: "korpus — wyszukiwanie słów",
  vector: "korpus — wyszukiwanie znaczeniowe",
  incident: "baza incydentów",
  connector: "konektor zewnętrzny",
  live: "wyszukiwanie na żywo",
};

const ms = (v: number | undefined) => (v === undefined ? "—" : formatDuration(v));

const countColumns = (header: string): TableColumn<CountRow>[] => [
  { key: "label", header, renderCell: (r) => <Text>{r.label}</Text> },
  { key: "count", header: "Liczba", align: "end", renderCell: (r) => <Text hasTabularNumbers>{intPl(r.count)}</Text> },
];

const modelColumns: TableColumn<ModelCostRow>[] = [
  { key: "model", header: "Model", renderCell: (r) => <Text>{r.model}</Text> },
  { key: "calls", header: "Wywołania", align: "end", renderCell: (r) => <Text hasTabularNumbers>{intPl(r.calls)}</Text> },
  { key: "usd", header: "Koszt", align: "end", renderCell: (r) => <Text hasTabularNumbers>{formatUsd(r.usd)}</Text> },
];

const purposeColumns: TableColumn<PurposeRow>[] = [
  { key: "purpose", header: "Cel", renderCell: (r) => <Text>{r.purpose}</Text> },
  { key: "calls", header: "Wywołania", align: "end", renderCell: (r) => <Text hasTabularNumbers>{intPl(r.calls)}</Text> },
  { key: "tokensIn", header: "Tokeny wej.", align: "end", renderCell: (r) => <Text hasTabularNumbers>{intPl(r.tokensIn)}</Text> },
  { key: "tokensOut", header: "Tokeny wyj.", align: "end", renderCell: (r) => <Text hasTabularNumbers>{intPl(r.tokensOut)}</Text> },
  { key: "usd", header: "Koszt", align: "end", renderCell: (r) => <Text hasTabularNumbers>{r.usd === undefined ? "—" : formatUsd(r.usd)}</Text> },
];

const stepColumns: TableColumn<StepRow>[] = [
  { key: "step", header: "Krok", renderCell: (r) => <Text>{r.step}</Text> },
  { key: "p50", header: "p50", align: "end", renderCell: (r) => <Text hasTabularNumbers>{ms(r.p50)}</Text> },
  { key: "p95", header: "p95", align: "end", renderCell: (r) => <Text hasTabularNumbers>{ms(r.p95)}</Text> },
];

function TableCard<T extends Record<string, unknown> & { id: string }>({ title, data, columns, empty }: { title: string; data: T[]; columns: TableColumn<T>[]; empty: string }) {
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={4} accessibilityLevel={3}>
          {title}
        </Heading>
        <Table<T> data={data} columns={columns} idKey="id" density="compact" dividers="rows" emptyState={<Text color="secondary">{empty}</Text>} />
      </VStack>
    </Card>
  );
}

export default function MetricsPanel() {
  const { data: m, error, isLoading, reload } = useAdminData(fetchMetrics, []);

  return (
    <VStack gap={4}>
      <SectionHeader title="Metryki usługi" actions={<Button label="Odśwież" variant="secondary" onClick={reload} isLoading={isLoading && !!m} />} />
      <PanelState isLoading={isLoading} error={error} onRetry={reload} hasData={!!m} loadingLabel="Wczytuję metryki…">
        {m ? <MetricsBody m={m} /> : null}
      </PanelState>
    </VStack>
  );
}

export function MetricsBody({ m }: { m: NonNullable<Awaited<ReturnType<typeof fetchMetrics>>> }) {
  const abst = abstentionOf(m);
  const cacheRate = m.totals.verifications > 0 ? m.totals.cacheHits / m.totals.verifications : undefined;
  return (
    <VStack gap={6}>
      <Text color="secondary">
        Okres: {formatDateTime(m.window?.from, "początek")} – {formatDateTime(m.window?.to, "teraz")}
      </Text>
      <Grid columns={{ minWidth: 150, repeat: "fill" }} gap={3}>
        <StatTile label="Sprawdzenia" value={intPl(m.totals.verifications)} />
        <StatTile label="Wstrzymania" value={intPl(abst.count)} hint={`${percent(abst.rate)} sprawdzeń bez rozstrzygnięcia`} />
        <StatTile label="Próby wstrzyknięcia poleceń" value={intPl(m.totals.injectionEvents)} hint="wykryte i zignorowane" />
        <StatTile label="Z pamięci podręcznej" value={intPl(m.totals.cacheHits)} hint={percent(cacheRate)} />
        <StatTile label="Czas odpowiedzi p50" value={ms(m.latency.p50)} />
        <StatTile label="Czas odpowiedzi p95" value={ms(m.latency.p95)} />
        <StatTile label="Koszt na 100 sprawdzeń (znana część)" value={formatUsd(m.cost.per100Usd)} />
        <StatTile label="Suma znanych kosztów" value={formatUsd(m.cost.totalUsd)} />
        {m.cost.googleVisionToday && <StatTile label="Wywołania Google Vision dzisiaj" value={intPl(m.cost.googleVisionToday.requests)}
          hint="Google rozlicza Vision osobno. Kwotę podaje na rachunku projektu." />}
        <StatTile label="Wywołania modeli" value={intPl(m.llm.calls)} hint={`tokeny: ${intPl(m.llm.tokensIn)} wej. / ${intPl(m.llm.tokensOut)} wyj.`} />
      </Grid>
      <Divider />
      <Grid columns={{ minWidth: 320, max: 2, repeat: "fit" }} gap={4}>
        <TableCard title="Werdykty" data={fixedRows(m.totals.byVerdict, VERDICT_LABEL_PL)} columns={countColumns("Werdykt")} empty="Brak danych." />
        <TableCard title="Statusy techniczne" data={fixedRows(m.totals.byStatus, STATUS_TITLE_PL)} columns={countColumns("Status")} empty="Brak danych." />
        <TableCard title="Koszt według modelu" data={modelCostRows(m.cost.byModel)} columns={modelColumns} empty="Brak wywołań modeli." />
        <TableCard title="Czas według kroku" data={stepRows(m.latency.byStep)} columns={stepColumns} empty="Brak pomiarów." />
        <TableCard title="Wywołania modeli według celu" data={purposeRows(m.llm.byPurpose)} columns={purposeColumns} empty="Brak wywołań modeli." />
        <TableCard
          title="Błędy wyszukiwania według gałęzi"
          data={countRows(m.retrievalErrors?.byBranch, BRANCH_PL)}
          columns={countColumns("Gałąź")}
          empty="Brak błędów."
        />
      </Grid>
    </VStack>
  );
}
