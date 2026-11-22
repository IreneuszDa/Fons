/**
 * Moduł wyszukiwania — gałęzie BM25 / wektory / incydenty / live, łączenie RRF, limity czasu gałęzi.
 * Interfejs obowiązujący: docs/MODULES.md → `src/engine/retrieval/`.
 */
import type { Database } from "better-sqlite3";
import type { EvidenceCandidate, RetrievalBranch, RetrievalQuery, SourceActivity } from "../../shared/contracts";
import { createBm25Branch } from "./bm25";
import type { Embedder } from "./embedder";
import { isWarmable, type BranchStatus } from "./errors";
import { limitWithSemanticFactChecks, reciprocalRankFusion, RRF_K, weightsFor } from "./fusion";
import { createIncidentBranch, matchIncidentDomains } from "./incidents";
import type { AppConfig } from "../../server/config";
import { createLiveBranch, createLiveBranchFromConfig, type LiveBranchOptions, type LiveSearchProvider } from "./live";
import { createOfficialBranch } from "./official";
import { createVectorBranch } from "./vector";

export { matchIncidentDomains } from "./incidents";
export { BranchUnavailableError, isWarmable } from "./errors";
export type { BranchStatus, WarmableBranch } from "./errors";
export { createBm25Branch } from "./bm25";
export { createIncidentBranch } from "./incidents";
export { createVectorBranch, type VectorBranch, type VectorBranchOptions } from "./vector";
export { createLiveBranch, type LiveSearchProvider } from "./live";
export { createOfficialBranch, pinOfficialRecords } from "./official";
export { createE5Embedder, E5_MODEL_ID, type Embedder } from "./embedder";
export { reciprocalRankFusion } from "./fusion";
export { buildMatchQuery } from "./fts";

export const DEFAULT_PER_BRANCH_TIMEOUT_MS = 4000;
export const DEFAULT_MAX_RESULTS = 24;

export interface CreateBranchesOptions {
  liveSearch: boolean;
  /**
   * Gałąź „official” (oficjalne kanały instytucji z data/authorities.yaml); działa tylko przy liveSearch=true.
   * Zdarzenia bezpieczeństwa zgłasza przez `liveOptions.onSecurityEvent`.
   */
  official?: boolean;
  /** Wyłączenie gałęzi wektorowej (np. środowisko bez modelu); domyślnie włączona. */
  vector?: boolean;
  /** Wstrzyknięcie embeddera i ścieżki manifestu (testy / niestandardowe wdrożenia). */
  embedder?: Embedder;
  manifestPath?: string;
  /** Dostawca wyszukiwania na żywo; bez niego gałąź „live” (gdy liveSearch=true) zgłasza niedostępność. */
  liveProvider?: LiveSearchProvider;
  /** Konfiguracja pełnej gałęzi „live” (wyszukiwanie w hostach z katalogu); ma pierwszeństwo przed liveProvider. */
  liveConfig?: Pick<AppConfig, "openaiApiKey" | "openaiDataResidency" | "openaiSearchModel" | "modelFast" | "webSearchDailyCap">;
  /** Wywołania zwrotne pełnej gałęzi „live” (zdarzenia bezpieczeństwa, odrzucone strony). */
  liveOptions?: Pick<LiveBranchOptions, "onSecurityEvent" | "onDrop">;
}

/** Tworzy gałęzie: bm25 (konieczna), vector, incident, oraz official i live tylko przy liveSearch=true. */
export function createRetrievalBranches(db: Database, opts: CreateBranchesOptions): RetrievalBranch[] {
  const branches: RetrievalBranch[] = [createBm25Branch(db)];
  if (opts.vector !== false) {
    branches.push(createVectorBranch(db, { embedder: opts.embedder, manifestPath: opts.manifestPath }));
  }
  branches.push(createIncidentBranch(db));
  if (opts.liveSearch) {
    // Najpierw oficjalny kanał instytucji wskazanej w twierdzeniu (bez wyszukiwarki), potem wyszukiwanie w katalogu.
    if (opts.official !== false) {
      const onSecurityEvent = opts.liveOptions?.onSecurityEvent;
      branches.push(
        createOfficialBranch(db, {
          onSecurityEvent: onSecurityEvent
            ? (hit, info) => onSecurityEvent(hit, { ...info, pageDropped: hit.severity === "high" })
            : undefined,
        }),
      );
    }
    branches.push(opts.liveConfig && !opts.liveProvider ? createLiveBranchFromConfig(db, opts.liveConfig, opts.liveOptions ?? {}) : createLiveBranch(opts.liveProvider));
  }
  return branches;
}

/**
 * Rozgrzewka przy starcie serwera: ładuje model i weryfikuje indeks wektorów, żeby pierwsze zapytanie
 * nie przekroczyło limitu czasu gałęzi. Nigdy nie rzuca; zwraca stan każdej gałęzi, która potrafi się rozgrzać.
 */
export async function warmUp(branches: RetrievalBranch[]): Promise<Record<string, BranchStatus>> {
  const result: Record<string, BranchStatus> = {};
  await Promise.all(
    branches.filter(isWarmable).map(async (b) => {
      try {
        result[b.id] = await b.warmUp();
      } catch {
        result[b.id] = { available: false, reason: "warmup_failed" };
      }
    }),
  );
  return result;
}

export interface RetrieveOptions {
  perBranchTimeoutMs?: number;
  /** Maks. liczba zwróconych kandydatów (domyślnie q.limit albo 24). */
  maxResults?: number;
  /** Stała k w RRF (domyślnie 60). */
  rrfK?: number;
  onBranchResult?: (id: string, status: SourceActivity["branches"][number]["status"], candidates: EvidenceCandidate[]) => void;
}

export interface RetrieveResult {
  candidates: EvidenceCandidate[];
  /** Identyfikatory gałęzi, które nie zadziałały (błąd, limit czasu, niedostępność). */
  unavailable: string[];
  /**
   * true → nie wolno wydać werdyktu (PLAN §1.3): padła gałąź konieczna, wszystkie gałęzie zawiodły
   * albo nie podano żadnej gałęzi.
   */
  requiredFailed: boolean;
}

function branchTimeout(b: RetrievalBranch): number {
  const t = (b as { timeoutMs?: unknown }).timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
}

class BranchTimeout extends Error {
  constructor() {
    super("branch timeout");
    this.name = "BranchTimeout";
  }
}

async function runBranch(
  branch: RetrievalBranch,
  q: RetrievalQuery,
  timeoutMs: number,
): Promise<{ ok: true; status: "completed" | "partial" | "skipped"; list: EvidenceCandidate[] } | { ok: false }> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (q.signal) {
    if (q.signal.aborted) controller.abort();
    else q.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    let status: "completed" | "partial" | "skipped" = "completed";
    const work = Promise.resolve().then(() => branch.search({ ...q, signal: controller.signal, onCoverage: coverage => { status = coverage; } }));
    work.catch(() => {}); // spóźniony błąd po limicie czasu nie może zostać nieobsłużony
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BranchTimeout());
      }, timeoutMs);
    });
    const list = await Promise.race([work, timeout]);
    if (!Array.isArray(list)) return { ok: false };
    return { ok: true, status, list };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    q.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Uruchamia gałęzie równolegle (limit czasu na gałąź: AbortController + Promise.race), łączy wyniki RRF (k=60),
 * deduplikuje po recordId (zostaje najlepsza ścieżka `via`) i ucina do `maxResults`.
 */
export async function retrieve(
  branches: RetrievalBranch[],
  q: RetrievalQuery,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const timeoutMs = opts.perBranchTimeoutMs ?? DEFAULT_PER_BRANCH_TIMEOUT_MS;
  const cap = Math.max(1, opts.maxResults ?? q.limit ?? DEFAULT_MAX_RESULTS);

  // Gałąź może zadeklarować własny, dłuższy limit (np. „live”: wyszukiwanie + pobranie stron).
  const settled = await Promise.all(branches.map((b) => runBranch(b, q, Math.max(timeoutMs, branchTimeout(b)))));

  const lists: EvidenceCandidate[][] = [];
  const unavailable: string[] = [];
  let requiredFailed = false;
  settled.forEach((res, i) => {
    const branch = branches[i]!;
    if (res.ok) {
      lists.push(res.list);
      opts.onBranchResult?.(branch.id, res.status, res.list);
    } else {
      unavailable.push(branch.id);
      opts.onBranchResult?.(branch.id, "unavailable", []);
      if (branch.required) requiredFailed = true;
    }
  });
  if (branches.length === 0 || unavailable.length === branches.length) requiredFailed = true;

  const fused = reciprocalRankFusion(lists, opts.rrfK ?? RRF_K, weightsFor(lists));
  const candidates = q.includeSemanticFactCheck ? limitWithSemanticFactChecks(fused, cap) : fused.slice(0, cap);
  return { candidates, unavailable, requiredFailed };
}

// Ponowny eksport dla wygody wywołującego (ostrzeżenia o domenach incydentów — nigdy dowody).
export type IncidentDomainMatch = ReturnType<typeof matchIncidentDomains>[number];
