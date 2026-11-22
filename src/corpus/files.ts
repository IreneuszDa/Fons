/** Odczyt plików danych korpusu (data/corpus/*.jsonl, data/incidents/*.jsonl). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CorpusRecord } from "../shared/contracts";
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
export function readCorpus(dataDir?: string): LoadedCorpus {
  const records: CorpusRecord[] = [];
  const incidents: IncidentRecord[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const links = new Map(publicationLinks(dataDir).map(link => [link.publicationId, link]));
  for (const f of corpusFiles(dataDir)) {
    f.lines.forEach((line, i) => {
      try {
        const r = CorpusRecord.parse(JSON.parse(line));
        if (seen.has(r.id)) {
          errors.push(`${f.name}:${i + 1}: zduplikowany id ${r.id}`);
          return;
        }
        seen.add(r.id);
        records.push(includePublishedExcerpts(r, links.get(r.id)));
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
