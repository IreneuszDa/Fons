/** Typy lokalne modułu korpusu (kontrakty wspólne są w src/shared/contracts.ts i nie są tu modyfikowane). */
import { z } from "zod";
import { CatalogSource } from "../shared/contracts";

/**
 * Incydent / narracja dezinformacyjna (data/incidents/*.jsonl).
 * W bazie: incidents(id, title, summary, url, domains_json, published_at, record_id).
 */
export const IncidentRecord = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  url: z.string().url(),
  /** Domeny serwisów rozpowszechniających narrację (bez platform społecznościowych), gdy źródło je podaje. */
  domains: z.array(z.string()).default([]),
  publishedAt: z.string().nullable().default(null),
  /** Powiązany rekord korpusu (CorpusRecord.id), jeśli istnieje. */
  recordId: z.string().nullable().default(null),
});
export type IncidentRecord = z.infer<typeof IncidentRecord>;

/**
 * Wpis katalogu rozszerzony o flagę `liveSearch` (zmiana kontraktu zgłoszona orkiestratorowi: CatalogSource w
 * src/shared/contracts.ts nie ma jeszcze tego pola, więc moduł korpusu używa lokalnego rozszerzenia).
 *
 * liveSearch = true: host jest dopuszczony do wyszukiwania na żywo (PLAN §3: wyszukiwanie na żywo wyłącznie w hostach
 * z katalogu) — dotyczy hostów urzędowych oraz fact-checkerów IFCN/EFCSN. To flaga POLITYKI, nie gwarancja dostępu:
 * serwis może blokować boty (HTTP 403), a dostawca wyszukiwania musi wtedy uznać gałąź za niedostępną.
 */
export const CatalogEntry = CatalogSource.extend({
  liveSearch: z.boolean().default(false),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;
