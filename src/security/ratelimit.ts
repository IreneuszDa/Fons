/**
 * In-memory sliding-window rate limiter (per key, e.g. pseudonymised user id or IP).
 * Single-process only — good enough for one service instance (PLAN §2).
 */

export interface RateLimiterOptions {
  perMinute: number;
  /** Window length; default 60 000 ms. */
  windowMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface RateLimiter {
  /** Records an attempt and returns true when it is allowed; false when the key is over its limit. */
  check(key: string): boolean;
  /** Attempts still available in the current window (does not record). */
  remaining(key: string): number;
  reset(key?: string): void;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const limit = Math.max(0, Math.floor(opts.perMinute));
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  function prune(list: number[], t: number): number[] {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    return i === 0 ? list : list.slice(i);
  }

  function sweep(t: number) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, list] of hits) {
      const kept = prune(list, t);
      if (kept.length === 0) hits.delete(k);
      else hits.set(k, kept);
    }
  }

  return {
    check(key: string): boolean {
      const t = now();
      sweep(t);
      const list = prune(hits.get(key) ?? [], t);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
    remaining(key: string): number {
      const list = prune(hits.get(key) ?? [], now());
      return Math.max(0, limit - list.length);
    },
    reset(key?: string) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
