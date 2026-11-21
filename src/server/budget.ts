/**
 * Dobowy bezpiecznik budżetu tokenów (PLAN §6). Sprawdzany PRZED wywołaniem silnika.
 * Tokeny wyszukiwania na żywo (report.models, purpose "live_search") też się liczą.
 */
import type { AppConfig } from "./config";
import type { Db } from "./context";
import { dayKey } from "./util";

export function tokensUsedToday(db: Db, now: Date): number {
  const row = db.prepare("SELECT tokens FROM token_usage WHERE day = ?").get(dayKey(now)) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

export function budgetExceeded(db: Db, cfg: Pick<AppConfig, "dailyTokenBudget">, now: Date): boolean {
  return tokensUsedToday(db, now) >= cfg.dailyTokenBudget;
}

export function addTokens(db: Db, now: Date, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  db.prepare(
    `INSERT INTO token_usage (day, tokens) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens`,
  ).run(dayKey(now), Math.round(tokens));
}

/** Domyślna część dobowego budżetu dostępna dla jednego klienta (adres IPv4 / sieć IPv6 /64). */
export const DEFAULT_IP_DAILY_TOKEN_SHARE = 0.25;

/** Zużycie tokenów per klient w bieżącej dobie (w pamięci procesu; restart zeruje — to ochrona, nie rozliczenie). */
export type ClientUsage = Map<string, { day: string; tokens: number }>;

function clientCap(cfg: Pick<AppConfig, "dailyTokenBudget" | "ipDailyTokenShare">): number {
  const share = cfg.ipDailyTokenShare;
  const s = typeof share === "number" && Number.isFinite(share) && share > 0 ? Math.min(share, 1) : DEFAULT_IP_DAILY_TOKEN_SHARE;
  return cfg.dailyTokenBudget * s;
}

export function clientBudgetExceeded(
  usage: ClientUsage,
  cfg: Pick<AppConfig, "dailyTokenBudget" | "ipDailyTokenShare">,
  client: string,
  now: Date,
): boolean {
  const u = usage.get(client);
  return !!u && u.day === dayKey(now) && u.tokens >= clientCap(cfg);
}

export function addClientTokens(usage: ClientUsage, client: string, now: Date, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const day = dayKey(now);
  const u = usage.get(client);
  if (!u || u.day !== day) {
    // sprzątanie wpisów z poprzednich dób przy pierwszym zapisie nowej doby
    if (u) for (const [k, v] of usage) if (v.day !== day) usage.delete(k);
    usage.set(client, { day, tokens: Math.round(tokens) });
  } else {
    u.tokens += Math.round(tokens);
  }
}
