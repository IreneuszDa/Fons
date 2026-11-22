/**
 * Gałąź „official” — weryfikacja u źródła: oficjalny kanał instytucji, której twierdzenie przypisuje działanie.
 *
 * Wyszukiwarka („live”) bywa niedeterministyczna i nie trafia w strony, które są rejestrami stanu (lista alertów,
 * poziom ostrzeżenia dla kraju). Dlatego dla instytucji z rejestru data/authorities.yaml kod pobiera ich kanał
 * BEZPOŚREDNIO — bez wyszukiwarki i bez modelu:
 *   1. plan (official-plan.ts): instytucja i kraj rozpoznane w tekście twierdzenia → lista adresów (≤ 4);
 *   2. każdy adres musi mieć DOKŁADNY host w katalogu źródeł o typie „pierwotne”; pobranie przez fetchPage
 *      (ochrona SSRF, limity), host sprawdzany ponownie PO przekierowaniach;
 *   3. konektor (official-connectors.ts) składa rekordy z pól odpowiedzi; poziom, wydawca i licencja pochodzą
 *      z wpisu katalogu, nigdy z odpowiedzi serwisu;
 *   4. detektor ataków na treści każdego rekordu (trafienie high = rekord odrzucony + zdarzenie bezpieczeństwa);
 *   5. rekordy trafiają do `live_snapshots` (TTL 48 h, poza migawką korpusu) i wracają jako kandydaci `connector`.
 * Dalej to zwykłe rekordy: model ocenia relację, kod sprawdza dosłowny cytat, weryfikator i reguły werdyktu.
 *
 * Gałąź opcjonalna (required=false). Twierdzenie bez instytucji z rejestru → pusta lista (to nie awaria).
 * Wszystkie pobrania nieudane → gałąź „niedostępna” (adnotacja w raporcie, werdykt zostaje — PLAN §1.3).
 */
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { loadCatalog, normalizeHost } from "../../corpus/catalog";
import { detectInjection, stripFlaggedSentences } from "../../security/detector";
import { fetchPage, type FetchedPage, type FetchOptions } from "../../security/fetch";
import type { CatalogSource, CorpusRecord, DetectorHit, EvidenceCandidate, RetrievalBranch, RetrievalQuery } from "../../shared/contracts";
import { exactHostOf } from "../../tools/search";
import { queryTexts } from "./bm25";
import { BranchUnavailableError, skipLookup, throwIfAborted } from "./errors";
import { liveRecordId } from "./live";
import { queryStems, scorePassages } from "./live-score";
import { ensureLiveSnapshotsTable, LIVE_TTL_MS, saveLiveSnapshots } from "./live-store";
import {
  govplListDrafts, odyseuszProfileDrafts, odyseuszTopicDrafts, rcbReportDrafts, rsoWarningDrafts, type RecordDraft,
} from "./official-connectors";
import { loadOfficialRegistry, planOfficialLookups, type OfficialLookup, type OfficialRegistry } from "./official-plan";

export const OFFICIAL_BRANCH_ID = "official";
/** Limit czasu całej gałęzi (kilka równoległych pobrań po ~0,1–0,5 s). */
export const OFFICIAL_BRANCH_TIMEOUT_MS = 4500;
const FETCH_TIMEOUT_MS = 3500;
const MAX_BYTES = 1024 * 1024;
/** Ta sama strona nie jest pobierana częściej niż raz na minutę (jedno zapytanie woła gałąź kilka razy). */
const FETCH_MEMO_MS = 60_000;
/** Najwyżej tyle rekordów z oficjalnych kanałów na twierdzenie — reszta miejsc zostaje dla niezależnych źródeł. */
const MAX_RESULTS = 5;
/** Pierwszy rekord każdego kanału (poziom ostrzeżenia dla kraju, najnowsze komunikaty) zawsze trafia do oceny. */
const LEAD_RECORD_BONUS = 2;

/** Znacznik rekordu pobranego z oficjalnego kanału instytucji (pole `topics`). */
export const OFFICIAL_TOPIC = "official-channel";
/** Tyle miejsc wśród fragmentów ocenianych przez model jest zarezerwowanych dla oficjalnego kanału. */
export const OFFICIAL_PINNED_SLOTS = 4;

/**
 * „Najpierw źródło”: rekordy z oficjalnego kanału instytucji, której dotyczy twierdzenie, zawsze trafiają do oceny
 * (najwyżej `slots`, w kolejności puli), przed resztą listy po przeszeregowaniu. Bez tego urzędowa strona pisana
 * innymi słowami niż twierdzenie przegrywa z tekstami, które tylko powtarzają jego słowa.
 * `pool` — kandydaci w kolejności z fuzji; `ranked` — identyfikatory po przeszeregowaniu.
 */
export function pinOfficialRecords(
  ranked: string[],
  pool: string[],
  records: ReadonlyMap<string, Pick<CorpusRecord, "topics" | "origin">>,
  slots: number = OFFICIAL_PINNED_SLOTS,
): string[] {
  const isOfficial = (id: string) => {
    const r = records.get(id);
    return !!r && r.origin === "live_snapshot" && r.topics.includes(OFFICIAL_TOPIC);
  };
  const pinned = [...new Set(pool.filter(isOfficial))].slice(0, slots);
  if (pinned.length === 0) return ranked;
  const set = new Set(pinned);
  return [...pinned, ...ranked.filter((id) => !set.has(id))];
}

export interface OfficialSecurityInfo {
  url: string;
  host: string;
}

export interface OfficialBranchOptions {
  /** Pobieranie stron (domyślnie `fetchPage` z src/security). Wstrzykiwane w testach. */
  fetchPage?: (url: string, opts?: FetchOptions) => Promise<FetchedPage>;
  catalog?: () => CatalogSource[];
  registry?: () => OfficialRegistry;
  now?: () => Date;
  runId?: () => string;
  /** Wywoływane przy każdym trafieniu detektora w treści z oficjalnego kanału. */
  onSecurityEvent?: (hit: DetectorHit, info: OfficialSecurityInfo) => void;
  ttlMs?: number;
  memoMs?: number;
}

export interface OfficialBranch extends RetrievalBranch {
  readonly timeoutMs: number;
}

function sourceForHost(catalog: CatalogSource[], host: string): CatalogSource | undefined {
  const wanted = normalizeHost(host);
  // liveSearch=false w katalogu = źródła nie wolno pobierać na żywo (polityka właściciela) — także tą gałęzią.
  return wanted ? catalog.find((s) => s.type === "pierwotne" && s.liveSearch === true && s.hosts.includes(wanted)) : undefined;
}

function draftsFor(lookup: OfficialLookup, page: FetchedPage, fetchedAt: Date): RecordDraft[] {
  if (lookup.kind === "govpl-list") return govplListDrafts(page.rawHtml ?? "", lookup.pageUrl, lookup.label);
  if (lookup.kind === "rcb-report") return rcbReportDrafts(page.rawHtml ?? "", lookup.pageUrl, lookup.label);
  let json: unknown;
  try {
    json = JSON.parse(page.rawText);
  } catch {
    return [];
  }
  if (lookup.kind === "rso") return rsoWarningDrafts(json, lookup, fetchedAt);
  return lookup.kind === "odyseusz-profile" ? odyseuszProfileDrafts(json, lookup.pageUrl) : odyseuszTopicDrafts(json, lookup.pageUrl);
}

export function createOfficialBranch(db: Database, opts: OfficialBranchOptions = {}): OfficialBranch {
  const fetcher = opts.fetchPage ?? fetchPage;
  const getCatalog = opts.catalog ?? (() => loadCatalog());
  const getRegistry = opts.registry ?? (() => loadOfficialRegistry());
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? LIVE_TTL_MS;
  const memoMs = opts.memoMs ?? FETCH_MEMO_MS;
  const memo = new Map<string, { at: number; page: Promise<FetchedPage> }>();
  try {
    ensureLiveSnapshotsTable(db);
  } catch {
    /* tabela zostanie utworzona przy pierwszym zapisie */
  }

  const fetchOnce = (url: string): Promise<FetchedPage> => {
    const t = now().getTime();
    for (const [k, v] of memo) if (t - v.at > memoMs) memo.delete(k);
    const hit = memo.get(url);
    if (hit) return hit.page;
    // Pobranie nie jest wiązane z sygnałem jednego wywołania: korzystają z niego równoległe wywołania gałęzi.
    const page = fetcher(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BYTES, acceptJson: true });
    memo.set(url, { at: t, page });
    page.catch(() => memo.delete(url));
    return page;
  };

  return {
    id: OFFICIAL_BRANCH_ID,
    required: false,
    timeoutMs: OFFICIAL_BRANCH_TIMEOUT_MS,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      throwIfAborted(q.signal);
      const texts = queryTexts(q);
      const catalog = getCatalog();
      // Adres spoza katalogu (albo o typie innym niż „pierwotne”) nie jest pobierany.
      const lookups = planOfficialLookups(texts.join(" \n "), getRegistry()).filter((l) => {
        const host = exactHostOf(l.fetchUrl);
        return !!host && !!sourceForHost(catalog, host);
      });
      if (lookups.length === 0) return skipLookup(q);

      let failures = 0;
      const perLookup = await Promise.all(
        lookups.map(async (lookup): Promise<(CorpusRecord & { lead?: boolean })[]> => {
          let page: FetchedPage;
          try {
            page = await fetchOnce(lookup.fetchUrl);
          } catch {
            failures++;
            return [];
          }
          // Host PO przekierowaniach — ta sama zasada co przed pobraniem.
          const finalHost = exactHostOf(page.finalUrl);
          const source = finalHost ? sourceForHost(catalog, finalHost) : undefined;
          if (!finalHost || !source) {
            failures++;
            return [];
          }
          const fetchedAt = now();
          const records: (CorpusRecord & { lead?: boolean })[] = [];
          // Ostrzeżenia RSO są pojedynczymi komunikatami, więc o ich kolejności decyduje dopasowanie do pytania.
          let first = lookup.kind !== "rso";
          for (const draft of draftsFor(lookup, page, fetchedAt)) {
            const lead = first;
            first = false;
            const hits = detectInjection(draft.text, "fetched_page");
            for (const h of hits) {
              try {
                opts.onSecurityEvent?.(h, { url: draft.url, host: finalHost });
              } catch {
                /* callback nigdy nie psuje gałęzi */
              }
            }
            if (hits.some((h) => h.severity === "high")) continue;
            const text = (hits.length > 0 ? stripFlaggedSentences(draft.text, hits) : draft.text).trim();
            if (text.length < 40) continue;
            records.push({
              id: liveRecordId(draft.url, text),
              sourceId: source.id,
              url: draft.url,
              title: draft.title.slice(0, 300),
              publisher: source.publisher,
              publishedAt: draft.publishedAt,
              fetchedAt: fetchedAt.toISOString(),
              lang: "pl",
              text,
              role: source.role,
              type: source.type,
              level: source.level,
              independenceGroup: source.independenceGroup,
              licence: source.licence,
              topics: [OFFICIAL_TOPIC, lookup.authorityId, "generated-from-data"],
              origin: "live_snapshot",
              ...(lead ? { lead: true } : {}),
            });
          }
          return records;
        }),
      );
      throwIfAborted(q.signal);

      if (failures > 0) q.onCoverage?.("partial");
      const byId = new Map<string, CorpusRecord>();
      const leads = new Set<string>();
      for (const { lead, ...r } of perLookup.flat()) {
        if (lead) leads.add(r.id);
        if (!byId.has(r.id)) byId.set(r.id, r);
      }
      if (byId.size === 0) {
        if (failures === lookups.length) throw new BranchUnavailableError(OFFICIAL_BRANCH_ID, "fetch_failed");
        return [];
      }

      // Kolejność: rekordy leksykalnie najbliższe twierdzeniu + premia dla pierwszego rekordu każdego kanału
      // (kanał pierwszego źródła ma trafić do oceny także wtedy, gdy używa innych słów niż twierdzenie).
      const order = [...byId.keys()];
      const lexical = new Map(
        scorePassages(
          order.map((id) => ({ key: id, title: byId.get(id)!.title, text: byId.get(id)!.text })),
          queryStems(texts),
          { minCoverage: 0 },
        ).map((s) => [s.key, s.score]),
      );
      const ranked = order
        .map((id, i) => ({ id, score: (lexical.get(id) ?? 0) + (leads.has(id) ? LEAD_RECORD_BONUS : 0) + 1 / (10 + i) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(q.limit ?? MAX_RESULTS, MAX_RESULTS));

      try {
        saveLiveSnapshots(
          db,
          opts.runId?.() ?? `official_${randomUUID()}`,
          ranked.map((r) => byId.get(r.id)!),
          now(),
          ttlMs,
        );
      } catch {
        throw new BranchUnavailableError(OFFICIAL_BRANCH_ID, "snapshot_store_failed");
      }
      return ranked.map((r) => ({ recordId: r.id, score: r.score, via: "connector" as const }));
    },
  };
}
