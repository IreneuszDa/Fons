import type { RetrievalBranch, RetrievalQuery } from "../../shared/contracts";

/** No eligible query or registered channel. No lookup was performed. */
export function skipLookup(q: RetrievalQuery): [] {
  q.onCoverage?.("skipped");
  return [];
}

/**
 * Gałąź nie może odpowiedzieć (brak modelu, niezgodny indeks wektorów, brak dostawcy wyszukiwania na żywo).
 * `retrieve()` traktuje każdy wyjątek z `search()` jako niedostępność gałęzi; ten typ tylko niesie powód
 * (do logu — NIE do użytkownika, PLAN §1.3: komunikat nigdy nie przepisuje treści błędu).
 */
export class BranchUnavailableError extends Error {
  constructor(
    public readonly branchId: string,
    public readonly reason: string,
  ) {
    super(`branch ${branchId} unavailable: ${reason}`);
    this.name = "BranchUnavailableError";
  }
}

export interface BranchStatus {
  available: boolean;
  /** Krótki kod powodu (np. "manifest_missing", "model_hash_mismatch"); tylko do logu. */
  reason?: string;
}

/** Gałąź, która potrafi się rozgrzać przy starcie serwera i zgłosić stan. */
export interface WarmableBranch extends RetrievalBranch {
  warmUp(): Promise<BranchStatus>;
}

export function isWarmable(b: RetrievalBranch): b is WarmableBranch {
  return typeof (b as Partial<WarmableBranch>).warmUp === "function";
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}
