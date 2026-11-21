/**
 * Ścieżki danych korpusu. Domyślnie `<repo>/data`; można nadpisać zmienną
 * PRAWDOWID_DATA_DIR (testy, ewentualnie wdrożenie z danymi poza repozytorium).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, "../..");

export function dataDir(override?: string): string {
  if (override) return resolve(override);
  const fromEnv = process.env.PRAWDOWID_DATA_DIR;
  if (fromEnv && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return resolve(REPO_ROOT, "data");
}

export const paths = {
  sourcesYaml: (d?: string) => resolve(dataDir(d), "sources.yaml"),
  organizerSourcesYaml: (d?: string) => resolve(dataDir(d), "sources.organizer.yaml"),
  ratingMapYaml: (d?: string) => resolve(dataDir(d), "rating-map.yaml"),
  corpusDir: (d?: string) => resolve(dataDir(d), "corpus"),
  incidentsDir: (d?: string) => resolve(dataDir(d), "incidents"),
  report: (d?: string) => resolve(dataDir(d), "corpus-report.json"),
  /** Surowe odpowiedzi pobrane przez ingestię (poza gitem — katalog .cache/ jest w .gitignore). */
  cacheDir: () => resolve(REPO_ROOT, ".cache", "corpus"),
  sourcesDoc: () => resolve(REPO_ROOT, "docs", "SOURCES.md"),
};
