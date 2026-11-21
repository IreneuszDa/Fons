/**
 * Pure helpers that turn GET /api/admin/metrics into tile values and table rows.
 * Breakdown values may be plain numbers or objects ({calls, usd, p50, …}); both are accepted.
 */
import type { AdminMetrics, Breakdown, MetricValue } from "./adminApi";

const COUNT_KEYS = ["count", "calls", "total", "value", "n"] as const;
const USD_KEYS = ["usd", "costUsd", "totalUsd", "cost"] as const;

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pick(v: MetricValue | undefined, keys: readonly string[]): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return finite(v);
  for (const k of keys) {
    const n = finite((v as Record<string, unknown>)[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** A count from a number or {count|calls|total|value}. */
export function countOf(v: MetricValue | undefined): number {
  return pick(v, COUNT_KEYS) ?? 0;
}

export function usdOf(v: MetricValue | undefined): number {
  return pick(v, USD_KEYS) ?? (typeof v === "number" ? v : 0);
}

export function field(v: MetricValue | undefined, key: string): number | undefined {
  if (v === undefined || typeof v === "number") return undefined;
  return finite((v as Record<string, unknown>)[key]);
}

export type CountRow = { id: string; label: string; count: number };

/** Breakdown → rows sorted by count (desc), with Polish labels when known. */
export function countRows(b: Breakdown | undefined, labels: Record<string, string> = {}): CountRow[] {
  if (!b) return [];
  return Object.entries(b)
    .map(([id, v]) => ({ id, label: labels[id] ?? id, count: countOf(v) }))
    .sort((a, b2) => b2.count - a.count || a.label.localeCompare(b2.label, "pl"));
}

/** Fixed-order rows (e.g. all five verdicts even when a count is 0). */
export function fixedRows(b: Breakdown | undefined, labels: Record<string, string>): CountRow[] {
  return Object.entries(labels).map(([id, label]) => ({ id, label, count: countOf(b?.[id]) }));
}

export type ModelCostRow = { id: string; model: string; usd: number; calls: number | undefined };

export function modelCostRows(b: Breakdown | undefined): ModelCostRow[] {
  if (!b) return [];
  return Object.entries(b)
    .map(([model, v]) => ({ id: model, model, usd: usdOf(v), calls: field(v, "calls") }))
    .sort((a, c) => c.usd - a.usd);
}

export type PurposeRow = { id: string; purpose: string; calls: number; tokensIn?: number; tokensOut?: number; usd?: number };

export const PURPOSE_PL: Record<string, string> = {
  claims: "wydzielenie twierdzeń",
  assess: "ocena dowodów",
  verifier: "druga kontrola cytatów",
  smooth: "wygładzenie tekstu",
  router: "rozpoznanie prośby",
  vision: "odczyt obrazu",
  answer: "odpowiedź na pytanie",
  translate: "tłumaczenie zapytania",
};

export function purposeRows(b: Breakdown | undefined): PurposeRow[] {
  if (!b) return [];
  return Object.entries(b)
    .map(([id, v]) => ({
      id,
      purpose: PURPOSE_PL[id] ? `${PURPOSE_PL[id]} (${id})` : id,
      calls: countOf(v),
      tokensIn: field(v, "tokensIn") ?? field(v, "inputTokens"),
      tokensOut: field(v, "tokensOut") ?? field(v, "outputTokens"),
      usd: field(v, "costUsd") ?? field(v, "usd"),
    }))
    .sort((a, c) => c.calls - a.calls);
}

export type StepRow = { id: string; step: string; p50: number | undefined; p95: number | undefined };

export const STEP_PL: Record<string, string> = {
  normalize: "przygotowanie wejścia",
  claims: "wydzielenie twierdzeń",
  retrieval: "wyszukiwanie w źródłach",
  assess: "ocena dowodów",
  verify: "druga kontrola",
  verdict: "wyliczenie werdyktu",
  smooth: "wygładzenie tekstu",
  total: "razem",
};

export function stepRows(b: Breakdown | undefined): StepRow[] {
  if (!b) return [];
  return Object.entries(b).map(([id, v]) => ({
    id,
    step: STEP_PL[id] ?? id,
    p50: typeof v === "number" ? finite(v) : (field(v, "p50") ?? field(v, "avg") ?? field(v, "mean")),
    p95: typeof v === "number" ? undefined : field(v, "p95"),
  }));
}

/** Abstentions as {count, rate}: rate from the server when given, otherwise count / verifications. */
export function abstentionOf(m: AdminMetrics): { count: number; rate: number | undefined } {
  const a = m.totals.abstentions;
  const count = countOf(a);
  const given = field(a, "rate");
  if (given !== undefined) return { count, rate: given };
  const total = m.totals.verifications;
  return { count, rate: total > 0 ? count / total : undefined };
}

export function percent(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`;
}

export function intPl(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("pl-PL");
}
