/**
 * Ingestia metadanych bazy EUvsDisinfo (East StratCom Task Force, EEAS).
 * Z tokenem EUVSDISINFO_MCP_TOKEN korzysta z MCP, bez tokenu z publicznej listy HTML.
 *
 * Ograniczenia, które respektujemy (i dokumentujemy w docs/SOURCES.md):
 *  - strony szczegółowe /report/... zwracają HTTP 403 (wyzwanie antybotowe) — NIE są pobierane,
 *  - paginacja /page/N/ jest zabroniona w robots.txt — bierzemy tylko pierwszą stronę wyników każdego hasła,
 *  - licencja otwarta nie jest potwierdzona — zapisujemy wyłącznie tytuł tezy (dosłownie z listy), datę i link.
 * Rekord ma rolę stala_rola: ocena "DISINFO" (prefiks wpisu) mapowana przez data/rating-map.yaml.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { readCorpus } from "../files";
import { mapRating } from "../ratings";
import { PoliteClient, type Incident, type IngestOptions, type IngestResult, baseFromCatalog, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";
import { ingestEuvsdisinfoMcp } from "./euvsdisinfo-mcp";

const SEARCH_TERMS: { q: string; topics: string[] }[] = [
  { q: "Poland", topics: ["polska"] },
  { q: "Polish", topics: ["polska"] },
  { q: "Warsaw", topics: ["polska"] },
  { q: "Poland Ukraine", topics: ["polska", "ukraina"] },
  { q: "Poland NATO", topics: ["polska", "nato"] },
  { q: "Poland EU", topics: ["polska", "ue"] },
  { q: "Belarus border migrants", topics: ["bialorus", "migracja", "granica"] },
  { q: "Ukrainian refugees", topics: ["uchodzcy", "ukraina", "migracja"] },
  { q: "sanctions Russia", topics: ["sankcje", "rosja"] },
  { q: "NATO expansion", topics: ["nato", "rozszerzenie-nato"] },
  { q: "Baltic states", topics: ["panstwa-baltyckie"] },
  { q: "Lithuania", topics: ["litwa", "panstwa-baltyckie"] },
  { q: "elections interference", topics: ["wybory", "ingerencja"] },
  { q: "Ukraine war Europe", topics: ["ukraina", "wojna-w-ukrainie", "ue"] },
  { q: "energy gas Europe", topics: ["energia", "gaz", "ue"] },
  { q: "drones Poland", topics: ["polska", "drony"] },
  // Narracje FIMI dot. wojny w Ukrainie: MH17, Bucza, "biolaby", Nord Stream, Wołyń, Majdan.
  { q: "MH17", topics: ["mh17", "ukraina", "rosja", "wojna-w-ukrainie"] },
  { q: "Bucha", topics: ["bucza", "ukraina", "rosja", "zbrodnie-wojenne", "wojna-w-ukrainie"] },
  { q: "biolabs", topics: ["biolaby", "bron-biologiczna", "ukraina", "usa", "wojna-w-ukrainie"] },
  { q: "biological weapons Ukraine", topics: ["biolaby", "bron-biologiczna", "ukraina", "usa", "wojna-w-ukrainie"] },
  { q: "Nord Stream", topics: ["nord-stream", "energia", "gaz", "sabotaz"] },
  { q: "Volhynia", topics: ["wolyn", "polska", "ukraina"] },
  { q: "Maidan coup", topics: ["majdan", "ukraina", "wojna-w-ukrainie"] },
  { q: "Ukraine neo-Nazi", topics: ["ukraina", "denazyfikacja", "wojna-w-ukrainie"] },
];

interface ListEntry {
  href: string;
  date: string | null;
  prefix: string;
  title: string;
}

function isoFromDots(d: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function parseCases(html: string): ListEntry[] {
  const { document } = parseHtmlPage(html);
  const out: ListEntry[] = [];
  for (const a of Array.from(document.querySelectorAll("a.b-archive__database-item"))) {
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/report/")) continue;
    const prefix = squash(a.querySelector(".b-archive__database-item-prefix")?.textContent ?? "").replace(/:$/, "");
    const full = squash(a.querySelector(".b-archive__database-item-title")?.textContent ?? "");
    const title = prefix && full.startsWith(prefix + ":") ? squash(full.slice(prefix.length + 1)) : full;
    out.push({ href, date: isoFromDots(squash(a.querySelector(".b-archive__database-item-date")?.textContent ?? "")), prefix, title });
  }
  return out;
}

const TAGS: [string, RegExp][] = [
  ["polska", /\bPol(?:and|ish|es)\b|Warsaw/i],
  ["nato", /\bNATO\b/i],
  ["ue", /\bEU\b|European Union|Brussels/i],
  ["ukraina", /Ukrain|Kyiv|Zelensk/i],
  ["rosja", /Russia|Putin|Kremlin/i],
  ["bialorus", /Belarus|Lukashenk/i],
  ["sankcje", /sanction/i],
  ["migracja", /migrant|refugee/i],
  ["panstwa-baltyckie", /Baltic|Lithuan|Latvia|Estonia/i],
  ["wybory", /election|vote/i],
  ["energia", /\bgas\b|\boil\b|energy/i],
];

export async function ingestEuvsdisinfo(opts: IngestOptions): Promise<IngestResult> {
  const token = process.env.EUVSDISINFO_MCP_TOKEN?.trim();
  return preserveEuvsdisinfoSnapshot(token ? await ingestEuvsdisinfoMcp(opts, token) : await ingestEuvsdisinfoHtml(opts));
}

/** Wspólny snapshot: dostępność MCP i limit pobrania nie usuwają wcześniej zindeksowanych przypadków. */
export function preserveEuvsdisinfoSnapshot(result: IngestResult, readSaved = readCorpus): IngestResult {
  if (result.records.length === 0) return result;
  const saved = readSaved();
  if (saved.errors.some((error) => error.startsWith("euvsdisinfo.jsonl:"))) {
    throw new Error("Nieprawidłowy zapisany snapshot EUvsDisinfo");
  }
  const records = new Map(
    saved.records.filter((record) => record.sourceId === result.id && record.origin === "corpus").map((record) => [record.id, record]),
  );
  const incidents = new Map(
    saved.incidents.filter((incident) => incident.id === incident.recordId && records.has(incident.id)).map((incident) => [incident.id, incident]),
  );
  const updated = new Set<string>();
  for (const record of result.records) {
    // Rekord z publicznej listy zachowuje dosłowną etykietę widoczną przy wpisie.
    if (records.get(record.id)?.rating && !record.rating) continue;
    records.set(record.id, record);
    updated.add(record.id);
  }
  for (const incident of result.incidents) {
    if (!incidents.has(incident.id) || (incident.recordId && updated.has(incident.recordId))) incidents.set(incident.id, incident);
  }
  return { ...result, records: [...records.values()], incidents: [...incidents.values()] };
}

async function ingestEuvsdisinfoHtml(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("euvsdisinfo");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "euvsdisinfo");
  const base = baseFromCatalog(src);
  const seen = new Set<string>();
  const prefixes: Record<string, number> = {};

  for (const term of SEARCH_TERMS) {
    const url = `https://euvsdisinfo.eu/disinformation-cases/?text=${encodeURIComponent(term.q)}`;
    try {
      const res = await client.get(url);
      const entries = parseCases(res.body);
      let added = 0;
      for (const e of entries) {
        prefixes[e.prefix] = (prefixes[e.prefix] ?? 0) + 1;
        if (e.prefix !== "DISINFO") continue; // tylko wpisy sklasyfikowane jako dezinformacja
        if (seen.has(e.href)) continue;
        seen.add(e.href);
        const caseUrl = `https://euvsdisinfo.eu${e.href}`;
        const tags = new Set<string>(term.topics);
        for (const [tag, re] of TAGS) if (re.test(e.title)) tags.add(tag);
        const rec: CorpusRecord = {
          ...base,
          id: recordId("euvsdisinfo", e.href),
          url: caseUrl,
          title: `EUvsDisinfo: ${e.title}`,
          publishedAt: e.date,
          fetchedAt: res.fetchedAt,
          lang: "en",
          text: `${e.prefix}: ${e.title}`,
          claimReviewed: e.title,
          rating: mapRating("euvsdisinfo", e.prefix),
          topics: ["dezinformacja", "euvsdisinfo", "narracja-prorosyjska", ...tags],
          origin: "corpus",
        };
        result.records.push(rec);
        const inc: Incident = {
          id: `euvsdisinfo:${rec.id.split(":")[1]}`,
          title: e.title,
          summary: `EUvsDisinfo (EEAS) klasyfikuje tę narrację jako dezinformację (wpis "DISINFO"). Strona wpisu z opisem i źródłami jest dostępna pod podanym adresem.`,
          url: caseUrl,
          domains: [], // lista serwisów jest tylko na stronie szczegółowej wpisu (HTTP 403 dla botów)
          publishedAt: e.date,
          recordId: rec.id,
        };
        result.incidents.push(inc);
        added++;
      }
      opts.log(`  EUvsDisinfo "${term.q}": ${entries.length} wpisów na stronie, nowych ${added}`);
    } catch (e) {
      result.skipped.push({ what: `${url}`, reason: (e as Error).message });
    }
  }
  result.requests = client.requests;
  result.notes.push(
    `Prefiksy wpisów na pierwszych stronach wyników: ${Object.entries(prefixes).map(([k, v]) => `${k || "(brak)"}=${v}`).join(", ")}; zapisujemy tylko DISINFO. Strony /report/ (HTTP 403) i paginacja (/page/N/, robots.txt) pominięte.`,
  );
  return result;
}
