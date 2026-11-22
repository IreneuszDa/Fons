/**
 * Search tool — a SearchProvider may only PROPOSE URLs (PLAN §1.1, §3.4). Code decides what happens next:
 * exact-host check against the catalogue, fetch through src/security, injection detector, snapshot.
 *
 * OpenAI implementation: Responses API, hosted `web_search` tool restricted with
 * `filters.allowed_domains` (docs: developers.openai.com/api/docs/guides/tools-web-search).
 *  - The domain filter includes SUBDOMAINS of every listed domain, so it is only a hint for the provider:
 *    `filterProposedUrls` re-checks every returned URL against the exact catalogue hosts in code.
 *  - Only URLs are taken from the response (`url_citation` annotations and `web_search_call.action.sources`).
 *    The model's prose — including URLs written in it — is discarded and never reaches the verdict.
 *  - On-site search / results pages and free-text queries are rejected by code (`isSearchResultsUrl`).
 *  - store:false (nothing is kept on the provider side), plain fetch, no new dependencies.
 *  - OPENAI_DATA_RESIDENCY handling as in src/engine/llm/openai.ts (same base-URL helper).
 *  - Provider error bodies are never surfaced — only SearchUnavailableError reasons (PLAN §1.3).
 *
 * Residual risk (disclosed in docs/TOOLS.md): the search model sees the claim text (user-controlled) and has
 * one read-only tool. Its output is reduced to a URL list that code validates, so the worst a manipulated search
 * model can do is change WHICH allow-listed pages get fetched (they still pass the detector).
 */
import { fence, UNTRUSTED_DATA_RULES } from "../engine/llm/fence";
import { openAiBaseUrl } from "../engine/llm/openai";
import { costUsd } from "../engine/llm/pricing";

export interface SearchResultItem {
  url: string;
  title?: string;
}

export interface SearchProvider {
  readonly id: string;
  /**
   * Proposes pages for `query`. `allowedHosts` are exact catalogue hosts; implementations should restrict the
   * search to them, and callers re-check the result anyway (use `filterProposedUrls`).
   */
  search(query: string, allowedHosts: string[], signal?: AbortSignal): Promise<SearchResultItem[]>;
}

export type SearchUnavailableReason = "no_key" | "timeout" | "rate_limit" | "budget" | "provider_error" | "residency" | "bad_response";

/** Technical failure of the search provider. The message never contains provider error text. */
export class SearchUnavailableError extends Error {
  constructor(
    public readonly reason: SearchUnavailableReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "SearchUnavailableError";
  }
}

export interface SearchUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Billed web search calls ($10 / 1k calls on top of tokens). */
  searchCalls: number;
  latencyMs: number;
  costUsd: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiSearchProviderOptions {
  apiKey?: string;
  /** Model used for the hosted search (cheap, fast tier recommended). */
  model: string;
  /** "eu" → eu.api.openai.com; anything else → api.openai.com (US). */
  dataResidency?: string;
  /** Overall timeout of one Responses API request, including compatibility retries. */
  timeoutMs?: number;
  /** Max proposed URLs returned (default 8). */
  maxResults?: number;
  /** Hosted searches available within one request. The live branch owns the fallback decision. */
  maxToolCalls?: 1 | 2;
  /** Reasoning effort sent to the model (default "low"; dropped automatically if the model rejects it). */
  effort?: "low" | "medium" | "high";
  onUsage?: (usage: SearchUsage) => void;
  /** Production reserves each outgoing HTTP attempt atomically, before sending the request. */
  reserveRequest?: () => boolean;
  /** Injected for tests. */
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

/** Price of one hosted web search call (USD), from the OpenAI price list ($10 / 1k calls). */
export const WEB_SEARCH_CALL_USD = 0.01;
/** The API accepts at most 100 allowed domains. */
export const MAX_ALLOWED_DOMAINS = 100;
export const DEFAULT_SEARCH_TIMEOUT_MS = 22_000;
export const DEFAULT_MAX_PROPOSALS = 8;
const MAX_QUERY_CHARS = 400;

export function normalizeHostName(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Exact hostname of an http(s) URL without credentials, or undefined. */
export function exactHostOf(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  const h = normalizeHostName(u.hostname);
  return h === "" ? undefined : h;
}

/** Strips the fragment so that one page is not fetched twice. */
export function canonicalProposal(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return undefined;
  }
}

/** Path segments of on-site search / results pages (PL + EN). */
const SEARCH_PATH = /(^|\/)(search|search-results|searchresults|results|szukaj|wyszukiwarka|wyszukaj|suche|recherche|poisk|poshuk)(\/|\.[a-z]{2,5}$|$)/i;
/** Query parameter names that carry free text on search pages. */
const SEARCH_PARAM = /^(q|qs|s|query|querytext|text|search|searchtext|search_api_fulltext|fulltext|keys?|keywords?|phrase|term|szukaj|fraza|wyszukaj)$/i;

/**
 * True when the URL is an on-site search / results page or carries free text in its query string.
 * Such pages echo the query back (e.g. „Search results for …”) or list snippets from arbitrary subsites (forums),
 * so text typed by the user or planted by a third party would become evidence attributed to the catalogue source.
 * Legitimate identifier queries (e.g. `DocDetails.xsp?id=WDU20240000123`) are kept.
 */
export function isSearchResultsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  if (SEARCH_PATH.test(path)) return true;
  for (const [k, v] of u.searchParams) {
    if (SEARCH_PARAM.test(k.trim())) return true;
    // Free text in any parameter (several words or a long value) = reflected input, not an identifier.
    if (v.trim().split(/\s+/).filter(Boolean).length >= 3 || v.length > 120) return true;
  }
  return false;
}

/**
 * Code-side filter: keeps only http(s) URLs whose EXACT host is in `allowedHosts` (no subdomain inheritance),
 * deduplicates, preserves order. This is the real allow-list; the provider-side domain filter is a hint.
 */
export function filterProposedUrls(items: SearchResultItem[], allowedHosts: readonly string[]): SearchResultItem[] {
  const allowed = new Set(allowedHosts.map(normalizeHostName));
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const it of items) {
    if (!it || typeof it.url !== "string") continue;
    const host = exactHostOf(it.url);
    const canon = canonicalProposal(it.url);
    if (!host || !canon || !allowed.has(host) || seen.has(canon)) continue;
    seen.add(canon);
    out.push({ url: canon, ...(it.title ? { title: it.title } : {}) });
  }
  return out;
}

const SEARCH_SYSTEM =
  "Jesteś wyszukiwarką stron. Zadanie: wyszukaj w dozwolonych serwisach strony, na których można sprawdzić podane twierdzenie " +
  "(akty prawne, komunikaty urzędowe, dane, fact-checki). Szukaj również w języku miejsca zdarzenia. " +
  "Jeżeli pytanie dotyczy przebiegu lub wyniku wydarzenia, szukaj relacji sporządzonych w trakcie lub po nim. Zapowiedź potwierdza wyłącznie plan. " +
  "Nie oceniaj twierdzenia i nie odpowiadaj na nie z własnej wiedzy — wypisz tylko znalezione adresy stron z tytułami. " +
  "Najpierw szukaj: (1) fact-checków tego twierdzenia, (2) oficjalnej strony instytucji, której twierdzenie dotyczy " +
  "(np. lista członków, biografia osoby na urzędzie, komunikat, akt prawny), (3) strony z aktualnym stanem rzeczy, gdy twierdzenie " +
  "mówi o zmianie (np. czy państwo nadal jest członkiem, kto obecnie pełni urząd). Podawaj strony z różnych serwisów — najwyżej 2 z jednego. " +
  UNTRUSTED_DATA_RULES;

export function buildSearchRequestBody(
  query: string,
  allowedHosts: string[],
  opts: { model: string; effort?: "low" | "medium" | "high" | null; maxToolCalls?: number | null; maxOutputTokens?: number | null },
): Record<string, unknown> {
  const domains = [...new Set(allowedHosts.map(normalizeHostName))].filter(Boolean).slice(0, MAX_ALLOWED_DOMAINS);
  const claim = fence("TWIERDZENIE", query.slice(0, MAX_QUERY_CHARS).replace(/\s+/g, " ").trim());
  const body: Record<string, unknown> = {
    model: opts.model,
    store: false,
    instructions: domains.length === 1
      ? `${SEARCH_SYSTEM}\nTo kwerenda u wskazanego wydawcy. Użyj operatora site:${domains[0]} i odszukaj publikację bezpośrednio w tym serwisie.`
      : SEARCH_SYSTEM,
    input: `Twierdzenie do sprawdzenia:\n${claim.text}`,
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: domains },
        search_context_size: "low",
      },
    ],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
  };
  if (opts.effort !== null && opts.effort !== undefined) body.reasoning = { effort: opts.effort };
  if (opts.maxToolCalls !== null && opts.maxToolCalls !== undefined) body.max_tool_calls = opts.maxToolCalls;
  if (opts.maxOutputTokens !== null && opts.maxOutputTokens !== undefined) body.max_output_tokens = opts.maxOutputTokens;
  return body;
}

interface ResponsesLike {
  status?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  output?: {
    type?: string;
    status?: string;
    action?: { type?: string; sources?: { type?: string; url?: string }[] };
    content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  }[];
}

/**
 * Extracts proposed URLs from a Responses API body. Order = relevance: `url_citation` annotations, then the full
 * `sources` list of each web_search_call. Only URLs and citation titles are read — the model's prose is ignored
 * entirely, including URLs written in it: the search model sees the user's text, so a URL the user pasted
 * („Źródło: https://…”) could be repeated in prose and must not gain the trust of a search result (SEC-01).
 */
export function extractProposals(json: ResponsesLike): { items: SearchResultItem[]; searchCalls: number } {
  const cited: SearchResultItem[] = [];
  const sourced: SearchResultItem[] = [];
  let searchCalls = 0;
  for (const item of json.output ?? []) {
    if (item?.type === "web_search_call") {
      if (!item.action || item.action.type === "search" || item.action.type === undefined) searchCalls++;
      for (const s of item.action?.sources ?? []) {
        if (typeof s?.url === "string") sourced.push({ url: s.url });
      }
    } else if (item?.type === "message") {
      for (const c of item.content ?? []) {
        for (const a of c?.annotations ?? []) {
          if (a?.type === "url_citation" && typeof a.url === "string") {
            cited.push({ url: a.url, ...(typeof a.title === "string" && a.title ? { title: a.title.slice(0, 300) } : {}) });
          }
        }
      }
    }
  }
  const titles = new Map(cited.map((c) => [canonicalProposal(c.url) ?? c.url, c.title]));
  const merged = [...cited, ...sourced].map((c) => ({ url: c.url, title: c.title ?? titles.get(canonicalProposal(c.url) ?? c.url) }));
  return { items: merged.map((m) => ({ url: m.url, ...(m.title ? { title: m.title } : {}) })), searchCalls };
}

export class OpenAiSearchProvider implements SearchProvider {
  readonly id = "openai-web-search";
  readonly processingRegion: "eea" | "us";
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxToolCalls: 1 | 2;
  private readonly onUsage?: (u: SearchUsage) => void;
  private readonly reserveRequest?: () => boolean;
  private supportsReasoning = true;
  private readonly effort: "low" | "medium" | "high";
  static residencyWarned = false;

  constructor(opts: OpenAiSearchProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? openAiBaseUrl(opts.dataResidency);
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.maxResults = opts.maxResults ?? DEFAULT_MAX_PROPOSALS;
    this.maxToolCalls = opts.maxToolCalls ?? 2;
    this.onUsage = opts.onUsage;
    this.reserveRequest = opts.reserveRequest;
    this.effort = opts.effort ?? "low";
    this.processingRegion = opts.dataResidency?.trim().toLowerCase() === "eu" ? "eea" : "us";
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  async search(query: string, allowedHosts: string[], signal?: AbortSignal): Promise<SearchResultItem[]> {
    if (!this.apiKey) throw new SearchUnavailableError("no_key");
    const q = query.trim();
    if (q === "" || allowedHosts.length === 0) return [];
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = buildSearchRequestBody(q, allowedHosts, {
        model: this.model,
        effort: this.supportsReasoning ? this.effort : null,
        maxToolCalls: this.maxToolCalls,
        maxOutputTokens: 1200,
      });
      let res: Response;
      if (sig.aborted) throw new SearchUnavailableError("timeout");
      if (this.reserveRequest && !this.reserveRequest()) throw new SearchUnavailableError("budget");
      try {
        res = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: sig,
        });
      } catch (e) {
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) throw new SearchUnavailableError("timeout");
        throw new SearchUnavailableError("provider_error", "connection");
      }
      if (!res.ok) {
        let errText = "";
        try {
          errText = await res.text();
        } catch {
          /* ignore */
        }
        if (res.status === 400) {
          // Model compatibility retries must retain the spending caps, including under concurrent searches.
          if (body.reasoning && errText.includes("reasoning")) {
            this.supportsReasoning = false;
            continue;
          }
          throw new SearchUnavailableError("provider_error", "status_400");
        }
        if (res.status === 429) throw new SearchUnavailableError(/insufficient_quota/.test(errText) ? "budget" : "rate_limit");
        if (res.status === 401 && /geography restrictions/i.test(errText)) {
          if (!OpenAiSearchProvider.residencyWarned) {
            OpenAiSearchProvider.residencyWarned = true;
            console.warn(
              "[search] OPENAI_DATA_RESIDENCY=eu, ale projekt OpenAI nie ma rezydencji danych w UE — wyszukiwanie na żywo wyłączone. " +
                "Usuń OPENAI_DATA_RESIDENCY (przetwarzanie w USA, raport to ujawnia).",
            );
          }
          throw new SearchUnavailableError("residency");
        }
        if (res.status === 401 || res.status === 403) throw new SearchUnavailableError("provider_error", "auth");
        if (res.status === 408 || res.status === 504) throw new SearchUnavailableError("timeout");
        throw new SearchUnavailableError("provider_error", `status_${res.status}`);
      }

      let json: ResponsesLike;
      try {
        json = (await res.json()) as ResponsesLike;
      } catch {
        throw new SearchUnavailableError("bad_response", "invalid_json");
      }
      if (!json || typeof json !== "object") throw new SearchUnavailableError("bad_response", "invalid_response");
      const { items, searchCalls } = extractProposals({ output: Array.isArray(json.output) ? json.output : [] });
      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;
      const model = json.model ?? this.model;
      this.onUsage?.({
        provider: "openai",
        model,
        inputTokens,
        outputTokens,
        searchCalls,
        latencyMs: Date.now() - started,
        costUsd: Math.round((costUsd(model, "openai", inputTokens, outputTokens) + searchCalls * WEB_SEARCH_CALL_USD) * 1e6) / 1e6,
      });
      // An HTTP 200 can also represent a failed response or an answer without a tool call.
      // Account for returned usage first, but only a completed search can establish search coverage.
      const completedSearch = Array.isArray(json.output) && json.output.some(item => item?.type === "web_search_call" &&
        item.status === "completed" && item.action?.type === "search");
      if (json.status !== "completed" || !completedSearch) throw new SearchUnavailableError("bad_response", "search_not_completed");
      return filterProposedUrls(items, allowedHosts).slice(0, this.maxResults);
    }
    throw new SearchUnavailableError("provider_error", "unsupported_parameters");
  }
}

export interface SearchProviderConfig {
  openaiApiKey?: string;
  openaiDataResidency?: string;
  openaiSearchModel?: string;
  modelFast: string;
}

/** Builds the default search provider from the app config (OpenAI web search with the fast model). */
export function createOpenAiSearchProvider(
  cfg: SearchProviderConfig,
  extra: Partial<OpenAiSearchProviderOptions> = {},
): OpenAiSearchProvider {
  return new OpenAiSearchProvider({
    apiKey: cfg.openaiApiKey,
    model: cfg.openaiSearchModel ?? cfg.modelFast,
    dataResidency: cfg.openaiDataResidency,
    ...extra,
  });
}
