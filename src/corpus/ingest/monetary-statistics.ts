import { DOMParser, parseHTML } from "linkedom";
import type { CatalogSource, CorpusRecord } from "../../shared/contracts";
import { PoliteClient, baseFromCatalog, newResult, recordId, sourceFromCatalog, type IngestOptions } from "./common";
import { parseCsv } from "./govpl-officials";

export const cpiPage = "https://publikacje.new.stat.gov.pl/portal-publikacje/miesieczne-wskazniki-cen-towarow-i-uslug-konsumpcyjnych-od-1982-r";
const ratesBase = "https://static.nbp.pl/dane/stopy/stopy_procentowe";
export const currentRates = ratesBase + ".xml";
export const archivedRates = ratesBase + "_archiwum.xml";

function assertHost(url: string, expected: string) {
  if (new URL(url).origin !== new URL(expected).origin) throw new Error("Źródło przekierowało poza domenę wydawcy");
}

function isoDay(raw: string | null | undefined): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/u.test(raw) || new Date(raw).toJSON()?.slice(0, 10) !== raw) {
    throw new Error("Nieprawidłowa data w tabeli wydawcy");
  }
  return raw;
}

function decimal(raw: string | null | undefined): number {
  if (!raw || !/^-?\d+(?:[.,]\d+)?$/u.test(raw)) throw new Error("Nieprawidłowa wartość w tabeli wydawcy");
  return Number(raw.replace(",", "."));
}

interface SourceResponse { finalUrl: string; fetchedAt: string; body: string }
interface CsvResponse { finalUrl: string; fetchedAt: string; data: Buffer }

export function cpiListing(page: SourceResponse) {
  assertHost(page.finalUrl, cpiPage);
  const doc = parseHTML(page.body).document;
  const csv = doc.querySelector("a.file--mime-text-csv .file-url")?.textContent?.trim();
  if (!csv) throw new Error("Brak adresu tabeli CSV GUS");
  assertHost(csv, cpiPage);
  const publishedAt = isoDay(doc.querySelector("time[datetime]")?.getAttribute("datetime"));
  return { csv, publishedAt, url: page.finalUrl };
}

export function parseCpiSeries(source: CatalogSource, listing: ReturnType<typeof cpiListing>, file: CsvResponse): CorpusRecord[] {
  assertHost(file.finalUrl, cpiPage);
  const { publishedAt } = listing;
  const rows = parseCsv(new TextDecoder("windows-1250").decode(file.data));
  if (rows[0]?.slice(0, 7).join(";") !== "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga") {
    throw new Error("Nieznany układ tabeli GUS");
  }
  const observations = new Map<string, string>();
  for (const [metric, country, comparison, year, month, index, flag] of rows.slice(1)) {
    if (metric !== "Wskaźnik cen towarów i usług konsumpcyjnych" || country !== "Polska" || comparison !== "Analogiczny miesiąc poprzedniego roku = 100" || !index?.trim()) continue;
    const period = isoDay(year + "-" + month?.padStart(2, "0") + "-01").slice(0, 7);
    if (observations.has(period)) throw new Error("Niejednoznaczny okres GUS: " + period);
    const rate = (decimal(index) - 100).toFixed(1).replace(".", ",");
    if (period > publishedAt.slice(0, 7)) throw new Error("Obserwacja GUS po dacie publikacji");
    observations.set(period, `Inflacja CPI w Polsce w ${period} wyniosła ${rate}% rok do roku${flag ? " (oznaczenie GUS: " + flag + ")" : ""}.`);
  }
  const months = [...observations.keys()].sort();
  if (months.length < 12) throw new Error("Niekompletny szereg miesięczny GUS");
  const base = { ...baseFromCatalog(source), url: listing.url, publishedAt, fetchedAt: file.fetchedAt, lang: "pl", origin: "corpus" as const };
  const records: CorpusRecord[] = [];
  for (const year of new Set(months.map(m => m.slice(0, 4)))) {
    records.push({ ...base, id: recordId(source.id, year), title: "GUS: miesięczna inflacja CPI w Polsce rok do roku, " + year, period: year,
      text: months.filter(m => m.startsWith(year)).map(m => observations.get(m)!).join("\n"),
      topics: ["generated-from-data", "cpi-yoy", "series-history"] });
  }
  const latest = months.at(-1)!;
  records.push({ ...base, id: recordId(source.id, "latest"), title: "GUS: ostatni opublikowany miesięczny odczyt inflacji CPI w Polsce", period: latest,
    text: `Najnowszy miesiąc w zestawieniu GUS opublikowanym ${publishedAt} to ${latest}. ${observations.get(latest)}`,
    topics: ["generated-from-data", "cpi-yoy", "series-latest"] });
  return records;
}

async function cpiRecords(opts: IngestOptions, client: PoliteClient): Promise<CorpusRecord[]> {
  const listing = cpiListing(await client.get(cpiPage));
  return parseCpiSeries(sourceFromCatalog(opts.catalog, "gus-cpi"), listing, await client.getBinary(listing.csv));
}

export function parseReferenceSeries(source: CatalogSource, archive: SourceResponse, current: SourceResponse): CorpusRecord[] {
  assertHost(archive.finalUrl, archivedRates);
  assertHost(current.finalUrl, currentRates);
  const parse = (body: string) => new DOMParser().parseFromString(body, "text/xml");
  const currentDoc = parse(current.body);
  const table = currentDoc.querySelector("tabela[id=stoproc] pozycja[id=ref]");
  const effective = isoDay(table?.getAttribute("obowiazuje_od"));
  const rate = decimal(table?.getAttribute("oprocentowanie"));
  const publishedAt = isoDay(currentDoc.documentElement.getAttribute("data_publikacji"));
  if (effective > current.fetchedAt.slice(0, 10)) throw new Error("Bieżąca tabela NBP podaje przyszłą zmianę");
  const observations = new Map<string, number>();
  for (const row of parse(archive.body).querySelectorAll("pozycje")) {
    const item = row.querySelector("pozycja[id=ref]");
    if (!item) continue;
    const day = isoDay(row.getAttribute("obowiazuje_od"));
    if (observations.has(day)) throw new Error("Niejednoznaczny okres NBP: " + day);
    observations.set(day, decimal(item.getAttribute("oprocentowanie")));
  }
  if (observations.size < 2 || [...observations.keys()].some(d => d > effective && observations.get(d) !== rate) ||
      (observations.has(effective) && observations.get(effective) !== rate)) throw new Error("Niespójne tabele stóp NBP");
  observations.set(effective, rate);
  const dates = [...observations.keys()].sort().filter((day, i, all) => i === 0 || observations.get(day) !== observations.get(all[i - 1]!));
  const base = { ...baseFromCatalog(source), lang: "pl", origin: "corpus" as const };
  return dates.map((from, i) => {
    const next = dates[i + 1];
    const to = next ? new Date(Date.parse(next) - 86_400_000).toISOString().slice(0, 10) : current.fetchedAt.slice(0, 10);
    const value = observations.get(from)!.toLocaleString("pl-PL", { maximumFractionDigits: 4 });
    const text = next ? `Od ${from} do ${to} stopa referencyjna NBP wynosiła ${value}% w skali roku.`
      : `Według bieżącej tabeli NBP od ${effective} stopa referencyjna NBP wynosi ${value}% w skali roku. Tabelę odczytano ${to}.`;
    return { ...base, id: recordId(source.id, next ? from : "latest"), url: next ? archive.finalUrl : current.finalUrl,
      title: `NBP: stopa referencyjna od ${from}`, text, period: from + "/" + to, publishedAt: next ? null : publishedAt,
      fetchedAt: next ? archive.fetchedAt : current.fetchedAt, topics: ["generated-from-data", "nbp-reference", next ? "series-history" : "series-latest"] };
  });
}

async function rateRecords(opts: IngestOptions, client: PoliteClient): Promise<CorpusRecord[]> {
  const archive = await client.get(archivedRates);
  const current = await client.get(currentRates);
  return parseReferenceSeries(sourceFromCatalog(opts.catalog, "nbp-rates"), archive, current);
}

export async function ingestMonetaryStatistics(opts: IngestOptions) {
  const result = newResult("monetary-statistics");
  const client = new PoliteClient({ refresh: opts.refresh });
  for (const [url, ingest] of [[cpiPage, cpiRecords], [currentRates, rateRecords]] as const) {
    try { result.records.push(...await ingest(opts, client)); }
    catch (error) { result.skipped.push({ what: url, reason: (error as Error).message }); }
  }
  result.requests = client.requests;
  return result;
}
