/**
 * Jawna tabela mapowania ocen fact-checków na klasy werdyktu (PLAN §4, rekordy o stałej roli).
 *
 * Zasady:
 *  - tabela jest w data/rating-map.yaml (audytowalna, w repozytorium),
 *  - ocena spoza tabeli -> mapped = null (nie rozstrzyga), binary = false,
 *  - binary = true tylko dla jednoznacznych ocen prawda/fałsz (to je silnik odwraca przy negacji),
 *  - `raw` zawsze zostaje dosłownie taki, jaki podał wydawca.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FixedRating, Verdict } from "../shared/contracts";
import { paths } from "./paths";

const RuleSchema = z.object({
  verdict: Verdict.nullable(),
  binary: z.boolean().default(false),
});
export type RatingRule = z.infer<typeof RuleSchema>;

const RatingMapSchema = z.object({
  version: z.number(),
  /** Nazwane tablice etykiet (klucz = etykieta, wartość = reguła). */
  tables: z.record(z.string(), z.record(z.string(), RuleSchema)),
  /** sourceId -> lista tablic sprawdzanych po kolei (pierwsze trafienie wygrywa). */
  sources: z.record(z.string(), z.object({ use: z.array(z.string()).min(1) })),
  /** Tablice dla sourceId, którego nie ma w `sources` (np. nowe źródło z pakietu organizatora). */
  fallbackTables: z.array(z.string()).default([]),
});
export type RatingMap = z.infer<typeof RatingMapSchema>;

/** Sprowadza etykietę do postaci porównywalnej: małe litery, bez diakrytyków, bez interpunkcji na brzegach. */
export function normalizeRatingKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    .toLowerCase()
    .replace(/[_‐-―-]+/g, " ")
    .replace(/^[\s"'«»„“”‘’.,:;!?()\[\]]+|[\s"'«»„“”‘’.,:;!?()\[\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Niektórzy wydawcy (np. DW) wstawiają do pola oceny długi opis z etykietą na początku,
 * np. "DW Fact check: False    The video does not show...". Zwraca krótką etykietę (dosłowny
 * podciąg oryginału) albo null, gdy nie da się jej wyciągnąć jednoznacznie.
 */
export function extractRatingLabel(raw: string, maxLen = 60): string | null {
  const s = raw.trim();
  if (s.length <= maxLen) return s;
  const m =
    /^(?:DW Fact ?check|Verdict|Rating|Ocena|Urteil|Bewertung)\s*:\s*([^\n\r]{1,40}?)(?:\s{2,}|\n|\r|$|\.\s)/i.exec(s);
  if (m?.[1]) return m[1].trim();
  return null;
}

const cache = new Map<string, RatingMap>();

export function loadRatingMap(dataDir?: string): RatingMap {
  const file = paths.ratingMapYaml(dataDir);
  const hit = cache.get(file);
  if (hit) return hit;
  const parsed = RatingMapSchema.parse(parseYaml(readFileSync(file, "utf8")));
  // Normalizacja kluczy raz przy ładowaniu.
  const tables: RatingMap["tables"] = {};
  for (const [name, table] of Object.entries(parsed.tables)) {
    tables[name] = {};
    for (const [label, rule] of Object.entries(table)) {
      tables[name]![normalizeRatingKey(label)] = rule;
    }
  }
  const map: RatingMap = { ...parsed, tables };
  cache.set(file, map);
  return map;
}

export function clearRatingMapCache(): void {
  cache.clear();
}

/** Zwraca ocenę zmapowaną przez jawną tabelę. Nieznana ocena -> mapped: null, binary: false. */
export function mapRating(sourceId: string, raw: string, dataDir?: string): FixedRating {
  const map = loadRatingMap(dataDir);
  const key = normalizeRatingKey(raw);
  const tableNames = map.sources[sourceId]?.use ?? map.fallbackTables;
  for (const name of tableNames) {
    const rule = map.tables[name]?.[key];
    if (rule) {
      return { raw, mapped: rule.verdict, binary: rule.verdict !== null && rule.binary };
    }
  }
  return { raw, mapped: null, binary: false };
}
