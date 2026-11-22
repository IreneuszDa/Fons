/**
 * Gałąź „live” — wyszukiwanie na żywo ograniczone do hostów z katalogu (PLAN §1.1, §3.4). Opcjonalna
 * (required=false): awaria = adnotacja „nie udało się sprawdzić w: live”, werdykt zostaje.
 *
 * Zasada: narzędzie wyszukiwania (SearchProvider, src/tools/search.ts) tylko PROPONUJE adresy, a decyduje kod:
 *   1. allowedHosts = hosty katalogu o typie pierwotne i factcheck z flagą liveSearch=true (DOKŁADNE hosty, bez subdomen);
 *   2. każdy zaproponowany adres: dokładny host w katalogu → fetchPage (SSRF, limity) → ponowne sprawdzenie
 *      hosta PO przekierowaniach → detektor ataków na surowej treści (trafienie high = strona odrzucona,
 *      zdarzenie bezpieczeństwa przez onSecurityEvent; low = tylko zdania z trafieniem wypadają);
 *   3. tekst dzielony na fragmenty ~1200 znaków → CorpusRecord (poziom/typ/rola/wydawca/licencja z wpisu katalogu
 *      DOKŁADNEGO hosta końcowego, nigdy z odpowiedzi wyszukiwarki) → tabela `live_snapshots` (TTL 48 h);
 *   3a. strona fact-checkera z katalogu (typ factcheck / rola stala_rola) z blokiem JSON-LD ClaimReview → do 5 rekordów
 *       o stałej roli (claimreview.ts): teza i ocena z JSON-LD, ocena przez data/rating-map.yaml, metadane tylko z katalogu,
 *       teza/ocena przez detektor (high = recenzja odrzucona, zdarzenie przez onSecurityEvent) → też do `live_snapshots`;
 *   4. fragmenty są punktowane leksykalnie względem twierdzenia; recenzje z tezą pasującą do twierdzenia idą przed
 *      fragmentami; zwracane są najlepsze (via "live").
 * Limity na twierdzenie: 2 wyszukiwania, 5 pobrań stron (najwyżej 2 z jednego hosta), 30 s łącznie.
 *
 * Uwaga o rolach: zwykłe fragmenty stron fact-checków mają rolę `stala_rola` z katalogu, ale bez oceny, więc nigdy nie
 * rozstrzygają (decisive.ts wymaga rating.mapped). Rozstrzygać może rekord ClaimReview (3a) — ocena znana tabeli
 * mapowania i poziom z katalogu ≤ 2 — dokładnie jak rekord ClaimReview z korpusu (reguła 6).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { loadCatalog, normalizeHost } from "../../corpus/catalog";
import { detectInjection, stripFlaggedSentences } from "../../security/detector";
import { FetchBlockedError, fetchPage, type FetchedPage } from "../../security/fetch";
import type { AppConfig } from "../../server/config";
import {
  canonicalProposal,
  createOpenAiSearchProvider,
  exactHostOf,
  filterProposedUrls,
  isSearchResultsUrl,
  type SearchProvider,
  type SearchResultItem,
} from "../../tools/search";
import type {
  CatalogSource,
  CorpusRecord,
  DetectorHit,
  EvidenceCandidate,
  RetrievalBranch,
  RetrievalQuery,
} from "../../shared/contracts";
import { queryTexts } from "./bm25";
import { claimReviewRecords, withClaimReviews } from "./claimreview";
import { BranchUnavailableError, skipLookup, throwIfAborted } from "./errors";
import { stripPiiPlaceholders } from "./fts";
import { chunkText, foldToken, keywordQuery, queryStems, scorePassages } from "./live-score";
import { ensureLiveSnapshotsTable, LIVE_ID_PREFIX, LIVE_TTL_MS, reserveLiveRequest, saveLiveSnapshots } from "./live-store";
import { recordLiveUsage } from "./live-usage";

export { ensureLiveSnapshotsTable, getLiveSnapshot, purgeExpiredLiveSnapshots, saveLiveSnapshots, LIVE_TTL_MS } from "./live-store";
export {
  currentLiveRequestId,
  currentLiveScope,
  liveSearchCostUsd,
  liveUsageModels,
  recordLiveUsage,
  runWithLiveScope,
  withLiveUsage,
  LIVE_SEARCH_PURPOSE,
  type LiveRunScope,
} from "./live-usage";

/**
 * Starszy, prostszy interfejs: dostawca zwracający od razu kandydatów. Zachowany dla zgodności z
 * `createRetrievalBranches` (index.ts); nowy kod używa `createLiveBranch(db, opts)`.
 */
export interface LiveSearchProvider {
  search(q: RetrievalQuery): Promise<EvidenceCandidate[]>;
}

/** Typy źródeł, z których wolno brać strony na żywo. */
export const LIVE_ALLOWED_TYPES: ReadonlySet<CatalogSource["type"]> = new Set(["pierwotne", "factcheck"]);

export interface LiveLimits {
  maxSearches: number;
  maxFetches: number;
  overallTimeoutMs: number;
  maxPageBytes: number;
  maxResults: number;
  maxPassagesPerPage: number;
}

/** Najwyżej tyle stron z jednego hosta w jednym wyszukiwaniu (różnorodność wydawców, odporność na blokady botów). */
export const LIVE_MAX_PER_HOST = 2;

export const LIVE_LIMITS: Readonly<LiveLimits> = {
  maxSearches: 2,
  maxFetches: 5,
  overallTimeoutMs: 30_000,
  maxPageBytes: 2 * 1024 * 1024,
  maxResults: 8,
  maxPassagesPerPage: 60,
};

/**
 * Limit czasu gałęzi (łączny czas działań sieciowych + zapas na zapis). `retrieve()` ma domyślnie 4 s na
 * gałąź — silnik powinien dla tej gałęzi użyć wartości `branch.timeoutMs` (patrz notesForIntegrator).
 */
export const LIVE_BRANCH_TIMEOUT_MS = LIVE_LIMITS.overallTimeoutMs + 500;

export type LiveDropReason =
  | "host_not_allowed" // zaproponowany host spoza katalogu (lub typ inny niż pierwotne/factcheck)
  | "fetch_failed"
  | "final_host_not_allowed" // po przekierowaniu host spoza katalogu
  | "path_not_allowed" // host w katalogu, ale ścieżka poza `pathPrefixes` źródła (przed pobraniem lub po przekierowaniach)
  | "injection_detected" // trafienie high detektora
  | "no_text"
  | "unsupported_type" // adres wskazuje plik (PDF, arkusz...), a nie stronę z tekstem
  | "search_page" // wyszukiwarka serwisu / strona wyników / tekst w zapytaniu (odbija wpisany tekst — SEC-01)
  | "unreadable_url";

export interface LiveDropInfo {
  url: string;
  reason: LiveDropReason;
}

export interface LiveSecurityInfo {
  /** Adres, z którego pochodzi treść (po przekierowaniach). */
  url: string;
  host: string;
  /** Czy strona została odrzucona w całości (high) czy tylko zdania zostały usunięte (low). */
  pageDropped: boolean;
}

export interface LiveBranchOptions {
  /** Dostawca wyszukiwania (proponuje adresy). Bez niego gałąź zgłasza niedostępność. */
  searchProvider?: SearchProvider;
  /** Pobieranie stron (domyślnie `fetchPage` z src/security). Wstrzykiwane w testach. */
  fetchPage?: (url: string, opts?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }) => Promise<FetchedPage>;
  /** Katalog źródeł (domyślnie `loadCatalog()`). */
  catalog?: () => CatalogSource[];
  now?: () => Date;
  /** Identyfikator przebiegu zapisywany w live_snapshots (domyślnie losowy na wyszukiwanie). */
  runId?: () => string;
  /** Wywoływane przy każdym trafieniu detektora na stronie z wyszukiwania na żywo. */
  onSecurityEvent?: (hit: DetectorHit, info: LiveSecurityInfo) => void;
  /** Wywoływane przy każdej odrzuconej propozycji (diagnostyka, bez treści). */
  onDrop?: (info: LiveDropInfo) => void;
  ttlMs?: number;
  limits?: Partial<LiveLimits>;
}

export interface LiveBranch extends RetrievalBranch {
  /** Limit czasu gałęzi, którego ta gałąź potrzebuje (ms). */
  readonly timeoutMs: number;
}

function sha(s: string, len = 20): string {
  return createHash("sha256").update(s).digest("hex").slice(0, len);
}

export function liveRecordId(finalUrl: string, text: string): string {
  return `${LIVE_ID_PREFIX}${sha(`${finalUrl}\n${text}`)}`;
}

function guessLang(text: string): string {
  const pl = (text.slice(0, 3000).match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) ?? []).length;
  return pl >= 5 ? "pl" : "en";
}

function isoOrNull(s: string | undefined, now: Date): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  if (t > now.getTime() + 86_400_000 || t < Date.UTC(1990, 0, 1)) return null;
  return new Date(t).toISOString();
}

interface PageResult {
  finalUrl: string;
  source: CatalogSource;
  title: string;
  publishedAt: string | null;
  passages: string[];
  /** Rekordy ClaimReview z JSON-LD strony (claimreview.ts); puste dla stron bez recenzji i źródeł bez ocen. */
  reviews: CorpusRecord[];
}

class DeadlineError extends Error {}

/** If a query names a publisher, reserve the second search for its own sites. The first still covers the catalogue. */
function namedPublisherHosts(query: string, catalog: CatalogSource[]): string[] {
  const words = new Set(foldToken(query).match(/[\p{L}\p{N}]+/gu) ?? []);
  return catalog.filter(source => {
    const names = [source.id.replace(/-(pl|org)$/u, ""), ...(source.publisher.match(/\b[\p{Lu}]{2,}\b/gu) ?? [])];
    return names.some(name => words.has(foldToken(name)));
  }).flatMap(source => source.hosts);
}

/** Rozszerzenia plików, których nie czyta fetchPage (tylko HTML i tekst) — nie zajmują miejsca z limitu 5 pobrań. */
const UNSUPPORTED_PATH = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|gz|xml|json|png|jpe?g|gif|svg|mp[34])$/i;

function sourceForHost(catalog: CatalogSource[], host: string): CatalogSource | undefined {
  const wanted = normalizeHost(host);
  return wanted ? catalog.find((s) => s.hosts.includes(wanted)) : undefined;
}

/**
 * Wpis katalogu dla adresu: dokładny host i — gdy źródło ma `pathPrefixes` — ścieżka zaczynająca się od jednego
 * z prefiksów (np. tylko „/eurostat/” na szerokim hoście ec.europa.eu). Ścieżka po normalizacji WHATWG URL (segmenty
 * „..” i „%2e” są już rozwinięte), porównanie z rozróżnieniem wielkości liter. Gdy host ma kilka wpisów, wygrywa
 * wpis z pasującym prefiksem, potem wpis bez prefiksów (cały host).
 */
export function sourceForUrl(catalog: CatalogSource[], url: string): CatalogSource | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const wanted = normalizeHost(parsed.hostname);
  if (!wanted) return undefined;
  const onHost = catalog.filter((s) => s.hosts.includes(wanted));
  const path = parsed.pathname || "/";
  const byPrefix = onHost.find((s) => (s.pathPrefixes?.length ?? 0) > 0 && s.pathPrefixes!.some((p) => p !== "" && path.startsWith(p)));
  return byPrefix ?? onHost.find((s) => !s.pathPrefixes || s.pathPrefixes.length === 0);
}

/**
 * Gałąź wyszukiwania na żywo. Dwa sposoby użycia:
 *  - `createLiveBranch(db, opts)` — pełna implementacja (wyszukiwanie → pobranie → detektor → migawka → punktacja);
 *  - `createLiveBranch(provider?)` — starsza postać z `LiveSearchProvider` (zwraca kandydatów dostawcy).
 */
export function createLiveBranch(provider?: LiveSearchProvider): RetrievalBranch;
export function createLiveBranch(db: Database, opts?: LiveBranchOptions): LiveBranch;
export function createLiveBranch(first?: LiveSearchProvider | Database, opts: LiveBranchOptions = {}): RetrievalBranch {
  if (first && typeof (first as Database).prepare === "function") {
    return createDbLiveBranch(first as Database, opts);
  }
  const provider = first as LiveSearchProvider | undefined;
  return {
    id: "live",
    required: false,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      if (!provider) throw new BranchUnavailableError("live", "no_provider_configured");
      if (queryTexts(q).length === 0) return skipLookup(q);
      const found = await provider.search({
        ...q,
        claim: { ...q.claim, text: stripPiiPlaceholders(q.claim.text) },
        ...(q.extraQueries ? { extraQueries: q.extraQueries.map(stripPiiPlaceholders).filter(Boolean) } : {}),
      });
      return found.map((c) => ({ ...c, via: "live" as const }));
    },
  };
}

/**
 * Skrót dla silnika: tworzy gałąź „live” z konfiguracji aplikacji (OpenAI web_search + model szybki).
 * Bez klucza OpenAI gałąź jest niedostępna (adnotacja w raporcie), nigdy nie rzuca przy tworzeniu.
 */
export function createLiveBranchFromConfig(
  db: Database,
  cfg: Pick<AppConfig, "openaiApiKey" | "openaiDataResidency" | "openaiBaseUrl" | "openaiSearchModel" | "modelFast" | "webSearchDailyCap">,
  opts: LiveBranchOptions = {},
): LiveBranch {
  // onUsage: koszt każdego wyszukiwania trafia do zakresu przebiegu (live-usage.ts) → report.models / costUsd.
  return createDbLiveBranch(db, { searchProvider: createOpenAiSearchProvider(cfg, {
    onUsage: recordLiveUsage,
    reserveRequest: () => reserveLiveRequest(db, opts.now?.() ?? new Date(), cfg.webSearchDailyCap),
  }), ...opts });
}

function createDbLiveBranch(db: Database, opts: LiveBranchOptions): LiveBranch {
  const limits = { ...LIVE_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());
  const fetcher = opts.fetchPage ?? fetchPage;
  const getCatalog = opts.catalog ?? (() => loadCatalog());
  const ttlMs = opts.ttlMs ?? LIVE_TTL_MS;
  try {
    ensureLiveSnapshotsTable(db);
  } catch {
    /* tabela zostanie utworzona przy pierwszym zapisie; błąd zgłosi search() */
  }

  const drop = (url: string, reason: LiveDropReason) => {
    try {
      opts.onDrop?.({ url, reason });
    } catch {
      /* callback nigdy nie psuje gałęzi */
    }
  };
  const emit = (hit: DetectorHit, info: LiveSecurityInfo) => {
    try {
      opts.onSecurityEvent?.(hit, info);
    } catch {
      /* jw. */
    }
  };

  return {
    id: "live",
    required: false,
    timeoutMs: LIVE_BRANCH_TIMEOUT_MS,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      if (!opts.searchProvider) throw new BranchUnavailableError("live", "no_provider_configured");
      throwIfAborted(q.signal);
      const provider = opts.searchProvider;
      const catalog = getCatalog();
      // Per-source policy flag: liveSearch=false (e.g. Demagog — only via Fact Check Tools API; non-IFCN/EFCSN fact-checkers) = never fetched live.
      const allowedSources = catalog.filter((s) => LIVE_ALLOWED_TYPES.has(s.type) && s.liveSearch);
      const allowedHosts = [...new Set(allowedSources.flatMap((s) => s.hosts))];
      if (allowedHosts.length === 0) throw new BranchUnavailableError("live", "no_allowed_hosts");

      // Łączny limit czasu (LIVE_LIMITS.overallTimeoutMs) lub sygnał wywołującego (co nastąpi wcześniej).
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), limits.overallTimeoutMs);
      const signal = q.signal ? AbortSignal.any([q.signal, deadline.signal]) : deadline.signal;
      const deadlinePromise = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new DeadlineError("deadline"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      deadlinePromise.catch(() => {});

      try {
        // 1. Wyszukiwanie (≤ 2): twierdzenie, a jeśli jest — pierwsze dodatkowe zapytanie (np. tłumaczenie EN).
        const texts = queryTexts(q);
        const queries = [...new Set(texts)];
        // Brak zapytania dodatkowego (np. tłumaczenia): drugie wyszukiwanie to same słowa kluczowe twierdzenia —
        // model wyszukiwarki bywa zwraca pustą listę dla pełnego zdania, a dla słów kluczowych trafia.
        if (queries.length === 1 && limits.maxSearches > 1) {
          const kw = keywordQuery(queries[0]!);
          if (kw && kw !== queries[0]) queries.push(kw);
        }
        queries.length = Math.min(queries.length, limits.maxSearches);
        if (queries.length === 0) return skipLookup(q);
        const focusedHosts = namedPublisherHosts(texts.join(" "), allowedSources);
        // Reserve time to actually read the pages even if one of the search requests hangs.
        const searchSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(limits.overallTimeoutMs * 0.75))]);
        const results: (SearchResultItem[] | undefined)[] = [];
        const searches = queries.map(async (text, index) => {
          const hosts = index === 1 && focusedHosts.length ? focusedHosts : allowedHosts;
          results[index] = await provider.search(text, hosts, searchSignal);
        });
        await Promise.race([Promise.allSettled(searches), new Promise<void>(resolve => {
          if (searchSignal.aborted) resolve();
          else searchSignal.addEventListener("abort", () => resolve(), { once: true });
        })]);
        throwIfAborted(q.signal);
        const lists = results.filter((result): result is SearchResultItem[] => result !== undefined);
        if (!lists.length && searchSignal.aborted) throw new BranchUnavailableError("live", "timeout");
        if (lists.length === 0) throw new BranchUnavailableError("live", "search_failed");
        if (lists.length < queries.length) q.onCoverage?.("partial");

        // 2. Kod decyduje: dokładny host w katalogu, typ pierwotne/factcheck, deduplikacja, ≤ 5 stron (na przemian z list).
        const proposals: string[] = [];
        const maxLen = Math.max(...lists.map((l) => l.length));
        for (let i = 0; i < maxLen; i++) for (const l of lists) if (l[i]) proposals.push(l[i]!.url);
        const accepted = filterProposedUrls(proposals.map((url) => ({ url })), allowedHosts).map((p) => p.url);
        const acceptedSet = new Set(accepted);
        for (const url of new Set(proposals)) {
          const canon = canonicalProposal(url);
          if (!canon || !acceptedSet.has(canon)) drop(url, canon && exactHostOf(url) ? "host_not_allowed" : "unreadable_url");
        }
        const pages: PageResult[] = [];
        const toFetch: string[] = [];
        // Różnorodność: najwyżej LIVE_MAX_PER_HOST stron z jednego hosta — host blokujący boty (np. HTTP 429)
        // nie zabiera wtedy całego limitu pobrań, a dowody pochodzą od różnych wydawców.
        const perHost = new Map<string, number>();
        for (const url of accepted) {
          // Wyszukiwarki serwisów i strony wyników odbijają zapytanie albo zbierają fragmenty z dowolnych podstron
          // (fora) — treść nie pochodzi od wydawcy z katalogu, więc nigdy nie jest dowodem.
          if (isSearchResultsUrl(url)) {
            drop(url, "search_page");
            continue;
          }
          if (UNSUPPORTED_PATH.test(new URL(url).pathname)) {
            drop(url, "unsupported_type");
            continue;
          }
          // Źródło zaufane tylko pod częścią hosta (pathPrefixes): adres spoza tych ścieżek nie jest pobierany.
          if (!sourceForUrl(allowedSources, url)) {
            drop(url, "path_not_allowed");
            continue;
          }
          const host = exactHostOf(url) ?? "";
          if ((perHost.get(host) ?? 0) >= LIVE_MAX_PER_HOST || toFetch.length >= limits.maxFetches) continue;
          perHost.set(host, (perHost.get(host) ?? 0) + 1);
          toFetch.push(url);
        }
        if (toFetch.length === 0) return [];

        // 3. Pobranie stron równolegle; wyniki zbierane na bieżąco (po limicie czasu użyjemy tego, co jest).
        let hardFailures = 0;
        const processPage = async (url: string): Promise<PageResult | "failed" | undefined> => {
          let page: FetchedPage;
          try {
            const remaining = Math.max(500, limits.overallTimeoutMs);
            page = await fetcher(url, { timeoutMs: remaining, maxBytes: limits.maxPageBytes, signal });
          } catch (e) {
            // Plik zamiast strony (content_type) to nie awaria: nic nie przeczytano, ale gałąź działa.
            if (e instanceof FetchBlockedError && e.reason === "content_type") {
              drop(url, "unsupported_type");
              return undefined;
            }
            drop(url, "fetch_failed");
            return "failed";
          }
          // Host PO przekierowaniach — ta sama zasada co przed pobraniem.
          const finalHost = exactHostOf(page.finalUrl);
          if (!finalHost || !sourceForHost(allowedSources, finalHost)) {
            drop(url, "final_host_not_allowed");
            return undefined;
          }
          // Ta sama zasada dla ścieżki po przekierowaniach (pathPrefixes); wpis katalogu z końcowego adresu.
          const source = sourceForUrl(allowedSources, page.finalUrl);
          if (!source) {
            drop(url, "path_not_allowed");
            return undefined;
          }
          if (isSearchResultsUrl(page.finalUrl)) {
            drop(url, "search_page");
            return undefined;
          }
          // Detektor na surowej treści (przed czyszczeniem): tekst z ukrytymi elementami + segmenty ukryte.
          const hits: DetectorHit[] = [
            ...detectInjection(page.rawText, "fetched_page", undefined, { hiddenSegments: page.hiddenSegments }),
            ...detectInjection(page.cleanText, "fetched_page"),
          ];
          const dedup = hits.filter((h, i) => hits.findIndex((x) => x.pattern === h.pattern && x.excerpt === h.excerpt) === i);
          const high = dedup.some((h) => h.severity === "high");
          for (const h of dedup) emit(h, { url: page.finalUrl, host: finalHost, pageDropped: high });
          if (high) {
            drop(page.finalUrl, "injection_detected");
            return undefined;
          }
          const clean = dedup.length > 0 ? stripFlaggedSentences(page.cleanText, dedup) : page.cleanText;
          const passages = chunkText(clean, { maxPassages: limits.maxPassagesPerPage });
          if (passages.length === 0) {
            drop(page.finalUrl, "no_text");
            return undefined;
          }
          return {
            finalUrl: page.finalUrl,
            source,
            title: (page.title ?? passages[0]!.split("\n")[0]!).slice(0, 300),
            publishedAt: isoOrNull(page.publishedAt, now()),
            passages,
            reviews: claimReviewRecords({
              rawHtml: page.rawHtml,
              source,
              finalUrl: page.finalUrl,
              fetchedAt: now(),
              onSecurityEvent: (h) => emit(h, { url: page.finalUrl, host: finalHost, pageDropped: false }),
            }),
          };
        };
        const tasks = toFetch.map(async (url) => {
          const res = await processPage(url);
          if (res === "failed") hardFailures++;
          else if (res) pages.push(res);
        });
        await Promise.race([Promise.allSettled(tasks), deadlinePromise]).catch((e) => {
          if (!(e instanceof DeadlineError)) throw e;
          // Limit czasu: zostają strony, które zdążyły się przetworzyć.
        });
        if (hardFailures > 0 || signal.aborted) q.onCoverage?.("partial");
        if (pages.length === 0) {
          if (hardFailures > 0 || signal.aborted) throw new BranchUnavailableError("live", signal.aborted ? "timeout" : "fetch_failed");
          return [];
        }
        throwIfAborted(q.signal);

        // 4. Rekordy + punktacja leksykalna względem twierdzenia.
        const fetchedAt = now();
        const records = new Map<string, CorpusRecord>();
        const inputs: { key: string; title: string; text: string }[] = [];
        for (const pg of [...pages]) {
          for (const text of pg.passages) {
            const id = liveRecordId(pg.finalUrl, text);
            if (records.has(id)) continue;
            records.set(id, {
              id,
              sourceId: pg.source.id,
              url: pg.finalUrl,
              title: pg.title,
              publisher: pg.source.publisher,
              publishedAt: pg.publishedAt,
              fetchedAt: fetchedAt.toISOString(),
              lang: guessLang(text),
              text,
              role: pg.source.role,
              type: pg.source.type,
              level: pg.source.level,
              independenceGroup: pg.source.independenceGroup,
              licence: pg.source.licence,
              topics: [],
              origin: "live_snapshot",
            });
            inputs.push({ key: id, title: pg.title, text });
          }
        }
        const stems = queryStems(texts);
        const reviews = pages.flatMap((pg) => pg.reviews);
        for (const rec of reviews) records.set(rec.id, rec);
        const scored = withClaimReviews(scorePassages(inputs, stems), reviews, stems).slice(0, Math.min(q.limit ?? limits.maxResults, limits.maxResults));
        if (scored.length === 0) return [];

        // 5. Zapis migawek (tylko zwracanych rekordów) — bez tego CorpusStore nie znajdzie rekordu po id.
        const runId = opts.runId?.() ?? `live_${randomUUID()}`;
        try {
          saveLiveSnapshots(
            db,
            runId,
            scored.map((s) => records.get(s.key)!),
            fetchedAt,
            ttlMs,
          );
        } catch {
          throw new BranchUnavailableError("live", "snapshot_store_failed");
        }
        return scored.map((s) => ({ recordId: s.key, score: s.score, via: "live" as const }));
      } catch (e) {
        if (e instanceof BranchUnavailableError) throw e;
        if (e instanceof DeadlineError) throw new BranchUnavailableError("live", "timeout");
        throw new BranchUnavailableError("live", "error");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
