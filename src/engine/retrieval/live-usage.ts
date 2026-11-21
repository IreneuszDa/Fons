/**
 * Koszt i kontekst przebiegu dla gałęzi „live” i „official”.
 *
 * Gałęzie są tworzone raz na proces (createEngineDeps), więc same nie znają przebiegu. Wywołujący (serwer, MCP,
 * ewaluacja) otacza jedną weryfikację `runWithLiveScope({ requestId }, fn)`; AsyncLocalStorage przenosi zakres
 * przez całą asynchroniczną ścieżkę, więc:
 *  - każde płatne wywołanie wyszukiwarki (tokeny + opłata za web_search) trafia do `scope.usages`
 *    (`recordLiveUsage` jest podpięte jako onUsage dostawcy w createLiveBranchFromConfig),
 *  - zdarzenia bezpieczeństwa z gałęzi „live” dostają identyfikator przebiegu (`currentLiveRequestId()`).
 *
 * `liveUsageModels()` zamienia zebrane użycie na wpisy `ModelUsage` (purpose "live_search"), które dopisuje się do
 * report.models, a `withLiveUsage(report)` robi to od razu i przelicza report.costUsd.
 * Użycie, które przyjdzie po zakończeniu przebiegu (gałąź przerwana limitem czasu, odpowiedź spóźniona), nie jest
 * doliczane do raportu — to dolne oszacowanie, opisane w README.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelUsage, VerdictReport } from "../../shared/contracts";
import type { SearchUsage } from "../../tools/search";

export interface LiveRunScope {
  requestId?: string;
  usages: SearchUsage[];
}

export const LIVE_SEARCH_PURPOSE = "live_search";

const als = new AsyncLocalStorage<LiveRunScope>();

/** Uruchamia `fn` w nowym zakresie przebiegu (koszt wyszukiwania + identyfikator żądania). */
export function runWithLiveScope<T>(init: { requestId?: string }, fn: () => Promise<T>): Promise<T> {
  return als.run({ requestId: init.requestId, usages: [] }, fn);
}

export function currentLiveScope(): LiveRunScope | undefined {
  return als.getStore();
}

export function currentLiveRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

/** onUsage dostawcy wyszukiwania: zapisuje użycie w bieżącym zakresie (poza zakresem — nic). */
export function recordLiveUsage(usage: SearchUsage): void {
  const scope = als.getStore();
  if (!scope) return;
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) return;
  scope.usages.push(usage);
}

/** Łączny koszt wyszukiwania na żywo w zakresie (USD, tokeny + opłata za wywołania web_search). */
export function liveSearchCostUsd(scope: LiveRunScope | undefined = als.getStore()): number {
  if (!scope) return 0;
  return Math.round(scope.usages.reduce((s, u) => s + u.costUsd, 0) * 1e6) / 1e6;
}

/** Wpisy do report.models: jeden na model wyszukiwarki, purpose "live_search". */
export function liveUsageModels(scope: LiveRunScope | undefined = als.getStore()): ModelUsage[] {
  if (!scope || scope.usages.length === 0) return [];
  const byModel = new Map<string, ModelUsage>();
  for (const u of scope.usages) {
    const key = `${u.provider}\u0001${u.model}`;
    const m = byModel.get(key) ?? {
      purpose: LIVE_SEARCH_PURPOSE,
      provider: u.provider,
      model: u.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: 0,
    };
    m.inputTokens += u.inputTokens;
    m.outputTokens += u.outputTokens;
    m.latencyMs = Math.max(m.latencyMs, u.latencyMs);
    m.costUsd = Math.round((m.costUsd + u.costUsd) * 1e6) / 1e6;
    byModel.set(key, m);
  }
  return [...byModel.values()];
}

/**
 * Dopisuje koszt wyszukiwania na żywo do raportu (models + costUsd). Idempotentne: gdy raport ma już wpisy
 * "live_search" (silnik doliczył je sam), zwraca raport bez zmian.
 */
export function withLiveUsage(report: VerdictReport, scope: LiveRunScope | undefined = als.getStore()): VerdictReport {
  const extra = liveUsageModels(scope);
  if (extra.length === 0 || report.models.some((m) => m.purpose === LIVE_SEARCH_PURPOSE)) return report;
  const models = [...report.models, ...extra];
  return { ...report, models, costUsd: Math.round(models.reduce((s, m) => s + m.costUsd, 0) * 1e6) / 1e6 };
}
