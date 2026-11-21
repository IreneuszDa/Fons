/**
 * Ingestia statystyk GUS z API Banku Danych Lokalnych (bdl.stat.gov.pl/api/v1; publiczne, bez klucza; poziom "Polska": unit-level=0).
 * Każdy punkt danych → krótkie zdanie z JAWNYM okresem i dokładną liczbą z API; tag "generated-from-data"; url = dokładne zapytanie API.
 *
 * Serie (zmienne BDL): stopa bezrobocia rejestrowanego (miesięcznie, zmienne 461680-461691 = styczeń…grudzień),
 * wskaźnik cen towarów i usług konsumpcyjnych (średnioroczny; zmienna 217230, "okres poprzedni = 100"),
 * ludność ogółem (stan na 31 XII; zmienna 72305).
 * Uwaga merytoryczna: bezrobocie rejestrowane (urzędy pracy) to inna miara niż stopa bezrobocia wg BAEL (Eurostat) — zdania nazywają miarę wprost.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, newResult, recordId, sourceFromCatalog } from "./common";

const API = "https://bdl.stat.gov.pl/api/v1";

interface BdlData {
  variableId: number;
  results: { id: string; name: string; values: { year: string; val: number | null; attrId?: number }[] }[];
}
interface BdlSubject {
  id: string;
  name: string;
  lastUpdate?: string | null;
}

export interface GusPoint {
  year: number;
  month?: number;
  value: number;
}

const MONTHS_PL_LOC = ["styczniu", "lutym", "marcu", "kwietniu", "maju", "czerwcu", "lipcu", "sierpniu", "wrześniu", "październiku", "listopadzie", "grudniu"];

function num(v: number, digits?: number): string {
  const s = digits === undefined ? String(v) : v.toFixed(digits);
  return s.replace(".", ",");
}

function groupInt(n: number): string {
  // liczba osób bez separatora tysięcy (jeden token), jak w rekordach Eurostatu
  return String(Math.round(n));
}

/** Wartość dla "Polska" z odpowiedzi BDL (pierwszy wynik o id 000000000000); null, gdy brak. */
export function polandValues(data: BdlData): { year: number; value: number }[] {
  const row = data.results.find((r) => r.id === "000000000000");
  if (!row) return [];
  return row.values.filter((v): v is { year: string; val: number; attrId?: number } => typeof v.val === "number").map((v) => ({ year: Number(v.year), value: v.val }));
}

/** "W sierpniu 2026 r." / "We wrześniu 2026 r." */
export function inMonth(year: number, month: number): string {
  const loc = MONTHS_PL_LOC[month - 1]!;
  return `${loc.startsWith("w") ? "We" : "W"} ${loc} ${year} r.`;
}

export function unemploymentSentence(p: GusPoint): string {
  return `${inMonth(p.year, p.month!)} stopa bezrobocia rejestrowanego w Polsce (osoby zarejestrowane w urzędach pracy; inna miara niż stopa bezrobocia wg BAEL) wyniosła ${num(p.value)}% (GUS, Bank Danych Lokalnych).`;
}

export function cpiSentence(p: GusPoint): string {
  const change = Math.round((p.value - 100) * 10) / 10;
  const dir = change >= 0 ? "wzrost" : "spadek";
  return `W ${p.year} r. średnioroczny wskaźnik cen towarów i usług konsumpcyjnych (inflacja CPI) w Polsce wyniósł ${num(p.value)} (rok poprzedni = 100), czyli ${dir} cen o ${num(Math.abs(change))}% w porównaniu z rokiem poprzednim (GUS, Bank Danych Lokalnych).`;
}

export function populationSentence(p: GusPoint): string {
  return `Według GUS ludność Polski ogółem (stan na 31 grudnia ${p.year} r.) wynosiła ${groupInt(p.value)} osób (Bank Danych Lokalnych).`;
}

const UNEMPLOYMENT_VARS = [461680, 461681, 461682, 461683, 461684, 461685, 461686, 461687, 461688, 461689, 461690, 461691];

export async function ingestGus(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("gus-bdl");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "gus-bdl");
  const base = baseFromCatalog(src);
  const thisYear = new Date().getUTCFullYear();
  const yearsParam = (from: number) => Array.from({ length: thisYear - from + 1 }, (_, i) => `year=${from + i}`).join("&");
  const dataUrl = (id: number, from: number) => `${API}/data/by-variable/${id}?format=json&unit-level=0&lang=pl&${yearsParam(from)}`;

  const lastUpdate = async (subjectId: string): Promise<string | null> => {
    try {
      const { data } = await client.getJson<BdlSubject>(`${API}/subjects/${subjectId}?format=json&lang=pl`);
      const m = data.lastUpdate ? /^(\d{4}-\d{2}-\d{2})/.exec(data.lastUpdate) : null;
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  };

  const emit = (url: string, fetchedAt: string, publishedAt: string | null, key: string, title: string, text: string, period: string, topics: string[]) => {
    const rec: CorpusRecord = {
      ...base,
      id: recordId("gus-bdl", key),
      url,
      title,
      publishedAt,
      fetchedAt,
      lang: "pl",
      text,
      topics: [...topics, "generated-from-data", "statystyka", "gus", "polska"],
      period,
      origin: "corpus",
    };
    result.records.push(rec);
  };

  // 1. Bezrobocie rejestrowane (miesięcznie): wszystkie miesiące od 2025 r. + grudzień każdego wcześniejszego roku (od 2015)
  try {
    const published = await lastUpdate("P3559");
    let n = 0;
    for (const varId of UNEMPLOYMENT_VARS) {
      const month = (varId - UNEMPLOYMENT_VARS[0]!) + 1;
      const url = dataUrl(varId, 2015);
      const { data, res } = await client.getJson<BdlData>(url);
      for (const v of polandValues(data)) {
        if (!(v.year >= 2025 || month === 12)) continue;
        const period = `${v.year}-${String(month).padStart(2, "0")}`;
        emit(url, res.fetchedAt, published, `unemployment|${varId}|${v.year}`, `GUS: stopa bezrobocia rejestrowanego w Polsce — ${period}`, unemploymentSentence({ year: v.year, month, value: v.value }), period, ["bezrobocie", "bezrobocie-rejestrowane", "gospodarka"]);
        n++;
      }
    }
    opts.log(`  GUS bezrobocie rejestrowane: ${n} punktów`);
  } catch (e) {
    result.skipped.push({ what: "GUS bezrobocie rejestrowane (zmienne 461680-461691)", reason: (e as Error).message });
  }

  // 2. Inflacja CPI (średnioroczna)
  try {
    const published = await lastUpdate("P2955");
    const url = dataUrl(217230, 2008);
    const { data, res } = await client.getJson<BdlData>(url);
    const pts = polandValues(data);
    for (const v of pts) {
      emit(url, res.fetchedAt, published, `cpi|217230|${v.year}`, `GUS: wskaźnik cen towarów i usług konsumpcyjnych (CPI) w Polsce — ${v.year}`, cpiSentence({ year: v.year, value: v.value }), String(v.year), ["inflacja", "ceny", "gospodarka"]);
    }
    opts.log(`  GUS inflacja CPI: ${pts.length} punktów`);
  } catch (e) {
    result.skipped.push({ what: "GUS CPI (zmienna 217230)", reason: (e as Error).message });
  }

  // 3. Ludność ogółem (31 XII)
  try {
    const published = await lastUpdate("P2137");
    const url = dataUrl(72305, 2005);
    const { data, res } = await client.getJson<BdlData>(url);
    const pts = polandValues(data);
    for (const v of pts) {
      emit(url, res.fetchedAt, published, `population|72305|${v.year}`, `GUS: ludność Polski ogółem — stan na 31 grudnia ${v.year} r.`, populationSentence({ year: v.year, value: v.value }), String(v.year), ["demografia", "ludnosc"]);
    }
    opts.log(`  GUS ludność: ${pts.length} punktów`);
  } catch (e) {
    result.skipped.push({ what: "GUS ludność (zmienna 72305)", reason: (e as Error).message });
  }

  result.requests = client.requests;
  result.notes.push(
    "Zdania wygenerowane z wartości API BDL (poziom Polska); publishedAt = lastUpdate tematu BDL (gdy API go podaje; inaczej null). Bezrobocie: miary rejestrowanej (urzędy pracy), nie BAEL.",
  );
  return result;
}
