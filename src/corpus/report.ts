/** Statystyki korpusu (liczby rekordów wg źródła/typu/hosta) i sekcja liczników w docs/SOURCES.md. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadCatalog } from "./catalog";
import { readCorpus } from "./files";
import { paths } from "./paths";

export interface CorpusStats {
  total: number;
  incidents: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  byHost: Record<string, number>;
  byLevel: Record<string, number>;
  byRole: Record<string, number>;
  domains: number;
  withPublishedAt: number;
  newestFetchedAt: string | null;
  oldestFetchedAt: string | null;
}

function inc(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

export function computeStats(dataDir?: string): CorpusStats {
  const { records, incidents } = readCorpus(dataDir);
  const s: CorpusStats = {
    total: records.length,
    incidents: incidents.length,
    bySource: {},
    byType: {},
    byHost: {},
    byLevel: {},
    byRole: {},
    domains: 0,
    withPublishedAt: 0,
    newestFetchedAt: null,
    oldestFetchedAt: null,
  };
  for (const r of records) {
    inc(s.bySource, r.sourceId);
    inc(s.byType, r.type);
    inc(s.byLevel, String(r.level));
    inc(s.byRole, r.role);
    try {
      inc(s.byHost, new URL(r.url).hostname);
    } catch {
      /* pomiń */
    }
    if (r.publishedAt) s.withPublishedAt++;
    if (!s.newestFetchedAt || r.fetchedAt > s.newestFetchedAt) s.newestFetchedAt = r.fetchedAt;
    if (!s.oldestFetchedAt || r.fetchedAt < s.oldestFetchedAt) s.oldestFetchedAt = r.fetchedAt;
  }
  s.domains = Object.keys(s.byHost).length;
  return s;
}

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(" | ")} |\n|${headers.map(() => "---").join("|")}|`;
  return [head, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function renderCountsMarkdown(stats: CorpusStats, dataDir?: string): string {
  const catalog = loadCatalog(dataDir);
  const sourceRows = catalog.map((c) => [c.id, c.hosts.map((h) => `\`${h}\``).join(", "), c.type, c.level, stats.bySource[c.id] ?? 0]);
  const hostRows = Object.entries(stats.byHost)
    .sort((a, b) => b[1] - a[1])
    .map(([h, n]) => [`\`${h}\``, n]);
  const typeRows = Object.entries(stats.byType).map(([t, n]) => [t, n]);
  return [
    `Stan na dzień ${new Date().toISOString().slice(0, 10)}: **${stats.total} rekordów**, **${stats.incidents} incydentów**, **${stats.domains} hostów** (domen źródłowych), **${Object.keys(stats.byType).length} typy źródeł**.`,
    "",
    "Rekordy według źródła z katalogu:",
    "",
    table(["Źródło (id)", "Hosty", "Typ", "Poziom", "Rekordy"], sourceRows),
    "",
    "Rekordy według typu:",
    "",
    table(["Typ", "Rekordy"], typeRows),
    "",
    "Rekordy według hosta (adres rekordu):",
    "",
    table(["Host", "Rekordy"], hostRows),
  ].join("\n");
}

export const COUNTS_START = "<!-- COUNTS:START -->";
export const COUNTS_END = "<!-- COUNTS:END -->";

/** Wstawia wygenerowane liczniki między znaczniki w docs/SOURCES.md (jeśli plik i znaczniki istnieją). */
export function updateSourcesDoc(stats: CorpusStats, dataDir?: string): boolean {
  const file = paths.sourcesDoc();
  if (!existsSync(file)) return false;
  const doc = readFileSync(file, "utf8");
  const a = doc.indexOf(COUNTS_START);
  const b = doc.indexOf(COUNTS_END);
  if (a < 0 || b < 0 || b < a) return false;
  const next = `${doc.slice(0, a + COUNTS_START.length)}\n\n${renderCountsMarkdown(stats, dataDir)}\n\n${doc.slice(b)}`;
  if (next !== doc) writeFileSync(file, next);
  return true;
}
