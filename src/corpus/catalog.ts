/**
 * Katalog źródeł (data/sources.yaml). Poziom źródła jest przypisany do DOKŁADNEGO hosta:
 * `sub.example.org` NIE dziedziczy poziomu po `example.org` (PLAN §1.1).
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { paths } from "./paths";
import { CatalogEntry } from "./types";

const cache = new Map<string, CatalogEntry[]>();

function catalogEntries(text: string): CatalogEntry[] {
  const doc = parseYaml(text) as unknown;
  const wrapper = doc as { sources?: unknown; catalog?: unknown } | null;
  const list = Array.isArray(doc) ? doc : wrapper?.sources ?? wrapper?.catalog;
  return z.array(CatalogEntry).parse(list);
}

function validateCatalog(sources: CatalogEntry[]): CatalogEntry[] {
  const ids = new Set<string>();
  const hosts = new Map<string, string>();
  for (const s of sources) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(s.id)) throw new Error(`sources.yaml: nieprawidłowy identyfikator źródła "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`sources.yaml: zduplikowany id "${s.id}"`);
    ids.add(s.id);
    for (const p of s.pathPrefixes ?? []) {
      if (!p.startsWith("/") || !p.endsWith("/")) {
        throw new Error(`sources.yaml: pathPrefix "${p}" (źródło ${s.id}) musi zaczynać się i kończyć znakiem "/"`);
      }
    }
    for (const h of s.hosts) {
      const host = normalizeHost(h);
      if (host !== h || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(host))
        throw new Error(`sources.yaml: host "${h}" musi być zapisany małymi literami, bez portu i schematu`);
      const other = hosts.get(host);
      if (other) throw new Error(`sources.yaml: host "${host}" przypisany do dwóch źródeł: ${other}, ${s.id}`);
      hosts.set(host, s.id);
    }
  }
  return sources;
}

/**
 * Katalog = data/sources.yaml + opcjonalnie data/sources.organizer.yaml (wpisy z pakietu organizatora,
 * generowane przez import-organizer.ts). Ten sam host nie może wystąpić dwa razy w obu plikach.
 */
export function loadCatalog(dataDir?: string): CatalogEntry[] {
  const file = paths.sourcesYaml(dataDir);
  const organizerFile = paths.organizerSourcesYaml(dataDir);
  const key = `${file}|${existsSync(organizerFile) ? organizerFile : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const entries = catalogEntries(readFileSync(file, "utf8"));
  if (existsSync(organizerFile)) entries.push(...catalogEntries(readFileSync(organizerFile, "utf8")));
  const sources = validateCatalog(entries);
  cache.set(key, sources);
  return sources;
}

export function clearCatalogCache(): void {
  cache.clear();
}

/** Host w postaci porównywalnej: małe litery, bez portu, bez kropki końcowej. Przyjmuje też pełny URL. */
export function normalizeHost(input: string): string {
  let h = input.trim();
  if (h.includes("://")) {
    try {
      h = new URL(h).hostname;
    } catch {
      return "";
    }
  }
  h = h.toLowerCase();
  // IPv6 w nawiasach lub host:port
  if (!h.startsWith("[")) h = h.replace(/:\d+$/, "");
  return h.replace(/\.$/, "");
}

/** Dopasowanie DOKŁADNEGO hosta — bez dziedziczenia z domeny nadrzędnej. */
export function catalogSourceForHost(host: string, dataDir?: string): CatalogEntry | undefined {
  const wanted = normalizeHost(host);
  if (!wanted) return undefined;
  return loadCatalog(dataDir).find((s) => s.hosts.includes(wanted));
}

/** Czy ścieżka mieści się w pathPrefixes wpisu (brak pathPrefixes = cały host). Ścieżka bez końcowego "/" też pasuje do prefiksu ("/eurostat" ~ "/eurostat/"). */
export function pathMatchesPrefixes(entry: Pick<CatalogEntry, "pathPrefixes">, pathname: string): boolean {
  const prefixes = entry.pathPrefixes;
  if (!prefixes || prefixes.length === 0) return true;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return prefixes.some((p) => path.startsWith(p) || `${path}/` === p);
}

/**
 * Dopasowanie po pełnym adresie: DOKŁADNY host + (gdy wpis ma pathPrefixes) ścieżka z jednego z prefiksów.
 * Host szeroki (np. ec.europa.eu: Eurostat tylko pod /eurostat/) nie daje poziomu źródła pozostałym ścieżkom.
 * Zwraca undefined także dla adresu, którego nie da się sparsować.
 */
export function catalogSourceForUrl(url: string, dataDir?: string): CatalogEntry | undefined {
  return sourceAtUrl(loadCatalog(dataDir), url);
}

/** Lookup against the catalogue selected by the caller (also used for external data packs). */
export function sourceAtUrl(catalog: CatalogEntry[], url: string): CatalogEntry | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!["https:", "http:"].includes(u.protocol) || u.port || u.username || u.password) return undefined;
  const wanted = normalizeHost(u.hostname);
  if (!wanted) return undefined;
  const entry = catalog.find((s) => s.hosts.includes(wanted));
  if (!entry) return undefined;
  return pathMatchesPrefixes(entry, u.pathname) ? entry : undefined;
}

export function catalogSourceById(id: string, dataDir?: string): CatalogEntry | undefined {
  return loadCatalog(dataDir).find((s) => s.id === id);
}

/** Do testów: parsowanie katalogu z tekstu YAML (bez dotykania dysku). */
export function parseCatalogForTest(text: string): CatalogEntry[] {
  return validateCatalog(catalogEntries(text));
}
