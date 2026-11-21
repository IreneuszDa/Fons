/**
 * Różnorodność źródeł wśród kandydatów (funkcje czyste, bez bazy i sieci).
 *
 * Powód (2026-11-22): rekordy fact-checków jednego wydawcy (Demagog przez Fact Check Tools API, ~740 rekordów)
 * wypełniały pulę i wszystkie 8 fragmentów dla twierdzeń z nazwiskiem polityka — urzędowe rekordy o pełnionej
 * funkcji (gov.pl, sejm.gov.pl) nie trafiały do oceny. Dlatego:
 *  - `capPerSource` — „miękki” limit rekordów jednego `sourceId` na liście: nadmiar schodzi na koniec listy (trafia
 *    do wyniku tylko wtedy, gdy innych kandydatów brakuje). Używany w puli gałęzi BM25;
 *  - `diversifyFragments` — wybór fragmentów ocenianych przez model dla jednego twierdzenia: najwyżej
 *    `perSource` z jednego źródła (miękko) i co najmniej `level1Slots` rekordów poziomu 1, gdy jakikolwiek kandydat
 *    poziomu 1 istnieje, oraz najwyżej `fixedRole` rekordów o stałej roli (miękko). Rekordy przypięte (oficjalny
 *    kanał, rekordy o funkcji) zostają zawsze.
 */
import type { CorpusRecord } from "../../shared/contracts";

/** Najwięcej fragmentów z jednego źródła wśród ocenianych dla jednego twierdzenia (miękko). */
export const FRAGMENTS_MAX_PER_SOURCE = 4;
/**
 * Najwięcej rekordów o stałej roli (tezy fact-checków) wśród fragmentów (miękko). Teza pomaga tylko wtedy, gdy pasuje
 * do twierdzenia; luźno dopasowane tezy różnych fact-checkerów wypierały rekordy treści, na których działają reguły.
 */
export const FRAGMENTS_MAX_FIXED_ROLE = 3;
/** Tyle miejsc wśród fragmentów jest zarezerwowanych dla rekordów poziomu 1, gdy są w puli. */
export const FRAGMENTS_LEVEL1_SLOTS = 2;
/** Udział jednego źródła w puli BM25 (miękko): najwyżej tyle × limit. */
export const BM25_MAX_SOURCE_SHARE = 0.4;

/**
 * Stabilny „miękki” limit: elementy ponad `perSource` z jednego źródła przechodzą za wszystkie pozostałe
 * (w swojej kolejności), potem lista jest przycinana do `limit`. Gdy jest tylko jedno źródło, kolejność się nie zmienia.
 */
export function capPerSource<T>(items: T[], sourceOf: (x: T) => string | undefined, perSource: number, limit = items.length): T[] {
  const counts = new Map<string, number>();
  const within: T[] = [];
  const overflow: T[] = [];
  for (const x of items) {
    const src = sourceOf(x) ?? "";
    const n = counts.get(src) ?? 0;
    counts.set(src, n + 1);
    (n < perSource ? within : overflow).push(x);
  }
  return [...within, ...overflow].slice(0, Math.max(0, limit));
}

export interface DiversifyOptions {
  /** Ile fragmentów wybrać. */
  max: number;
  /** Identyfikatory, które zostają zawsze (w tej kolejności, na początku), np. oficjalny kanał i rekordy o funkcji. */
  pinned?: string[];
  perSource?: number;
  level1Slots?: number;
  /** Limit rekordów o stałej roli (domyślnie FRAGMENTS_MAX_FIXED_ROLE). */
  fixedRole?: number;
}

/**
 * Wybiera do `max` fragmentów z listy po przeszeregowaniu (`ranked`) z limitem na źródło i rezerwą dla poziomu 1.
 * Kolejność wyniku: przypięte, potem reszta w kolejności `ranked`. Identyfikatory spoza `records` są pomijane.
 */
export function diversifyFragments(
  ranked: string[],
  records: ReadonlyMap<string, Pick<CorpusRecord, "sourceId" | "level"> & Partial<Pick<CorpusRecord, "role">>>,
  opts: DiversifyOptions,
): string[] {
  const max = Math.max(0, opts.max);
  const perSource = opts.perSource ?? FRAGMENTS_MAX_PER_SOURCE;
  const level1Slots = Math.min(opts.level1Slots ?? FRAGMENTS_LEVEL1_SLOTS, max);
  const fixedCap = opts.fixedRole ?? FRAGMENTS_MAX_FIXED_ROLE;
  const isFixed = (id: string) => records.get(id)?.role === "stala_rola";
  const known = (id: string) => records.has(id);
  const pinned = [...new Set((opts.pinned ?? []).filter(known))].slice(0, max);
  const pinnedSet = new Set(pinned);
  const rest = [...new Set(ranked.filter((id) => known(id) && !pinnedSet.has(id)))];
  const src = (id: string) => records.get(id)?.sourceId ?? "";
  const isL1 = (id: string) => records.get(id)?.level === 1;

  const chosen = new Set<string>(pinned);
  const counts = new Map<string, number>();
  for (const id of pinned) counts.set(src(id), (counts.get(src(id)) ?? 0) + 1);
  let fixedCount = pinned.filter(isFixed).length;
  const overflow: string[] = [];
  for (const id of rest) {
    if (chosen.size >= max) break;
    const n = counts.get(src(id)) ?? 0;
    if (n >= perSource || (isFixed(id) && fixedCount >= fixedCap)) {
      overflow.push(id);
      continue;
    }
    counts.set(src(id), n + 1);
    if (isFixed(id)) fixedCount++;
    chosen.add(id);
  }

  // Rezerwa poziomu 1: brakujące miejsca zajmują najlepsze niewybrane rekordy poziomu 1 (limit źródła ich nie
  // blokuje), wypierając od końca najsłabsze wybrane rekordy spoza poziomu 1, które nie są przypięte.
  const l1Available = [...pinned, ...rest].filter(isL1).length;
  let need = Math.min(level1Slots, l1Available) - [...chosen].filter(isL1).length;
  if (need > 0) {
    const order = rest.filter((id) => chosen.has(id));
    const evictable = order.filter((id) => !isL1(id)).reverse();
    for (const id of rest) {
      if (need <= 0) break;
      if (chosen.has(id) || !isL1(id)) continue;
      if (chosen.size >= max) {
        const out = evictable.shift();
        if (!out) break;
        chosen.delete(out);
      }
      chosen.add(id);
      need--;
    }
  }

  // Wolne miejsca (za mało innych źródeł): nadmiar ponad limit źródła, w kolejności listy.
  for (const id of overflow) {
    if (chosen.size >= max) break;
    chosen.add(id);
  }

  return [...pinned, ...rest.filter((id) => chosen.has(id))];
}
