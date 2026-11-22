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
 * Znane dokumenty sprawdzane są lokalnie; przy pytaniach o bieżące wydarzenia pobieramy świeżą treść.
 * Drugie wyszukiwanie następuje po odczycie stron, jeżeli wciąż brakuje jednoznacznego dowodu.
 * Limity na twierdzenie: najwyżej 2 wyszukiwania, 5 pobrań stron (najwyżej 2 z jednego hosta), 30 s łącznie.
 *
 * Uwaga o rolach: zwykłe fragmenty stron fact-checków mają rolę `stala_rola` z katalogu, ale bez oceny, więc nigdy nie
 * rozstrzygają (decisive.ts wymaga rating.mapped). Rozstrzygać może rekord ClaimReview (3a) — ocena znana tabeli
 * mapowania i poziom z katalogu ≤ 2 — dokładnie jak rekord ClaimReview z korpusu (reguła 6).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { loadCatalog, normalizeHost } from "../../corpus/catalog";
import { detectInjection, stripFlaggedSentences } from "../../security/detector";
import { relativeWindowDay } from "../../security/dates";
import { FetchBlockedError, fetchPage, type FetchedPage } from "../../security/fetch";
import type { AppConfig } from "../../server/config";
import {
  canonicalProposal,
  createOpenAiSearchProvider,
  exactHostOf,
  isSearchResultsUrl,
  SearchUnavailableError,
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
import { guessLang } from "../../shared/language";
import { queryTexts } from "./bm25";
import { claimReviewRecords, withClaimReviews } from "./claimreview";
import { BranchUnavailableError, skipLookup, throwIfAborted } from "./errors";
import { stripPiiPlaceholders } from "./fts";
import { chunkText, foldToken, keywordQuery, queryStems, scorePassages } from "./live-score";
import {
  ensureLiveSnapshotsTable, findLiveDocuments, getLiveDocument, invalidateLiveDocument, LIVE_ID_PREFIX, LIVE_TTL_MS,
  requiresFreshDocument, reserveLiveRequest, saveLiveDocument, saveLiveSnapshots, type LiveDocument,
} from "./live-store";
import { canFinishLiveSearch } from "./live-sufficiency";
import { currentLiveScope, recordLiveUsage } from "./live-usage";

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

function isoOrNull(s: string | undefined, now: Date): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  if (t > now.getTime() + 86_400_000 || t < Date.UTC(1990, 0, 1)) return null;
  return new Date(t).toISOString();
}

interface PageResult extends LiveDocument {
  source: CatalogSource;
}

class DeadlineError extends Error {}

/** An injected provider may ignore cancellation. Late results must never enter this search. */
async function withinSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new DeadlineError();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new DeadlineError()); });
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

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

/** The first and fallback queries share one deadline, one page budget and one catalogue policy. */
class LiveSearchRounds {
  private readonly rejected = new Set<string>();
  private readonly scheduled = new Set<string>();
  private readonly perHost = new Map<string, number>();
  completed = 0;
  failed = false;
  timedOut = false;
  providerBlocked = false;

  constructor(
    private readonly provider: SearchProvider | undefined,
    private readonly allowedHosts: string[],
    private readonly sources: CatalogSource[],
    private readonly limits: LiveLimits,
    private readonly signal: AbortSignal,
    private readonly endsAt: number,
    private readonly day: string | undefined,
    private readonly drop: (url: string, reason: LiveDropReason) => void,
  ) {}

  stageSignal(fraction: number): AbortSignal {
    const ms = Math.max(1, Math.ceil((this.endsAt - Date.now()) * fraction));
    return AbortSignal.any([this.signal, AbortSignal.timeout(ms)]);
  }

  async discover(text: string, hosts: string[], timeFraction: number): Promise<string[]> {
    const provider = this.provider;
    if (!provider) throw new BranchUnavailableError("live", "no_provider_configured");
    const signal = this.stageSignal(timeFraction);
    let proposals: SearchResultItem[];
    try {
      const query = this.day ? `${text} (data pytania: ${this.day})` : text;
      proposals = await withinSignal(signal, () => provider.search(query, hosts, signal));
      this.completed++;
    } catch (err) {
      this.failed = true;
      this.timedOut ||= signal.aborted;
      this.providerBlocked = err instanceof SearchUnavailableError && ["no_key", "budget", "rate_limit", "residency"].includes(err.reason);
      return [];
    }
    const urls = new Set<string>();
    for (const proposal of proposals) {
      const url = canonicalProposal(proposal.url) ?? proposal.url;
      if (this.rejected.has(url)) continue;
      const host = exactHostOf(url);
      let reason: LiveDropReason | undefined;
      if (!host || !this.allowedHosts.includes(host)) reason = host ? "host_not_allowed" : "unreadable_url";
      else if (isSearchResultsUrl(url)) reason = "search_page";
      else if (UNSUPPORTED_PATH.test(new URL(url).pathname)) reason = "unsupported_type";
      else if (!sourceForUrl(this.sources, url)) reason = "path_not_allowed";
      if (reason) {
        this.rejected.add(url);
        this.drop(url, reason);
      } else urls.add(url);
    }
    return [...urls];
  }

  get remaining(): number {
    return this.limits.maxFetches - this.scheduled.size;
  }

  take(urls: string[], count: number): string[] {
    const batch: string[] = [];
    for (const url of urls) {
      if (batch.length >= count || this.remaining <= 0) break;
      const host = exactHostOf(url)!;
      const used = this.perHost.get(host) ?? 0;
      if (used >= LIVE_MAX_PER_HOST || this.scheduled.has(url)) continue;
      this.perHost.set(host, used + 1);
      this.scheduled.add(url);
      batch.push(url);
    }
    return batch;
  }
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
  cfg: Pick<AppConfig, "openaiApiKey" | "openaiDataResidency" | "openaiSearchModel" | "modelFast" | "webSearchDailyCap">,
  opts: LiveBranchOptions = {},
): LiveBranch {
  // onUsage: koszt każdego wyszukiwania trafia do zakresu przebiegu (live-usage.ts) → report.models / costUsd.
  return createDbLiveBranch(db, { searchProvider: createOpenAiSearchProvider(cfg, {
    maxToolCalls: 1,
    onUsage: recordLiveUsage,
    reserveRequest: () => {
      const granted = reserveLiveRequest(db, opts.now?.() ?? new Date(), cfg.webSearchDailyCap);
      const scope = currentLiveScope();
      if (!granted && scope) scope.dailySearchLimitReached = true;
      return granted;
    },
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
      throwIfAborted(q.signal);
      const provider = opts.searchProvider;
      const catalog = getCatalog();
      // Per-source policy flag: liveSearch=false (e.g. Demagog — only via Fact Check Tools API; non-IFCN/EFCSN fact-checkers) = never fetched live.
      const allowedSources = catalog.filter((s) => LIVE_ALLOWED_TYPES.has(s.type) && s.liveSearch);
      const allowedHosts = [...new Set(allowedSources.flatMap((s) => s.hosts))];
      if (allowedHosts.length === 0) throw new BranchUnavailableError("live", "no_allowed_hosts");

      // Łączny limit czasu (LIVE_LIMITS.overallTimeoutMs) lub sygnał wywołującego (co nastąpi wcześniej).
      const deadline = new AbortController();
      const endsAt = Date.now() + limits.overallTimeoutMs;
      const timer = setTimeout(() => deadline.abort(), limits.overallTimeoutMs);
      const signal = q.signal ? AbortSignal.any([q.signal, deadline.signal]) : deadline.signal;

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
        if (queries.length === 0 || limits.maxFetches <= 0) return skipLookup(q);
        const focusedHosts = namedPublisherHosts(texts.join(" "), allowedSources);
        const asOf = Date.parse(q.asOf ?? "");
        const day = Number.isFinite(asOf) ? relativeWindowDay(texts[0]!, new Date(asOf)) : undefined;
        const refresh = requiresFreshDocument(q);
        const pages: PageResult[] = [];
        const readCached = (url: string): PageResult | undefined => {
          if (refresh || !exactHostOf(url) || isSearchResultsUrl(url) || UNSUPPORTED_PATH.test(new URL(url).pathname)) return;
          const source = sourceForUrl(allowedSources, url);
          const document = source && getLiveDocument(db, url, now(), source);
          if (source && document) return { ...document, source };
        };
        let hardFailures = 0;
        const processPage = async (url: string, fetchSignal: AbortSignal): Promise<PageResult | "failed" | undefined> => {
          const cached = readCached(url);
          if (cached && !cached.isExcerpt) return cached;
          let page: FetchedPage;
          try {
            page = await fetcher(url, { timeoutMs: Math.max(1, endsAt - Date.now()), maxBytes: limits.maxPageBytes, signal: fetchSignal });
            if (fetchSignal.aborted) return "failed";
          } catch (e) {
            if (e instanceof FetchBlockedError && (e.httpStatus === 404 || e.httpStatus === 410 ||
              ["scheme", "port", "private_ip", "too_large", "content_type"].includes(e.reason))) {
              invalidateLiveDocument(db, url);
            }
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
            invalidateLiveDocument(db, url);
            drop(url, "final_host_not_allowed");
            return undefined;
          }
          // Ta sama zasada dla ścieżki po przekierowaniach (pathPrefixes); wpis katalogu z końcowego adresu.
          const source = sourceForUrl(allowedSources, page.finalUrl);
          if (!source) {
            invalidateLiveDocument(db, url);
            drop(url, "path_not_allowed");
            return undefined;
          }
          if (isSearchResultsUrl(page.finalUrl)) {
            invalidateLiveDocument(db, url);
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
            invalidateLiveDocument(db, url);
            invalidateLiveDocument(db, page.finalUrl);
            drop(page.finalUrl, "injection_detected");
            return undefined;
          }
          const clean = dedup.length > 0 ? stripFlaggedSentences(page.cleanText, dedup) : page.cleanText;
          const passages = chunkText(clean, { maxPassages: limits.maxPassagesPerPage });
          if (passages.length === 0) {
            invalidateLiveDocument(db, url);
            invalidateLiveDocument(db, page.finalUrl);
            drop(page.finalUrl, "no_text");
            return undefined;
          }
          const fetchedAt = now();
          let hasSecurityEvents = dedup.length > 0;
          const document: LiveDocument = {
            finalUrl: page.finalUrl,
            title: (page.title ?? passages[0]!.split("\n")[0]!).slice(0, 300),
            publishedAt: isoOrNull(page.publishedAt, fetchedAt),
            fetchedAt: fetchedAt.toISOString(),
            passages,
            lang: page.lang,
            reviews: claimReviewRecords({
              rawHtml: page.rawHtml,
              lang: page.lang,
              source,
              finalUrl: page.finalUrl,
              fetchedAt,
              onSecurityEvent: (h) => {
                hasSecurityEvents = true;
                emit(h, { url: page.finalUrl, host: finalHost, pageDropped: false });
              },
            }),
          };
          if (url !== page.finalUrl) invalidateLiveDocument(db, url);
          if (hasSecurityEvents) invalidateLiveDocument(db, page.finalUrl);
          else saveLiveDocument(db, document, source, ttlMs, texts[0]);
          return { ...document, source };
        };
        const searches = new LiveSearchRounds(provider, allowedHosts, allowedSources, limits, signal, endsAt, day, drop);
        const read = async (urls: string[], stageSignal: AbortSignal) => {
          await Promise.all(urls.map(async url => {
            try {
              const page = await withinSignal(stageSignal, () => processPage(url, stageSignal));
              if (page === "failed") hardFailures++;
              else if (page && !pages.some(p => p.finalUrl === page.finalUrl)) pages.push(page);
            } catch {
              hardFailures++;
            }
          }));
        };
        let sufficient = false;
        if (!refresh) {
          const urls = findLiveDocuments(db, texts[0]!, now());
          const cached = urls.map(readCached).filter((p): p is PageResult => !!p);
          if (canFinishLiveSearch(q, texts, cached, focusedHosts)) {
            const excerpts = cached.filter(p => p.isExcerpt);
            // A short excerpt may omit a correction. Reopen the known URL before trusting it,
            // and leave room in the shared page budget for discovery if the full text disagrees.
            if (excerpts.length <= Math.floor(limits.maxFetches / 2)) {
              pages.push(...cached.filter(p => !p.isExcerpt));
              const selected = searches.take(excerpts.map(p => p.finalUrl), excerpts.length);
              await read(selected, searches.stageSignal(0.2));
              sufficient = pages.length === cached.length && canFinishLiveSearch(q, texts, pages, focusedHosts);
            }
          }
        }
        if (!sufficient) {
          throwIfAborted(signal);
          const first = await searches.discover(queries[0]!, allowedHosts, queries.length > 1 ? 0.55 : 0.75);
          const hasFallback = queries.length > 1 && !searches.providerBlocked;
          const firstBatch = searches.take(first, hasFallback ? Math.ceil(searches.remaining / 2) : searches.remaining);
          await read(firstBatch, hasFallback ? searches.stageSignal(0.45) : signal);
          throwIfAborted(q.signal);
          let followup: string[] = [];
          if (hasFallback && searches.remaining > 0 && !signal.aborted && (hardFailures > 0 || !canFinishLiveSearch(q, texts, pages, focusedHosts))) {
            followup = await searches.discover(queries[1]!, focusedHosts.length ? focusedHosts : allowedHosts, 0.75);
          }
          if (!signal.aborted) await read(searches.take([...followup, ...first], limits.maxFetches), signal);
          if (searches.failed || hardFailures || signal.aborted) q.onCoverage?.("partial");
          if (!searches.completed) throw new BranchUnavailableError("live", searches.timedOut ? "timeout" : "search_failed");
        }
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
              fetchedAt: pg.fetchedAt,
              lang: guessLang(text, pg.lang),
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
        const reviews = pages.flatMap((pg) => pg.reviews);
        for (const rec of reviews) records.set(rec.id, rec);
        // A translated query is an alternative expression of the same claim. Requiring a
        // single passage to cover vocabulary from both languages discards relevant pages.
        const ranked = new Map<string, ReturnType<typeof scorePassages>[number]>();
        for (const query of new Set(texts)) {
          const terms = queryStems([query]);
          for (const match of withClaimReviews(scorePassages(inputs, terms), reviews, terms)) {
            if (match.score > (ranked.get(match.key)?.score ?? -1)) ranked.set(match.key, match);
          }
        }
        const scored = [...ranked.values()].sort((a, b) => Number(!!records.get(b.key)?.claimReviewed) - Number(!!records.get(a.key)?.claimReviewed) || b.score - a.score)
          .slice(0, Math.min(q.limit ?? limits.maxResults, limits.maxResults));
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
