/** Middleware żądania: identyfikator (X-Request-Id), log JSON, metryki HTTP. */
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { VerdictReport } from "../../shared/contracts";
import type { ServerContext } from "../context";
import { newRequestId } from "../util";
import { requestScope } from "./logger";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
  }
}

/** Szablon trasy (nigdy konkretny adres z tokenami); trasa nieobsłużona → "unmatched". */
function routeTemplate(c: Parameters<MiddlewareHandler>[0]): string {
  let r = "";
  try {
    r = routePath(c);
  } catch {
    r = "";
  }
  if (!r || r === "*" || r === "/*") return "unmatched";
  return r;
}

/**
 * Identyfikator żądania jest zawsze nasz (nie bierzemy go od klienta): trafia też do dziennika przebiegów
 * i do raportu, a tam musi być unikalny.
 */
export function requestObservability(ctx: ServerContext): MiddlewareHandler {
  return async (c, next) => {
    const reqId = newRequestId();
    c.set("reqId", reqId);
    c.header("X-Request-Id", reqId);
    const t0 = performance.now();
    await requestScope.run({ reqId }, () => next());
    try {
      c.res.headers.set("X-Request-Id", reqId);
    } catch {
      /* odpowiedź z niemutowalnymi nagłówkami: nagłówek ustawiono już przez c.header */
    }
    const ms = performance.now() - t0;
    const route = routeTemplate(c);
    const status = c.res.status;
    ctx.metrics.recordHttp({ method: c.req.method, route, status, seconds: ms / 1000 });
    ctx.log.info({
      reqId,
      event: "http",
      method: c.req.method,
      route,
      status,
      latencyMs: Math.round(ms),
    });
  };
}

export interface VerificationLog {
  reqId: string;
  report?: VerdictReport;
  status: string;
  verdict: string | null;
  channel: string;
  cacheHit: boolean;
  latencyMs: number;
  inputMode?: string;
}

/**
 * Jedno miejsce, które zapisuje obserwację weryfikacji: log JSON (bez treści i danych osobowych)
 * i metryki. Wołane z logRun w conversation/verify.ts dla każdej ścieżki (cache, silnik, awaria, budżet).
 */
export function observeVerification(ctx: ServerContext, v: VerificationLog): void {
  const r = v.report;
  const fresh = !v.cacheHit && !!r;
  const models = fresh ? r.models : [];
  const timings = fresh ? r.timingsMs : {};
  const unavailable = fresh ? r.unavailableBranches : [];
  const securityEvents = r?.securityEvents.length ?? 0;
  const inputMode = r?.inputMode ?? v.inputMode ?? "claim";

  ctx.metrics.recordVerification({
    status: v.status,
    verdict: v.verdict,
    channel: v.channel,
    inputMode,
    cacheHit: v.cacheHit,
    latencyMs: v.latencyMs,
    timingsMs: timings,
    models: models.map((m) => ({ provider: m.provider, model: m.model, purpose: m.purpose, inputTokens: m.inputTokens, outputTokens: m.outputTokens, costUsd: m.costUsd })),
    unavailable,
    securityEvents,
  });

  ctx.log.info({
    reqId: v.reqId,
    event: "verification",
    channel: v.channel,
    inputMode,
    status: v.status,
    verdict: v.verdict,
    cacheHit: v.cacheHit,
    models: models.map((m) => `${m.provider}/${m.model}`),
    tokensIn: models.reduce((s, m) => s + m.inputTokens, 0),
    tokensOut: models.reduce((s, m) => s + m.outputTokens, 0),
    costUsd: Math.round((fresh ? r.costUsd : 0) * 1e6) / 1e6,
    latencyMs: Math.round(v.latencyMs),
    timingsMs: timings,
    unavailableBranches: unavailable,
    securityEvents,
  });
}
