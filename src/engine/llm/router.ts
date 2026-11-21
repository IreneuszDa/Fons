/**
 * Model router — explicit routing table (purpose → tier) and escalation rules.
 * Documented for people in docs/ROUTER.md.
 *
 *  - The table decides the tier for every known purpose (the caller's `tier` is used only for
 *    purposes missing from the table).
 *  - Fast tier fails with schema / refusal / timeout → retried ONCE on the main tier of the same provider.
 *  - Fast tier fails for a provider-level reason (rate limit, provider error, budget, no key) →
 *    straight to the fallback provider (same tier), because the main tier of the same provider is
 *    very likely down too.
 *  - Main tier fails (any reason) → the configured fallback provider (another model family) on the
 *    main tier, if one exists; otherwise the LlmUnavailableError propagates (the engine answers NIEPELNE).
 *  - A caller abort is never escalated.
 *
 * Every decision is recorded: successful calls return their ModelUsage (purpose, provider, model) as
 * before; failed attempts are added to the per-request trace (AsyncLocalStorage, see runWithRouteTrace)
 * as zero-token ModelUsage entries with purpose "<purpose>:failed", and every decision is written as one
 * debug log line (no prompts, no keys, no provider error text).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LlmUnavailableError, type LlmResponse, type ModelUsage } from "../../shared/contracts";
import { supportsVision, type EngineLlmProvider, type EngineLlmRequest, type ProviderModels } from "./types";

export type Tier = "fast" | "main";

/** purpose → tier. The single source of truth; mirrored in docs/ROUTER.md. */
export const ROUTING_TABLE: Readonly<Record<string, Tier>> = Object.freeze({
  claims: "fast", // claim extraction + input mode (claim / yes-no question / open question)
  router: "fast", // conversational response or selection of a verification/report tool
  verifier: "fast", // independent quote check (batched)
  vision: "fast", // transcription of screenshots / photos
  smooth: "fast", // optional smoothing of the template justification
  assess: "main", // evidence assessment (relation, aspect, verbatim quote)
  open_answer: "main", // pick the verbatim quote that answers an open question
});

/** Fast-tier failures that are worth one retry on the main tier of the same provider. */
const ESCALATE_TO_MAIN: ReadonlySet<LlmUnavailableError["reason"]> = new Set(["schema", "refusal", "timeout"]);

export function tierFor(purpose: string, requested?: Tier): Tier {
  return ROUTING_TABLE[purpose] ?? requested ?? "main";
}

export type RouteStep = "primary" | "escalated" | "fallback";

export interface RouteDecision {
  purpose: string;
  tier: Tier;
  provider: string;
  model: string;
  step: RouteStep;
  outcome: "ok" | "failed";
  reason?: LlmUnavailableError["reason"];
  latencyMs: number;
}

export interface RouteTrace {
  /** Failed attempts as zero-token ModelUsage entries (successful usages are returned to the caller). */
  usages: ModelUsage[];
  decisions: RouteDecision[];
}

const traceStore = new AsyncLocalStorage<RouteTrace>();

/** Runs `fn` with a request-scoped trace; every router call inside records its decisions there. */
export function runWithRouteTrace<T>(trace: RouteTrace, fn: () => Promise<T>): Promise<T> {
  return traceStore.run(trace, fn);
}

export function currentRouteTrace(): RouteTrace | undefined {
  return traceStore.getStore();
}

/** Debug log: on when LOG_LEVEL=debug or DEBUG contains "router" / "fons". */
export function defaultRouterLog(line: string): void {
  const dbg = process.env.DEBUG ?? "";
  if (process.env.LOG_LEVEL === "debug" || /\b(router|fons|\*)\b/.test(dbg)) console.debug(line);
}

export function formatDecision(d: RouteDecision): string {
  return (
    `[router] purpose=${d.purpose} tier=${d.tier} step=${d.step} provider=${d.provider} model=${d.model} ` +
    `outcome=${d.outcome}${d.reason ? ` reason=${d.reason}` : ""} ms=${d.latencyMs}`
  );
}

export interface ModelRouterOptions {
  primary: EngineLlmProvider;
  /** Another model family, used when the primary main tier fails. */
  fallback?: EngineLlmProvider;
  table?: Readonly<Record<string, Tier>>;
  log?: (line: string) => void;
}

function modelOf(p: EngineLlmProvider, tier: Tier): string {
  return p.models ? p.models[tier] : p.name;
}

/**
 * LlmProvider that routes every request through the table and the escalation chain.
 * It looks like its primary provider (name, family, models, vision, region), so the rest of the
 * engine (transparency block, non-EEA warning, cache key) keeps working unchanged.
 */
export class ModelRouter implements EngineLlmProvider {
  readonly primary: EngineLlmProvider;
  readonly fallback?: EngineLlmProvider;
  private readonly table: Readonly<Record<string, Tier>>;
  private readonly log: (line: string) => void;

  constructor(opts: ModelRouterOptions) {
    this.primary = opts.primary;
    const fb = opts.fallback;
    this.fallback = fb && fb.available && fb.family !== opts.primary.family ? fb : undefined;
    this.table = opts.table ?? ROUTING_TABLE;
    this.log = opts.log ?? defaultRouterLog;
  }

  get name(): string {
    return this.primary.name;
  }
  get family(): string {
    return this.primary.family;
  }
  get available(): boolean {
    return this.primary.available;
  }
  get models(): ProviderModels | undefined {
    return this.primary.models;
  }
  get supportsVision(): boolean {
    return supportsVision(this.primary);
  }
  get processingRegion(): "eea" | "us" | "local" | undefined {
    return this.primary.processingRegion;
  }

  tierFor(purpose: string, requested?: Tier): Tier {
    return this.table[purpose] ?? requested ?? "main";
  }

  async complete<T>(req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
    const tier = this.tierFor(req.purpose, req.tier);
    try {
      return await this.attempt(this.primary, req, tier, "primary");
    } catch (e) {
      if (!(e instanceof LlmUnavailableError) || req.signal?.aborted) throw e;
      if (tier === "fast" && ESCALATE_TO_MAIN.has(e.reason)) {
        try {
          return await this.attempt(this.primary, req, "main", "escalated");
        } catch (e2) {
          if (!(e2 instanceof LlmUnavailableError) || req.signal?.aborted) throw e2;
          return this.tryFallback(req, "main", e2);
        }
      }
      return this.tryFallback(req, tier, e);
    }
  }

  private async tryFallback<T>(req: EngineLlmRequest<T>, tier: Tier, lastError: LlmUnavailableError): Promise<LlmResponse<T>> {
    const fb = this.fallback;
    if (!fb || (req.images && req.images.length > 0 && !supportsVision(fb))) throw lastError;
    return this.attempt(fb, req, tier, "fallback");
  }

  private async attempt<T>(p: EngineLlmProvider, req: EngineLlmRequest<T>, tier: Tier, step: RouteStep): Promise<LlmResponse<T>> {
    const started = Date.now();
    const base = { purpose: req.purpose, tier, provider: p.name, model: modelOf(p, tier), step };
    try {
      const res = await p.complete({ ...req, tier });
      this.record({ ...base, model: res.usage.model || base.model, outcome: "ok", latencyMs: Date.now() - started });
      return res;
    } catch (e) {
      const reason = e instanceof LlmUnavailableError ? e.reason : "provider_error";
      const d: RouteDecision = { ...base, outcome: "failed", reason, latencyMs: Date.now() - started };
      this.record(d);
      currentRouteTrace()?.usages.push({
        purpose: `${req.purpose}:failed`,
        provider: p.name,
        model: base.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: d.latencyMs,
        costUsd: 0,
      });
      throw e;
    }
  }

  private record(d: RouteDecision): void {
    currentRouteTrace()?.decisions.push(d);
    try {
      this.log(formatDecision(d));
    } catch {
      /* logging never breaks a request */
    }
  }
}
