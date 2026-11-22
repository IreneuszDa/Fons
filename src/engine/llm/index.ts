/**
 * LLM providers: factory + re-exports.
 *
 * createLlmProviders(cfg):
 *  - main     = provider from cfg.llmProvider (MODEL_MAIN / MODEL_FAST),
 *  - verifier = the other family (its fast model) when cfg.verifierProvider is set and keyed,
 *               otherwise the same provider on the fast tier, with singleKey = true.
 *  - keyed providers are wrapped in a ModelRouter (llm/router.ts): routing table purpose → tier,
 *    fast → main escalation, and — for the main provider — a fallback to the other family when a
 *    second key is configured (docs/ROUTER.md).
 *  - no key → providers with available = false; the engine then answers NIEPELNE (scenario J).
 */
import { LlmUnavailableError, type LlmProvider, type LlmResponse } from "../../shared/contracts";
import { defaultModelsFor, type AppConfig, type ProviderName } from "../../server/config";
import { AnthropicProvider } from "./anthropic";
import { MistralProvider } from "./mistral";
import { OpenAiProvider } from "./openai";
import { ModelRouter } from "./router";
import type { EngineLlmProvider, EngineLlmRequest, ProviderModels } from "./types";

export { AnthropicProvider } from "./anthropic";
export { MistralProvider } from "./mistral";
export { OpenAiProvider } from "./openai";
export { ModelRouter, ROUTING_TABLE, tierFor, runWithRouteTrace, currentRouteTrace } from "./router";
export type { RouteDecision, RouteTrace, Tier } from "./router";
export { fence, UNTRUSTED_DATA_RULES } from "./fence";
export * from "./types";

/** Provider without a key: available = false, every call fails with LlmUnavailableError("no_key"). */
export class UnavailableLlmProvider implements EngineLlmProvider {
  readonly available = false;
  readonly supportsVision = false;
  constructor(
    readonly name: string,
    readonly family: string,
    readonly models: ProviderModels,
  ) {}
  async complete<T>(_req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
    throw new LlmUnavailableError("no_key");
  }
}

function makeProvider(cfg: AppConfig, provider: ProviderName, models: ProviderModels, defaultTier: "fast" | "main"): EngineLlmProvider {
  if (provider === "anthropic") {
    return cfg.anthropicApiKey
      ? new AnthropicProvider({ apiKey: cfg.anthropicApiKey, models, defaultTier })
      : new UnavailableLlmProvider("anthropic", "anthropic", models);
  }
  if (provider === "openai") {
    return cfg.openaiApiKey
      ? new OpenAiProvider({ apiKey: cfg.openaiApiKey, models, defaultTier, dataResidency: cfg.openaiDataResidency })
      : new UnavailableLlmProvider("openai", "openai", models);
  }
  return cfg.mistralApiKey
    ? new MistralProvider({ apiKey: cfg.mistralApiKey, models, defaultTier })
    : new UnavailableLlmProvider("mistral", "mistral", models);
}

export function createLlmProviders(cfg: AppConfig): { main: LlmProvider; verifier: LlmProvider; singleKey: boolean } {
  const mainModels = { main: cfg.modelMain, fast: cfg.modelFast };
  const mainRaw = makeProvider(cfg, cfg.llmProvider, mainModels, "main");

  const vp = cfg.verifierProvider;
  const vpKeyed =
    vp === "anthropic" ? !!cfg.anthropicApiKey : vp === "mistral" ? !!cfg.mistralApiKey : vp === "openai" ? !!cfg.openaiApiKey : false;
  const route = (primary: EngineLlmProvider, fallback?: EngineLlmProvider): EngineLlmProvider =>
    primary.available ? new ModelRouter({ primary, fallback }) : primary;
  if (vp && vp !== cfg.llmProvider && vpKeyed) {
    const verifierRaw = makeProvider(cfg, vp, defaultModelsFor(vp), "fast");
    // Main: fallback to the other family. Verifier: no cross-family fallback (it would stop being independent).
    const otherForMain = makeProvider(cfg, vp, defaultModelsFor(vp), "main");
    return { main: route(mainRaw, otherForMain), verifier: route(verifierRaw), singleKey: false };
  }
  // Single-key mode: same provider, fast tier.
  const verifier = makeProvider(cfg, cfg.llmProvider, mainModels, "fast");
  return { main: route(mainRaw), verifier: route(verifier), singleKey: true };
}
