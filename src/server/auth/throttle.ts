/**
 * Blokada zgadywania haseł per login (uzupełnia limit per adres IP, który omija się rozproszonym atakiem).
 * Liczymy tylko nieudane próby; po MAX_FAILURES w oknie kolejne próby są odrzucane do końca okna.
 * Klucze to wpisane loginy (także nieistniejące), więc blokada nie zdradza, czy konto istnieje.
 */
export interface LoginThrottle {
  /** Ile sekund jeszcze trwa blokada (0 = można próbować). */
  blockedFor(key: string): number;
  fail(key: string): void;
  success(key: string): void;
}

export function createLoginThrottle(opts: { maxFailures?: number; windowMs?: number; now: () => number; maxKeys?: number }): LoginThrottle {
  const max = opts.maxFailures ?? 10;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const maxKeys = opts.maxKeys ?? 10_000;
  const failures = new Map<string, number[]>();

  const prune = (key: string): number[] => {
    const t = opts.now();
    const list = (failures.get(key) ?? []).filter((x) => x > t - windowMs);
    if (list.length === 0) failures.delete(key);
    else failures.set(key, list);
    return list;
  };

  return {
    blockedFor(key) {
      const list = prune(key);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0]! + windowMs - opts.now()) / 1000));
    },
    fail(key) {
      const list = prune(key);
      if (!failures.has(key) && failures.size >= maxKeys) {
        // ochrona pamięci przed zalewem losowych loginów: porzucamy najstarszy wpis
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      list.push(opts.now());
      failures.set(key, list);
    },
    success(key) {
      failures.delete(key);
    },
  };
}
