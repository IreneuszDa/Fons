/**
 * Ingestia statystyk z API Eurostatu (JSON-stat). Każdy punkt danych zamieniamy na krótkie zdanie
 * z JAWNYM okresem i dokładną liczbą z API. Rekord ma tag "generated-from-data", a `url` wskazuje
 * dokładne zapytanie do API (serię), z której pochodzi wartość.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, newResult, recordId, sourceFromCatalog } from "./common";

const API = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/";

interface JsonStat {
  id: string[];
  size: number[];
  value: Record<string, number>;
  status?: Record<string, string>;
  label: string;
  updated?: string;
  dimension: Record<string, { category: { index: Record<string, number>; label?: Record<string, string> } }>;
}

type Point = { dims: Record<string, string>; time: string; value: number; flag?: string };

interface SeriesSpec {
  /** Kod zbioru Eurostatu. */
  dataset: string;
  /** Filtry (poza time). Wartości tablicowe = wiele kategorii w jednym zapytaniu. */
  filters: Record<string, string | string[]>;
  topics: string[];
  /** Najstarszy rok/miesiąc, od którego bierzemy punkty. */
  from: string;
  /** Opcjonalnie: tylko wybrane okresy (np. grudnie). */
  onlyTimes?: (t: string) => boolean;
  /** Zdanie dla punktu (lub null, aby pominąć). */
  sentence: (p: Point, ctx: { series: JsonStat; geoLabel: string }) => string | null;
  /** Klucz grupowania punktów w jedno zdanie (np. rok) — gdy zapytanie zwraca kilka kategorii. */
  groupBy?: (p: Point) => string;
  combine?: (points: Point[], ctx: { series: JsonStat }) => { sentence: string; time: string } | null;
}

const MONTHS_PL = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];

function num(v: number): string {
  // Dokładna wartość z API; separator dziesiętny po polsku, bez separatora tysięcy (liczba zostaje jednym tokenem).
  return String(v).replace(".", ",");
}

function flagNote(flag?: string): string {
  if (!flag) return "";
  const notes: string[] = [];
  if (flag.includes("p")) notes.push("dane tymczasowe");
  if (flag.includes("e")) notes.push("wartość szacunkowa");
  return notes.length ? ` (${notes.join(", ")})` : "";
}

function geoName(code: string): string {
  return code === "PL" ? "w Polsce" : code === "EU27_2020" ? "w Unii Europejskiej (UE-27)" : code === "DE" ? "w Niemczech" : `(${code})`;
}

/** Rok-miesiąc sprzed `n` miesięcy (do okien "najnowsze okresy" w seriach miesięcznych). */
function monthsAgo(n: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTHS_PL_LOC = ["styczniu", "lutym", "marcu", "kwietniu", "maju", "czerwcu", "lipcu", "sierpniu", "wrześniu", "październiku", "listopadzie", "grudniu"];

/** "2026-08" → "W sierpniu 2026 r.", "2026-09" → "We wrześniu 2026 r.". */
function monthLabel(time: string): string {
  const [y, m] = time.split("-");
  const loc = MONTHS_PL_LOC[Number(m) - 1]!;
  return `${loc.startsWith("w") ? "We" : "W"} ${loc} ${y} r.`;
}

const SERIES: SeriesSpec[] = [
  {
    dataset: "migr_asyappctza",
    filters: { geo: ["PL", "EU27_2020"], citizen: "TOTAL", sex: "T", age: "TOTAL", unit: "PER", applicant: ["TOTAL", "FRST"] },
    topics: ["migracja", "azyl", "ochrona-miedzynarodowa", "polska"],
    from: "2008",
    // Klucz grupy dla Polski bez zmian (stabilne id rekordów), dla UE-27 z prefiksem geo.
    groupBy: (p) => (p.dims.geo === "PL" ? p.time : `${p.dims.geo}|${p.time}`),
    sentence: () => null,
    combine: (pts) => {
      const total = pts.find((p) => p.dims.applicant === "TOTAL");
      const first = pts.find((p) => p.dims.applicant === "FRST");
      if (!total) return null;
      const t = total.time;
      const s =
        `W ${t} r. ${geoName(total.dims.geo!)} o ochronę międzynarodową (azyl) ubiegało się ogółem ${num(total.value)} osób` +
        (first ? `, w tym ${num(first.value)} osób po raz pierwszy` : "") +
        ` (Eurostat, zbiór migr_asyappctza)${flagNote(total.flag)}.`;
      return { sentence: s, time: t };
    },
  },
  {
    dataset: "migr_asytpsm",
    filters: { geo: ["PL", "EU27_2020"], citizen: "UA", sex: "T", age: "TOTAL", unit: "PER" },
    topics: ["migracja", "uchodzcy", "ukraina", "ochrona-czasowa", "wojna-w-ukrainie"],
    from: "2022-03",
    onlyTimes: (t) => /-(12|03)$/.test(t),
    sentence: (p) => {
      const [y, m] = p.time.split("-");
      const month = MONTHS_PL[Number(m) - 1];
      const where = p.dims.geo === "PL" ? "w Polsce" : "w całej Unii Europejskiej (UE-27)";
      return `Na koniec ${month} ${y} r. ${where} ochroną czasową objętych było ${num(p.value)} obywateli Ukrainy (Eurostat, zbiór migr_asytpsm)${flagNote(p.flag)}.`;
    },
  },
  {
    dataset: "gov_10a_exp",
    filters: { geo: ["PL", "EU27_2020"], unit: "PC_GDP", sector: "S13", cofog99: "GF02", na_item: "TE" },
    topics: ["obronnosc", "wydatki-na-obrone", "nato", "gospodarka"],
    from: "2007",
    sentence: (p) =>
      `W ${p.time} r. wydatki sektora instytucji rządowych i samorządowych na obronę narodową (klasyfikacja COFOG GF02) ${geoName(p.dims.geo!)} wyniosły ${num(p.value)}% PKB (Eurostat, zbiór gov_10a_exp)${flagNote(p.flag)}.`,
  },
  {
    dataset: "gov_10a_exp",
    filters: { geo: "PL", unit: "MIO_EUR", sector: "S13", cofog99: "GF02", na_item: "TE" },
    topics: ["obronnosc", "wydatki-na-obrone", "gospodarka"],
    from: "2007",
    sentence: (p) =>
      `W ${p.time} r. wydatki sektora instytucji rządowych i samorządowych na obronę narodową (klasyfikacja COFOG GF02) w Polsce wyniosły ${num(p.value)} mln euro (Eurostat, zbiór gov_10a_exp)${flagNote(p.flag)}.`,
  },
  {
    dataset: "nrg_ind_id",
    filters: { geo: ["PL", "EU27_2020"], siec: "TOTAL", unit: "PC" },
    topics: ["energia", "zaleznosc-energetyczna", "import-energii"],
    from: "2015",
    sentence: (p) =>
      `W ${p.time} r. zależność importowa energii (udział importu netto w zużyciu energii brutto, wszystkie nośniki łącznie) ${geoName(p.dims.geo!)} wyniosła ${num(p.value)}%` +
      (p.value < 0 ? " (wartość ujemna oznacza eksport netto)" : "") +
      ` (Eurostat, zbiór nrg_ind_id)${flagNote(p.flag)}.`,
  },
  {
    dataset: "nrg_ti_gas",
    filters: { geo: "PL", partner: "RU", siec: "G3000", unit: "MIO_M3" },
    topics: ["energia", "gaz", "rosja", "import-gazu", "zaleznosc-energetyczna"],
    from: "2015",
    sentence: (p) =>
      `W ${p.time} r. Polska zaimportowała z Rosji ${num(p.value)} mln m3 gazu ziemnego (Eurostat, zbiór nrg_ti_gas)${flagNote(p.flag)}.`,
  },
  {
    dataset: "nrg_ind_ren",
    filters: { geo: "PL", nrg_bal: "REN" },
    topics: ["energia", "odnawialne-zrodla-energii", "gospodarka"],
    from: "2015",
    sentence: (p) =>
      `W ${p.time} r. udział energii ze źródeł odnawialnych w końcowym zużyciu energii brutto w Polsce wyniósł ${num(p.value)}% (Eurostat, zbiór nrg_ind_ren)${flagNote(p.flag)}.`,
  },
  {
    dataset: "prc_hicp_aind",
    filters: { geo: ["PL", "EU27_2020", "DE"], coicop: "CP00", unit: "RCH_A_AVG" },
    topics: ["gospodarka", "inflacja", "polska"],
    from: "2008",
    sentence: (p) =>
      `W ${p.time} r. średnioroczna inflacja HICP (zharmonizowany wskaźnik cen konsumpcyjnych) ${geoName(p.dims.geo!)} wyniosła ${num(p.value)}% (Eurostat, zbiór prc_hicp_aind)${flagNote(p.flag)}.`,
  },
  {
    // Najnowsze okresy: roczna zmiana HICP w ujęciu miesięcznym (ostatnie 26 miesięcy).
    dataset: "prc_hicp_manr",
    filters: { geo: ["PL", "EU27_2020"], coicop: "CP00" },
    topics: ["gospodarka", "inflacja", "polska"],
    from: monthsAgo(26),
    sentence: (p) =>
      `${monthLabel(p.time)} roczna inflacja HICP (zmiana cen konsumpcyjnych względem tego samego miesiąca roku poprzedniego) ${geoName(p.dims.geo!)} wyniosła ${num(p.value)}% (Eurostat, zbiór prc_hicp_manr)${flagNote(p.flag)}.`,
  },
  {
    dataset: "une_rt_a",
    filters: { geo: ["PL", "EU27_2020", "DE"], age: "Y15-74", sex: "T", unit: "PC_ACT" },
    topics: ["gospodarka", "bezrobocie", "polska"],
    from: "2008",
    sentence: (p) =>
      `W ${p.time} r. stopa bezrobocia osób w wieku 15-74 lata ${geoName(p.dims.geo!)} wyniosła ${num(p.value)}% aktywnych zawodowo (Eurostat, zbiór une_rt_a)${flagNote(p.flag)}.`,
  },
  {
    // Najnowsze okresy: stopa bezrobocia (BAEL), dane miesięczne wyrównane sezonowo (ostatnie 26 miesięcy).
    dataset: "une_rt_m",
    filters: { geo: ["PL", "EU27_2020"], age: "TOTAL", sex: "T", unit: "PC_ACT", s_adj: "SA" },
    topics: ["gospodarka", "bezrobocie", "polska"],
    from: monthsAgo(26),
    sentence: (p) =>
      `${monthLabel(p.time)} stopa bezrobocia (BAEL, dane wyrównane sezonowo, osoby w wieku 15-74 lata) ${geoName(p.dims.geo!)} wyniosła ${num(p.value)}% aktywnych zawodowo (Eurostat, zbiór une_rt_m)${flagNote(p.flag)}.`,
  },
  {
    dataset: "demo_pjan",
    filters: { geo: ["PL", "EU27_2020", "DE"], age: "TOTAL", sex: "T" },
    topics: ["demografia", "ludnosc", "polska"],
    from: "2008",
    sentence: (p) =>
      `Na dzień 1 stycznia ${p.time} r. ${geoName(p.dims.geo!)} mieszkało ${num(p.value)} osób (Eurostat, zbiór demo_pjan)${flagNote(p.flag)}.`,
  },
];

function buildUrl(spec: SeriesSpec): string {
  const params = new URLSearchParams();
  params.set("format", "JSON");
  params.set("lang", "EN");
  for (const [k, v] of Object.entries(spec.filters)) for (const x of Array.isArray(v) ? v : [v]) params.append(k, x);
  return `${API}${spec.dataset}?${params.toString()}`;
}

/** Rozwija jednowymiarowy JSON-stat do listy punktów. */
export function jsonStatPoints(js: JsonStat): Point[] {
  const out: Point[] = [];
  const ids = js.id;
  const sizes = js.size;
  const cats = ids.map((d) => {
    const idx = js.dimension[d]!.category.index;
    const byPos: string[] = [];
    for (const [code, pos] of Object.entries(idx)) byPos[pos] = code;
    return byPos;
  });
  for (const [k, v] of Object.entries(js.value)) {
    let n = Number(k);
    const dims: Record<string, string> = {};
    for (let i = ids.length - 1; i >= 0; i--) {
      const size = sizes[i]!;
      dims[ids[i]!] = cats[i]![n % size]!;
      n = Math.floor(n / size);
    }
    out.push({ dims, time: dims.time!, value: v, flag: js.status?.[k] });
  }
  return out;
}

export async function ingestEurostat(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("eurostat");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "eurostat");
  const base = baseFromCatalog(src);

  for (const spec of SERIES) {
    const url = buildUrl(spec);
    try {
      const { data, res } = await client.getJson<JsonStat>(url);
      const all = jsonStatPoints(data).filter((p) => p.time >= spec.from);
      const maxTime = all.reduce((m, p) => (p.time > m ? p.time : m), "");
      const points = all
        .filter((p) => (spec.onlyTimes ? spec.onlyTimes(p.time) || p.time === maxTime : true))
        .sort((a, b) => (a.time < b.time ? -1 : 1));
      const updatedIso = data.updated ? new Date(data.updated).toISOString() : null;
      const emit = (sentence: string, time: string, geo: string, dimsKey: string) => {
        const rec: CorpusRecord = {
          ...base,
          id: recordId("eurostat", `${spec.dataset}|${dimsKey}|${geo}|${time}`),
          url,
          title: `Eurostat: ${data.label} — ${geo === "PL" ? "Polska" : geo === "EU27_2020" ? "UE-27" : geo === "DE" ? "Niemcy" : geo}, ${time}`,
          publishedAt: updatedIso,
          fetchedAt: res.fetchedAt,
          lang: "pl",
          text: sentence,
          topics: [...spec.topics, "generated-from-data", "statystyka", "eurostat"],
          period: time,
          origin: "corpus",
        };
        result.records.push(rec);
      };
      const ctxFor = () => ({ series: data, geoLabel: "" });
      if (spec.combine) {
        const groups = new Map<string, Point[]>();
        for (const p of points) {
          const key = spec.groupBy!(p);
          groups.set(key, [...(groups.get(key) ?? []), p]);
        }
        for (const [key, pts] of groups) {
          const c = spec.combine(pts, { series: data });
          if (c) emit(c.sentence, c.time, pts[0]!.dims.geo ?? "PL", key);
        }
      } else {
        for (const p of points) {
          const s = spec.sentence(p, ctxFor());
          if (s) emit(s, p.time, p.dims.geo ?? "PL", JSON.stringify(p.dims));
        }
      }
      opts.log(`  Eurostat ${spec.dataset}: ${points.length} punktów`);
    } catch (e) {
      result.skipped.push({ what: `Eurostat ${spec.dataset}`, reason: (e as Error).message });
    }
  }
  result.requests = client.requests;
  result.notes.push(
    "Zdania wygenerowane z wartości API (tag generated-from-data); liczby dokładnie jak w odpowiedzi, flagi 'p'/'e' opisane w tekście. publishedAt = pole 'updated' zbioru.",
  );
  return result;
}
