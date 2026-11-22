/**
 * Importer pakietu organizatora (lista źródeł + baza incydentów). Pakiet NIE jest jeszcze opublikowany,
 * więc importer jest napisany względem udokumentowanego, konfigurowalnego kształtu wejścia (patrz niżej)
 * i sprawdzony na próbce w src/corpus/fixtures/. Po publikacji pakietu wystarczy dopasować mapowanie pól
 * (plik JSON przekazany przez --mapping) — bez zmian w kodzie.
 *
 * OCZEKIWANY KSZTAŁT (JSON: tablica obiektów albo obiekt z tablicą w polu sources/items/data/records/incidents;
 * CSV: pierwszy wiersz = nagłówki, separator , ; lub tabulator, cudzysłowy RFC 4180):
 *
 *  Lista źródeł — jeden wiersz = jedno źródło:
 *    host | domain | hosts | url        dokładny host (hosts: lista rozdzielona , ; | albo tablica; z url bierzemy hostname)
 *    publisher | name | nazwa | wydawca nazwa wydawcy
 *    type | typ | category               pierwotne | factcheck | analiza (rozpoznajemy też: primary/official/gov, fact-check, analysis/think tank)
 *    level | poziom                     1-3 (brak => domyślnie z typu: pierwotne 1, factcheck 2, analiza 3)
 *    licence | license | licencja       licencja (brak => adnotacja "do uzupełnienia")
 *    ifcn | ifcn_efcsn | signatory      true/tak/yes => ifcnEfcsn
 *    homepage | website                 adres strony głównej (brak => https://<host>/)
 *
 *  Baza incydentów — jeden wiersz = jeden incydent / zweryfikowana informacja:
 *    claim | claimReviewed | title | teza | narrative    teza (dosłownie)
 *    summary | description | text | opis | explanation    uzasadnienie / opis (dosłownie)
 *    url | link | source_url                             adres strony z opisem
 *    date | published | published_at | data               data publikacji (ISO albo DD.MM.RRRR); nieczytelna => null
 *    rating | verdict | label | ocena | werdykt           ocena (mapowana tabelą data/rating-map.yaml; nieznana => null)
 *    domains | outlets | sites | domeny                   serwisy rozpowszechniające narrację (lista lub tablica)
 *    id | uuid                                           stabilny identyfikator organizatora (opcjonalnie)
 *    lang | language | jezyk                             język (brak => wykrywany)
 *
 * Zasady: poziom, typ i rola rekordu wynikają z KATALOGU po dokładnym hoście URL-a rekordu; jeśli host nie jest
 * w katalogu, importer dopisuje źródło "organizer-base" (host rekordu, domyślnie poziom 2, typ factcheck,
 * rola stala_rola — baza organizatora jest rozstrzygająca wg PLAN §4) do data/sources.organizer.yaml.
 * Importer niczego nie wymyśla: pola, których nie ma w pakiecie, zostają puste lub null.
 *
 * Użycie: tsx src/corpus/import-organizer.ts --sources <plik> --incidents <plik> [--mapping m.json] [--data-dir dir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CorpusRecord, CatalogSource, type SourceLevel, type SourceType } from "../shared/contracts";
import { clearCatalogCache, loadCatalog, normalizeHost, sourceAtUrl } from "./catalog";
import { guessLang, recordId, squash, writeJsonl } from "./ingest/common";
import { paths } from "./paths";
import { mapRating } from "./ratings";
import { IncidentRecord } from "./types";
import { outletChannel, outletHost } from "./incident-outlets";

// ───────────────────────────── Wczytywanie tabel ─────────────────────────────

export type Row = Record<string, unknown>;

export function parseCsv(text: string): Row[] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", "\t", ","].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export function parseTable(content: string, format: "json" | "csv"): Row[] {
  if (format === "csv") return parseCsv(content);
  const data = JSON.parse(content) as unknown;
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    for (const k of ["sources", "items", "data", "records", "incidents", "results"]) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Row[];
    }
  }
  throw new Error("JSON musi być tablicą obiektów albo obiektem z tablicą w polu sources/items/data/records/incidents");
}

export function detectFormat(file: string, content: string): "json" | "csv" {
  if (/\.json$/i.test(file)) return "json";
  if (/\.csv$/i.test(file) || /\.tsv$/i.test(file)) return "csv";
  return content.trimStart().startsWith("[") || content.trimStart().startsWith("{") ? "json" : "csv";
}

// ───────────────────────────── Mapowanie pól ─────────────────────────────

export interface FieldAliases {
  [target: string]: string[];
}

export const SOURCE_ALIASES: FieldAliases = {
  host: ["host", "domain", "domena", "hosts", "url", "link", "website"],
  publisher: ["publisher", "name", "nazwa", "wydawca", "organization", "organisation"],
  type: ["type", "typ", "category", "kategoria"],
  level: ["level", "poziom"],
  licence: ["licence", "license", "licencja"],
  ifcn: ["ifcn", "ifcn_efcsn", "ifcnEfcsn", "signatory", "sygnatariusz"],
  homepage: ["homepage", "website", "strona"],
};

export const INCIDENT_ALIASES: FieldAliases = {
  claim: ["claim", "claimReviewed", "claim_reviewed", "title", "teza", "narrative", "headline"],
  summary: ["summary", "description", "text", "opis", "explanation", "body"],
  url: ["url", "link", "source_url", "href"],
  date: ["date", "published", "published_at", "publishedAt", "data", "datePublished"],
  rating: ["rating", "verdict", "label", "ocena", "werdykt", "textualRating"],
  domains: ["domains", "outlets", "sites", "domeny", "spread_by"],
  channels: ["channels", "channel_urls", "kanały", "kanaly"],
  id: ["id", "uuid"],
  lang: ["lang", "language", "jezyk"],
};

export interface ImportMapping {
  sources?: FieldAliases;
  incidents?: FieldAliases;
}

function getPath(row: Row, path: string): unknown {
  const direct = Object.keys(row).find((k) => k.toLowerCase() === path.toLowerCase());
  if (direct !== undefined) return row[direct];
  if (path.includes(".")) {
    let cur: unknown = row;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object") {
        const key = Object.keys(cur as Row).find((k) => k.toLowerCase() === part.toLowerCase());
        cur = key !== undefined ? (cur as Row)[key] : undefined;
      } else return undefined;
    }
    return cur;
  }
  return undefined;
}

export function pick(row: Row, aliases: string[]): unknown {
  for (const a of aliases) {
    const v = getPath(row, a);
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = squash(String(v));
  return s === "" ? undefined : s;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => squash(String(x))).filter(Boolean);
  const s = str(v);
  return s ? s.split(/[,;|]/).map((x) => x.trim()).filter(Boolean) : [];
}

function truthy(v: unknown): boolean {
  return /^(1|true|tak|yes|y|t)$/i.test(String(v ?? "").trim());
}

export function toIsoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const pl = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(s);
  if (pl) return `${pl[3]}-${pl[2]!.padStart(2, "0")}-${pl[1]!.padStart(2, "0")}`;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(s);
  if (iso) return s.length > 10 ? s : iso[1]!;
  return null;
}

function hostOf(v: string): string | null {
  const h = normalizeHost(v.includes("://") ? v : `https://${v}`);
  return h && h.includes(".") ? h : null;
}

export function normalizeType(raw: string | undefined, fallback: SourceType = "factcheck"): SourceType {
  const s = (raw ?? "").toLowerCase();
  if (/pierwot|primary|official|urz[eę]d|gov|institution/.test(s)) return "pierwotne";
  if (/fact|weryfik|demaskuj|debunk/.test(s)) return "factcheck";
  if (/analiz|analys|think|research|report|raport/.test(s)) return "analiza";
  return fallback;
}

const DEFAULT_LEVEL: Record<SourceType, SourceLevel> = { pierwotne: 1, factcheck: 2, analiza: 3 };

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ───────────────────────────── Import listy źródeł ─────────────────────────────

export interface SourceImportResult {
  sources: CatalogSource[];
  skipped: { row: number; reason: string }[];
}

export function importSourceList(rows: Row[], mapping: ImportMapping = {}, existing: CatalogSource[] = []): SourceImportResult {
  const alias = { ...SOURCE_ALIASES, ...(mapping.sources ?? {}) };
  const taken = new Set(existing.flatMap((s) => s.hosts));
  const ids = new Set(existing.map((s) => s.id));
  const out: CatalogSource[] = [];
  const skipped: { row: number; reason: string }[] = [];
  rows.forEach((row, idx) => {
    const hostValues = list(pick(row, alias.host!));
    const hosts = [...new Set(hostValues.map(hostOf).filter((h): h is string => !!h))];
    if (hosts.length === 0) {
      skipped.push({ row: idx + 1, reason: "brak czytelnego hosta" });
      return;
    }
    const fresh = hosts.filter((h) => !taken.has(h));
    if (fresh.length === 0) {
      skipped.push({ row: idx + 1, reason: `host już w katalogu (${hosts.join(", ")}) — obowiązuje istniejący wpis` });
      return;
    }
    const publisher = str(pick(row, alias.publisher!)) ?? fresh[0]!;
    const type = normalizeType(str(pick(row, alias.type!)));
    const levelRaw = Number(str(pick(row, alias.level!)));
    const level = (levelRaw === 1 || levelRaw === 2 || levelRaw === 3 ? levelRaw : DEFAULT_LEVEL[type]) as SourceLevel;
    let id = `org-${slug(publisher)}`;
    for (let n = 2; ids.has(id); n++) id = `org-${slug(publisher)}-${n}`;
    ids.add(id);
    for (const h of fresh) taken.add(h);
    const src: CatalogSource = {
      id,
      hosts: fresh,
      publisher,
      type,
      level,
      role: type === "factcheck" ? "stala_rola" : "tresc",
      independenceGroup: id,
      licence: str(pick(row, alias.licence!)) ?? "Pakiet organizatora — licencja do uzupełnienia po publikacji regulaminu pakietu",
      fetchMethod: "organizer-pack",
      updateFrequency: "wg pakietu organizatora",
      qualification: "Źródło z listy organizatora konkursu (import pakietu); poziom i typ wg pakietu lub domyślne dla typu.",
      exclusion: "Wg zasad organizatora; rekordy bez daty i bez adresu są pomijane.",
      homepage: str(pick(row, alias.homepage!)) && /^https?:\/\//.test(String(pick(row, alias.homepage!))) ? String(pick(row, alias.homepage!)).trim() : `https://${fresh[0]}/`,
      nonEea: false,
      ifcnEfcsn: truthy(pick(row, alias.ifcn!)),
      // Ta sama reguła co w data/sources.yaml (catalog.test.ts): live.ts wymaga liveSearch=true.
      liveSearch: type === "pierwotne" || (type === "factcheck" && truthy(pick(row, alias.ifcn!))),
    };
    out.push(CatalogSource.parse(src));
  });
  return { sources: out, skipped };
}

// ───────────────────────────── Import bazy incydentów ─────────────────────────────

export interface IncidentImportOptions {
  /** Moment importu (ISO) — zapisywany jako fetchedAt. */
  importedAt: string;
  catalog: CatalogSource[];
  dataDir?: string;
}

export interface IncidentImportResult {
  records: CorpusRecord[];
  incidents: IncidentRecord[];
  /** Źródła, które trzeba dopisać do katalogu (hosty spoza katalogu). */
  newSources: CatalogSource[];
  skipped: { row: number; reason: string }[];
}

export const ORGANIZER_BASE_ID = "organizer-base";

export function importIncidentBase(rows: Row[], mapping: ImportMapping, opts: IncidentImportOptions): IncidentImportResult {
  const alias = { ...INCIDENT_ALIASES, ...(mapping.incidents ?? {}) };
  const records: CorpusRecord[] = [];
  const incidents: IncidentRecord[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const unknownHosts = new Set<string>();
  const catalog = [...opts.catalog];
  const findSource = (host: string): CatalogSource | undefined => catalog.find((s) => s.hosts.includes(host));
  const seen = new Set<string>();

  // Pierwszy przebieg: zbierz hosty spoza katalogu.
  const parsed = rows.map((row, idx) => {
    const url = str(pick(row, alias.url!));
    const claim = str(pick(row, alias.claim!));
    return { row, idx, url, claim };
  });
  for (const p of parsed) {
    if (!p.url || !p.claim || !/^https?:\/\//iu.test(p.url)) continue;
    const h = hostOf(p.url);
    if (h && !findSource(h)) unknownHosts.add(h);
  }
  const newSources: CatalogSource[] = [];
  if (unknownHosts.size > 0) {
    const base = catalog.find((s) => s.id === ORGANIZER_BASE_ID);
    if (base) {
      const merged = CatalogSource.parse({ ...base, hosts: [...new Set([...base.hosts, ...unknownHosts])] });
      catalog[catalog.indexOf(base)] = merged;
      newSources.push(merged);
    } else {
      const fresh = CatalogSource.parse({
        id: ORGANIZER_BASE_ID,
        hosts: [...unknownHosts],
        publisher: "Baza zweryfikowanych informacji organizatora",
        type: "factcheck",
        level: 2,
        role: "stala_rola",
        independenceGroup: ORGANIZER_BASE_ID,
        licence: "Pakiet organizatora — wykorzystanie zgodnie z regulaminem konkursu (do uzupełnienia po publikacji pakietu)",
        fetchMethod: "organizer-pack",
        updateFrequency: "wg pakietu organizatora",
        qualification: "Baza organizatora konkursu (zweryfikowane informacje / incydenty); rekordy o stałej roli (PLAN §4).",
        exclusion: "Rekordy bez adresu, tezy lub czytelnej oceny nie rozstrzygają.",
        homepage: `https://${[...unknownHosts][0]}/`,
        nonEea: false,
        ifcnEfcsn: false,
      });
      catalog.push(fresh);
      newSources.push(fresh);
    }
  }

  for (const { row, idx, url, claim } of parsed) {
    if (!url || !claim) {
      skipped.push({ row: idx + 1, reason: !url ? "brak adresu URL" : "brak tezy" });
      continue;
    }
    try {
      new URL(url);
    } catch {
      skipped.push({ row: idx + 1, reason: "nieprawidłowy URL" });
      continue;
    }
    const src = sourceAtUrl(catalog, url);
    if (!src) {
      skipped.push({ row: idx + 1, reason: "adres poza dozwolonym zakresem źródła" });
      continue;
    }
    const summary = str(pick(row, alias.summary!));
    const ratingRaw = str(pick(row, alias.rating!));
    const given = str(pick(row, alias.id!));
    const key = given ?? `${url}|${claim}`;
    const id = recordId(src.id, key);
    if (seen.has(id)) {
      skipped.push({ row: idx + 1, reason: "duplikat identyfikatora" });
      continue;
    }
    seen.add(id);
    const text = summary && summary !== claim ? `${claim}\n${summary}`.slice(0, 1500) : claim;
    const isFixed = src.role === "stala_rola";
    const rec: CorpusRecord = CorpusRecord.parse({
      id,
      sourceId: src.id,
      url,
      title: claim.length > 160 ? `${claim.slice(0, 157)}...` : claim,
      publisher: src.publisher,
      publishedAt: toIsoDate(pick(row, alias.date!)),
      fetchedAt: opts.importedAt,
      lang: str(pick(row, alias.lang!)) ?? guessLang(claim),
      text,
      role: src.role,
      type: src.type,
      level: src.level,
      independenceGroup: src.independenceGroup,
      licence: src.licence,
      claimReviewed: isFixed ? claim : undefined,
      rating: isFixed && ratingRaw ? mapRating(src.id, ratingRaw, opts.dataDir) : undefined,
      topics: ["pakiet-organizatora"],
      origin: "organizer",
    });
    records.push(rec);
    incidents.push(
      IncidentRecord.parse({
        id: `organizer:${id.split(":")[1]}`,
        title: claim.slice(0, 300),
        summary: summary ?? `Pozycja z bazy organizatora${ratingRaw ? ` (ocena: ${ratingRaw})` : ""}.`,
        url,
        domains: list(pick(row, alias.domains!)).flatMap(value => outletHost(value) ?? []),
        channels: list(pick(row, alias.channels!)).flatMap(value => outletChannel(value, true) ?? []),
        publishedAt: rec.publishedAt,
        recordId: rec.id,
      }),
    );
  }
  return { records, incidents, newSources, skipped };
}

// ───────────────────────────── CLI ─────────────────────────────

export interface ImportCliArgs {
  sources?: string;
  incidents?: string;
  mapping?: string;
  dataDir?: string;
}

export function runImport(args: ImportCliArgs, log: (m: string) => void = console.log): void {
  const mapping: ImportMapping = args.mapping ? (JSON.parse(readFileSync(args.mapping, "utf8")) as ImportMapping) : {};
  const dataDir = args.dataDir;
  const readRows = (file: string): Row[] => {
    const content = readFileSync(file, "utf8");
    return parseTable(content, detectFormat(file, content));
  };
  const organizerYaml = paths.organizerSourcesYaml(dataDir);
  let organizerSources: CatalogSource[] = [];
  if (existsSync(organizerYaml)) {
    organizerSources = CatalogSource.array().parse(parseYaml(readFileSync(organizerYaml, "utf8")) ?? []);
  }
  clearCatalogCache();

  if (args.sources) {
    const catalog = loadCatalog(dataDir);
    const res = importSourceList(readRows(args.sources), mapping, catalog);
    organizerSources = [...organizerSources, ...res.sources];
    log(`Źródła: zaimportowano ${res.sources.length}, pominięto ${res.skipped.length}`);
    for (const s of res.skipped) log(`  wiersz ${s.row}: ${s.reason}`);
  }
  if (args.incidents) {
    // Katalog łącznie z już zapisanymi wpisami organizatora (nowe hosty zostaną dopisane do źródła organizer-base).
    const base = loadCatalog(dataDir).filter((s) => !organizerSources.some((o) => o.id === s.id));
    const catalog = [...base, ...organizerSources];
    const res = importIncidentBase(readRows(args.incidents), mapping, { importedAt: new Date().toISOString(), catalog, dataDir });
    for (const ns of res.newSources) organizerSources = [...organizerSources.filter((o) => o.id !== ns.id), ns];
    mkdirSync(paths.corpusDir(dataDir), { recursive: true });
    mkdirSync(paths.incidentsDir(dataDir), { recursive: true });
    // Rekordy organizatora trafiają do osobnych plików, więc ponowny import je zastępuje (idempotentnie).
    const byFile = new Map<string, CorpusRecord[]>();
    for (const r of res.records) byFile.set(`organizer-${r.sourceId.replace(/^organizer-/, "")}`, [...(byFile.get(`organizer-${r.sourceId.replace(/^organizer-/, "")}`) ?? []), r]);
    const incidentFile = resolve(paths.incidentsDir(dataDir), "organizer.jsonl");
    // Reset also the per-source files owned by the previous edition of this pack.
    if (existsSync(incidentFile)) {
      for (const line of readFileSync(incidentFile, "utf8").split("\n").filter(Boolean)) {
        const sourceId = IncidentRecord.parse(JSON.parse(line)).recordId?.split(":")[0];
        if (!sourceId || !/^[\w.-]+$/.test(sourceId)) continue;
        const previous = `organizer-${sourceId.replace(/^organizer-/, "")}`;
        if (!byFile.has(previous)) byFile.set(previous, []);
      }
    }
    for (const [name, recs] of byFile) writeJsonl(resolve(paths.corpusDir(dataDir), `${name}.jsonl`), recs.sort((a, b) => (a.id < b.id ? -1 : 1)));
    writeJsonl(incidentFile, res.incidents.sort((a, b) => (a.id < b.id ? -1 : 1)));
    log(`Incydenty: ${res.records.length} rekordów, pominięto ${res.skipped.length}; nowe źródła w katalogu: ${res.newSources.map((s) => s.id).join(", ") || "brak"}`);
    for (const s of res.skipped.slice(0, 20)) log(`  wiersz ${s.row}: ${s.reason}`);
  }
  if (organizerSources.length > 0) {
    writeFileSync(
      organizerYaml,
      `# Źródła z pakietu organizatora — plik generowany przez src/corpus/import-organizer.ts (nie edytuj ręcznie).\n${stringifyYaml(organizerSources)}`,
    );
    clearCatalogCache();
    log(`Zapisano ${organizerSources.length} wpisów katalogu: ${organizerYaml}`);
  }
  log("Gotowe. Uruchom npm run corpus:load, aby załadować dane do bazy.");
}

export function parseCliArgs(argv: string[]): ImportCliArgs {
  const a: ImportCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--sources") a.sources = argv[++i];
    else if (k === "--incidents") a.incidents = argv[++i];
    else if (k === "--mapping") a.mapping = argv[++i];
    else if (k === "--data-dir") a.dataDir = argv[++i];
  }
  return a;
}

const isMain = process.argv[1] && /import-organizer\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.sources && !args.incidents) {
    console.error("Użycie: tsx src/corpus/import-organizer.ts --sources <plik.json|csv> --incidents <plik.json|csv> [--mapping m.json] [--data-dir dir]");
    process.exit(1);
  }
  runImport(args);
}
