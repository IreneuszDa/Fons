/**
 * npm run corpus:build [-- --refresh] [-- --only eli,nato] [-- --limit 50]
 *
 * Pobiera dane z PRAWDZIWYCH publicznych źródeł (patrz docs/SOURCES.md) i zapisuje:
 *   data/corpus/<sourceId>.jsonl     jeden CorpusRecord na linię (walidowany zod-em)
 *   data/incidents/<ingestor>.jsonl  incydenty / narracje dezinformacyjne
 *   data/corpus-report.json          przebieg budowania (liczby, pominięte elementy, uwagi)
 * Zasady: <= 1 żądanie/s na host, robots.txt, User-Agent bez danych osobowych, brak obchodzenia zabezpieczeń.
 * Błąd jednego źródła nie przerywa pozostałych — poprzednie dane tego źródła zostają nietknięte.
 */
import "dotenv/config"; // FACTCHECK_API_KEY (Demagog) i EUVSDISINFO_MCP_TOKEN (EUvsDisinfo MCP)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CorpusRecord } from "../shared/contracts";
import { loadCatalog } from "./catalog";
import { readCorpus } from "./files";
import { ingestClaimReview } from "./ingest/claimreview";
import { ingestEeas } from "./ingest/eeas";
import { ingestDemagogWithArchive } from "./ingest/published-reviews";
import { ingestEli } from "./ingest/eli";
import { ingestEuPortal } from "./ingest/euportal";
import { ingestEurLex } from "./ingest/eurlex";
import { ingestEuLeadership } from "./ingest/eu-leadership";
import { ingestEuvsdisinfo } from "./ingest/euvsdisinfo";
import { ingestFactcheckProbe } from "./ingest/factcheck-probe";
import { ingestEurostat } from "./ingest/eurostat";
import { ingestGovPl } from "./ingest/govpl";
import { ingestGus } from "./ingest/gus";
import { ingestOfficialPages } from "./ingest/officialpages";
import { ingestGovPlOfficials } from "./ingest/govpl-officials";
import { ingestNato } from "./ingest/nato";
import { ingestSejmMp } from "./ingest/sejm-mp";
import { ingestStateOfficials } from "./ingest/state-officials";
import { type IngestOptions, type IngestResult, finalizeRecords, writeJsonl } from "./ingest/common";
import { paths } from "./paths";
import { computeStats, updateSourcesDoc } from "./report";
import { IncidentRecord } from "./types";

type Ingester = (opts: IngestOptions) => Promise<IngestResult>;

export const INGESTERS: Record<string, Ingester> = {
  eli: ingestEli,
  "eur-lex": ingestEurLex,
  eurostat: ingestEurostat,
  nato: ingestNato,
  "eu-portal": ingestEuPortal,
  "gov-pl": ingestGovPl,
  eeas: ingestEeas,
  claimreview: ingestClaimReview,
  euvsdisinfo: ingestEuvsdisinfo,
  // Faza 2: osoby pełniące funkcje publiczne (pytania „kto jest …”) i sonda blokad fact-checkerów.
  "gov-pl-officials": ingestGovPlOfficials,
  "sejm-mp": ingestSejmMp,
  "state-officials": ingestStateOfficials,
  "eu-leadership": ingestEuLeadership,
  "factcheck-probe": ingestFactcheckProbe,
  demagog: ingestDemagogWithArchive,
  // Rodziny tematyczne: sankcje UE, Schengen, MH17, Bucza, "biolaby" (strony instytucji) oraz statystyka GUS (API BDL).
  "official-pages": ingestOfficialPages,
  "gus-bdl": ingestGus,
};

interface CliArgs {
  refresh: boolean;
  only?: string[];
  limit?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--refresh") args.refresh = true;
    else if (a === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--limit") args.limit = Number(argv[++i]);
  }
  return args;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

export async function runBuild(args: CliArgs, log: (m: string) => void = console.log): Promise<void> {
  const catalog = loadCatalog();
  const ids = Object.keys(INGESTERS).filter((id) => !args.only || args.only.includes(id));
  if (ids.length === 0) throw new Error(`Nieznane źródło w --only. Dostępne: ${Object.keys(INGESTERS).join(", ")}`);
  mkdirSync(paths.corpusDir(), { recursive: true });
  mkdirSync(paths.incidentsDir(), { recursive: true });

  const runLog: Record<string, unknown>[] = [];
  for (const id of ids) {
    const t0 = Date.now();
    log(`\n[${id}] start`);
    try {
      const res = await INGESTERS[id]!({ refresh: args.refresh, limit: args.limit, catalog, log });
      const records = finalizeRecords(res.records);
      const byFile = groupBy(records, (r: CorpusRecord) => res.fileId ?? r.sourceId);
      if (res.fileId && records.length === 0) byFile.set(res.fileId, []);
      for (const [fileId, recs] of byFile) {
        const file = resolve(paths.corpusDir(), `${fileId}.jsonl`);
        if (recs.length === 0 && existsSync(file)) continue;
        writeJsonl(file, recs);
      }
      if (records.length === 0) {
        log(`[${id}] 0 rekordów — istniejące pliki zostają bez zmian`);
      }
      if (res.incidents.length > 0) {
        const incs = new Map<string, IncidentRecord>();
        for (const i of res.incidents) incs.set(i.id, IncidentRecord.parse(i));
        writeJsonl(resolve(paths.incidentsDir(), `${id}.jsonl`), [...incs.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
      }
      runLog.push({
        ingester: id,
        records: records.length,
        incidents: res.incidents.length,
        requests: res.requests,
        skippedCount: res.skipped.length,
        skipped: res.skipped.slice(0, 25),
        notes: res.notes,
        durationMs: Date.now() - t0,
      });
      log(`[${id}] ${records.length} rekordów, ${res.incidents.length} incydentów, pominięto ${res.skipped.length}, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      const msg = (e as Error).message;
      log(`[${id}] BŁĄD: ${msg} — poprzednie dane tego źródła zostają nietknięte`);
      runLog.push({ ingester: id, error: msg, durationMs: Date.now() - t0 });
    }
  }

  // Spójność po zbudowaniu: unikalne id, powiązania incydentów z istniejącymi rekordami.
  const { records, incidents, errors } = readCorpus();
  if (errors.length) log(`\nUWAGA: ${errors.length} błędów w plikach jsonl, np. ${errors.slice(0, 3).join(" | ")}`);
  const ids2 = new Set(records.map((r) => r.id));
  const dangling = incidents.filter((i) => i.recordId && !ids2.has(i.recordId));
  if (dangling.length) log(`UWAGA: ${dangling.length} incydentów wskazuje nieistniejący rekord`);

  const stats = computeStats();
  // Raport scala wpisy ze wszystkich uruchomień (przy --only zachowujemy wpisy pozostałych źródeł).
  let previous: Record<string, unknown>[] = [];
  try {
    previous = (JSON.parse(readFileSync(paths.report(), "utf8")) as { ingesters?: Record<string, unknown>[] }).ingesters ?? [];
  } catch {
    /* pierwszy przebieg */
  }
  const ranIds = new Set(runLog.map((r) => String(r.ingester)));
  const merged = [...previous.filter((p) => !ranIds.has(String(p.ingester))), ...runLog].sort((a, b) => String(a.ingester).localeCompare(String(b.ingester)));
  writeFileSync(
    paths.report(),
    JSON.stringify({ builtAt: new Date().toISOString(), node: process.version, args, ingesters: merged, stats }, null, 2) + "\n",
  );
  const docUpdated = updateSourcesDoc(stats);
  log(
    `\nGotowe: ${stats.total} rekordów, ${stats.incidents} incydentów, ${stats.domains} hostów, typy: ${JSON.stringify(stats.byType)}` +
      (docUpdated ? " (liczniki w docs/SOURCES.md zaktualizowane)" : ""),
  );
}

const isMain = process.argv[1] && /build\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  runBuild(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
