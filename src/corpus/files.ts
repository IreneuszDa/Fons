/** Odczyt plików danych korpusu (data/corpus/*.jsonl, data/incidents/*.jsonl). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CorpusRecord } from "../shared/contracts";
import { loadCatalog, sourceAtUrl } from "./catalog";
import { paths } from "./paths";
import { includePublishedExcerpts, publicationLinks } from "./publication-links";
import { IncidentRecord } from "./types";

export interface JsonlFile {
  name: string;
  path: string;
  /** Niepuste linie dokładnie jak w pliku. */
  lines: string[];
}

export function listJsonl(dir: string): JsonlFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("_"))
    .sort()
    .map((name) => {
      const path = resolve(dir, name);
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      return { name, path, lines };
    });
}

export function corpusFiles(dataDir?: string): JsonlFile[] {
  return listJsonl(paths.corpusDir(dataDir));
}

export function incidentFiles(dataDir?: string): JsonlFile[] {
  return listJsonl(paths.incidentsDir(dataDir));
}

export interface LoadedCorpus {
  records: CorpusRecord[];
  incidents: IncidentRecord[];
  errors: string[];
}

/** Parsuje i waliduje wszystkie linie; błędne linie trafiają do `errors` (nie są ładowane). */
export function readCorpus(dataDir?: string, catalog = loadCatalog(dataDir)): LoadedCorpus {
  const records: CorpusRecord[] = [];
  const incidents: IncidentRecord[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const links = new Map(publicationLinks(dataDir).map(link => [link.publicationId, link]));
  for (const f of corpusFiles(dataDir)) {
    f.lines.forEach((line, i) => {
      try {
        const r = CorpusRecord.parse(JSON.parse(line));
        const source = sourceAtUrl(catalog, r.url);
        // Older organizer packs stored a reviewed statement without an assigned rating as ordinary content.
        const unratedReview = source?.role === "stala_rola" && r.role === "tresc" && r.origin === "organizer";
        if (source?.id !== r.sourceId || (source.role !== r.role && !unratedReview)) {
          errors.push(`${f.name}:${i + 1}: adres lub rola rekordu poza zakresem źródła ${r.sourceId}`);
          return;
        }
        if (seen.has(r.id)) {
          errors.push(`${f.name}:${i + 1}: zduplikowany id ${r.id}`);
          return;
        }
        seen.add(r.id);
        const qualified = { ...r, role: source.role, type: source.type, level: source.level,
          independenceGroup: source.independenceGroup, licence: source.licence, ...(unratedReview && { rating: undefined }) };
        records.push(includePublishedExcerpts(qualified, links.get(r.id)));
      } catch (e) {
        errors.push(`${f.name}:${i + 1}: ${(e as Error).message.slice(0, 200)}`);
      }
    });
  }
  const incSeen = new Set<string>();
  for (const f of incidentFiles(dataDir)) {
    f.lines.forEach((line, i) => {
      try {
        const r = IncidentRecord.parse(JSON.parse(line));
        if (!sourceAtUrl(catalog, r.url) || (r.recordId && !seen.has(r.recordId))) {
          errors.push(`${f.name}:${i + 1}: incydent poza katalogiem lub bez zakwalifikowanego rekordu ${r.recordId ?? ""}`);
          return;
        }
        if (incSeen.has(r.id)) {
          errors.push(`${f.name}:${i + 1}: zduplikowany id incydentu ${r.id}`);
          return;
        }
        incSeen.add(r.id);
        incidents.push(r);
      } catch (e) {
        errors.push(`${f.name}:${i + 1}: ${(e as Error).message.slice(0, 200)}`);
      }
    });
  }
  return { records, incidents, errors };
}
