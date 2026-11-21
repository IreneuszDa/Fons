/**
 * Metryki w formacie tekstowym Prometheus (0.0.4), pisane ręcznie — bez zależności.
 * Liczniki żyją w pamięci procesu (reset przy restarcie jest normalny dla Prometheusa);
 * trwałe zestawienia dla panelu liczy GET /api/admin/metrics z tabeli runs.
 */

type Labels = Record<string, string>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? "").join("\u0000");
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

/** Ogranicza kardynalność etykiet: wartości spoza bezpiecznego zestawu znaków i zbyt długie są skracane. */
export function safeLabel(v: unknown, max = 64): string {
  const s = String(v ?? "").replace(/[^\p{L}\p{N}_.:/@+ -]/gu, "_");
  return s.length > max ? s.slice(0, max) : s;
}

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}
export interface Gauge {
  set(labels: Labels, value: number): void;
}
export interface Histogram {
  observe(labels: Labels, value: number): void;
}

interface Family {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  labelNames: readonly string[];
  render(): string[];
}

const MAX_SERIES_PER_FAMILY = 2000;

export class Registry {
  private readonly families: Family[] = [];
  private readonly collectors: (() => void)[] = [];

  private register(f: Family): void {
    if (this.families.some((x) => x.name === f.name)) throw new Error(`duplicate metric ${f.name}`);
    this.families.push(f);
  }

  onCollect(fn: () => void): void {
    this.collectors.push(fn);
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const series = new Map<string, { values: string[]; v: number }>();
    this.register({
      name, help, type: "counter", labelNames,
      render: () => [...series.values()].map((s) => `${name}${renderLabels(labelNames, s.values)} ${fmt(s.v)}`),
    });
    return {
      inc(labels = {}, by = 1) {
        if (!(by >= 0)) return;
        const k = labelKey(labelNames, labels);
        let s = series.get(k);
        if (!s) {
          if (series.size >= MAX_SERIES_PER_FAMILY) return;
          s = { values: labelNames.map((n) => labels[n] ?? ""), v: 0 };
          series.set(k, s);
        }
        s.v += by;
      },
    };
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    const series = new Map<string, { values: string[]; v: number }>();
    this.register({
      name, help, type: "gauge", labelNames,
      render: () => [...series.values()].map((s) => `${name}${renderLabels(labelNames, s.values)} ${fmt(s.v)}`),
    });
    return {
      set(labels, value) {
        const k = labelKey(labelNames, labels);
        const s = series.get(k);
        if (s) s.v = value;
        else if (series.size < MAX_SERIES_PER_FAMILY) series.set(k, { values: labelNames.map((n) => labels[n] ?? ""), v: value });
      },
    };
  }

  histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram {
    const bounds = [...buckets].sort((a, b) => a - b);
    const series = new Map<string, { values: string[]; counts: number[]; sum: number; count: number }>();
    this.register({
      name, help, type: "histogram", labelNames,
      render: () => {
        const lines: string[] = [];
        for (const s of series.values()) {
          let cum = 0;
          bounds.forEach((b, i) => {
            cum += s.counts[i]!;
            lines.push(`${name}_bucket${renderLabels(labelNames, s.values, ["le", fmt(b)])} ${cum}`);
          });
          lines.push(`${name}_bucket${renderLabels(labelNames, s.values, ["le", "+Inf"])} ${s.count}`);
          lines.push(`${name}_sum${renderLabels(labelNames, s.values)} ${fmt(s.sum)}`);
          lines.push(`${name}_count${renderLabels(labelNames, s.values)} ${s.count}`);
        }
        return lines;
      },
    });
    return {
      observe(labels, value) {
        if (!Number.isFinite(value)) return;
        const k = labelKey(labelNames, labels);
        let s = series.get(k);
        if (!s) {
          if (series.size >= MAX_SERIES_PER_FAMILY) return;
          s = { values: labelNames.map((n) => labels[n] ?? ""), counts: bounds.map(() => 0), sum: 0, count: 0 };
          series.set(k, s);
        }
        const i = bounds.findIndex((b) => value <= b);
        if (i >= 0) s.counts[i]!++;
        s.sum += value;
        s.count++;
      },
    };
  }

  render(): string {
    for (const fn of this.collectors) {
      try {
        fn();
      } catch {
        /* metryka z błędem nie psuje reszty */
      }
    }
    const out: string[] = [];
    for (const f of this.families) {
      const lines = f.render();
      if (lines.length === 0) continue;
      out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`, ...lines);
    }
    return `${out.join("\n")}\n`;
  }
}

const SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60, 120] as const;
const HTTP_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export interface VerificationObservation {
  status: string;
  verdict: string | null;
  channel: string;
  inputMode: string;
  cacheHit: boolean;
  latencyMs: number;
  timingsMs: Record<string, number>;
  models: { provider: string; model: string; purpose: string; inputTokens: number; outputTokens: number; costUsd: number }[];
  unavailable: string[];
  securityEvents: number;
}

export interface ServerMetrics {
  registry: Registry;
  recordVerification(o: VerificationObservation): void;
  recordHttp(o: { method: string; route: string; status: number; seconds: number }): void;
  /** Gauge’e liczone przy każdym scrapie (np. zużycie tokenów dziś). */
  setGauges(g: { dailyTokens?: number; corpusRecords?: number; buildPipeline?: string; buildSnapshot?: string }): void;
  render(): string;
}

/** Ostatni krok zapytania: statusy techniczne, które nie są werdyktem, liczymy osobno jako „wstrzymania”. */
function abstentionReason(status: string, verdict: string | null): string | undefined {
  if (status === "OK") return verdict === "BRAK_DOWODOW" ? "brak_dowodow" : undefined;
  if (status === "NIEPELNE" || status === "DOPRECYZUJ" || status === "POZA_ZAKRESEM") return status.toLowerCase();
  return undefined;
}

export function createServerMetrics(): ServerMetrics {
  const registry = new Registry();
  const startedAt = Date.now();

  const verifications = registry.counter("fons_verifications_total", "Liczba weryfikacji wg statusu technicznego, werdyktu i kanału.", ["status", "verdict", "channel"]);
  const abstentions = registry.counter("fons_abstentions_total", "Weryfikacje bez werdyktu rozstrzygającego wg powodu.", ["reason"]);
  const cacheHits = registry.counter("fons_cache_hits_total", "Weryfikacje obsłużone z cache obliczeń.");
  const injection = registry.counter("fons_injection_events_total", "Zdarzenia bezpieczeństwa: wykryte próby wpłynięcia na system.");
  const llmCalls = registry.counter("fons_llm_calls_total", "Wywołania modeli językowych.", ["provider", "model", "purpose"]);
  const llmTokens = registry.counter("fons_llm_tokens_total", "Tokeny modeli językowych.", ["provider", "model", "purpose", "direction"]);
  const llmCost = registry.counter("fons_llm_cost_usd_total", "Szacowany koszt modeli językowych w USD.", ["provider", "model", "purpose"]);
  const branchFailures = registry.counter("fons_retrieval_branch_failures_total", "Gałęzie wyszukiwania, które nie zadziałały.", ["branch"]);
  const totalHist = registry.histogram("fons_verification_duration_seconds", "Czas całej weryfikacji (bez trafień w cache).", [], SECONDS);
  const stepHist = registry.histogram("fons_verification_step_duration_seconds", "Czas kroków weryfikacji.", ["step"], SECONDS);
  const httpTotal = registry.counter("fons_http_requests_total", "Żądania HTTP.", ["method", "route", "status"]);
  const httpHist = registry.histogram("fons_http_request_duration_seconds", "Czas obsługi żądań HTTP.", ["method", "route"], HTTP_SECONDS);

  const dailyTokens = registry.gauge("fons_daily_tokens_used", "Tokeny zużyte dziś (bezpiecznik budżetu).");
  const corpusRecords = registry.gauge("fons_corpus_records", "Liczba rekordów w korpusie.");
  const buildInfo = registry.gauge("fons_build_info", "Wersja potoku i identyfikator migawki korpusu.", ["pipeline", "snapshot"]);
  const uptime = registry.gauge("fons_process_uptime_seconds", "Czas działania procesu.");
  registry.onCollect(() => uptime.set({}, Math.round((Date.now() - startedAt) / 1000)));

  return {
    registry,
    recordVerification(o) {
      verifications.inc({ status: safeLabel(o.status), verdict: safeLabel(o.verdict ?? "none"), channel: safeLabel(o.channel) });
      const reason = abstentionReason(o.status, o.verdict);
      if (reason) abstentions.inc({ reason });
      if (o.cacheHit) cacheHits.inc();
      if (o.securityEvents > 0) injection.inc({}, o.securityEvents);
      for (const b of o.unavailable) branchFailures.inc({ branch: safeLabel(b) });
      for (const m of o.models) {
        const l = { provider: safeLabel(m.provider), model: safeLabel(m.model), purpose: safeLabel(m.purpose) };
        llmCalls.inc(l);
        llmTokens.inc({ ...l, direction: "input" }, m.inputTokens);
        llmTokens.inc({ ...l, direction: "output" }, m.outputTokens);
        llmCost.inc(l, m.costUsd);
      }
      if (!o.cacheHit && (o.status === "OK" || o.status === "NIEPELNE" || o.status === "DOPRECYZUJ" || o.status === "POZA_ZAKRESEM")) {
        totalHist.observe({}, o.latencyMs / 1000);
        for (const [step, ms] of Object.entries(o.timingsMs)) {
          if (step !== "total") stepHist.observe({ step: safeLabel(step, 32) }, ms / 1000);
        }
      }
    },
    recordHttp({ method, route, status, seconds }) {
      const r = safeLabel(route, 96);
      httpTotal.inc({ method: safeLabel(method, 8), route: r, status: String(status) });
      httpHist.observe({ method: safeLabel(method, 8), route: r }, seconds);
    },
    setGauges(g) {
      if (g.dailyTokens !== undefined) dailyTokens.set({}, g.dailyTokens);
      if (g.corpusRecords !== undefined) corpusRecords.set({}, g.corpusRecords);
      if (g.buildPipeline !== undefined) buildInfo.set({ pipeline: safeLabel(g.buildPipeline), snapshot: safeLabel(g.buildSnapshot ?? "") }, 1);
    },
    render: () => registry.render(),
  };
}
