/**
 * Engine-local extensions of the LlmProvider port from src/shared/contracts.ts.
 * The shared contract has no image input and no model names; our providers add them as optional
 * members, so any plain LlmProvider still works (without vision, with "unknown" model names).
 */
import type { LlmProvider, LlmRequest, LlmResponse } from "../../shared/contracts";

export interface ImageInput {
  mime: string;
  base64: string;
}

export interface EngineLlmRequest<T> extends LlmRequest<T> {
  /** Images for vision (only sent when the provider supportsVision). */
  images?: ImageInput[];
  /** Per-call timeout in ms (defaults per provider). */
  timeoutMs?: number;
}

export interface ProviderModels {
  main: string;
  fast: string;
}

export interface EngineLlmProvider extends LlmProvider {
  readonly models?: ProviderModels;
  readonly supportsVision?: boolean;
  /** Where the provider processes data (shown to users in the non-EEA warning). */
  readonly processingRegion?: "eea" | "us" | "local";
}

export function modelNameFor(p: LlmProvider, tier: "fast" | "main"): string {
  const m = (p as EngineLlmProvider).models;
  return m ? m[tier] : `${p.name}`;
}

export function supportsVision(p: LlmProvider): boolean {
  return (p as EngineLlmProvider).supportsVision === true;
}

export function processingRegion(p: LlmProvider): "eea" | "us" | "local" {
  const r = (p as EngineLlmProvider).processingRegion;
  if (r) return r;
  return p.name === "anthropic" || p.name === "openai" ? "us" : p.name === "mistral" ? "eea" : "local";
}

export const DEFAULT_TIMEOUT_MS = { fast: 25_000, main: 45_000 } as const;
export const DEFAULT_MAX_TOKENS = { fast: 4_096, main: 8_192 } as const;
/** Ceiling for the single max_tokens retry (kept below the SDK's non-streaming limit). */
export const MAX_TOKENS_RETRY_CAP = 16_000;

/** Defaults: fast tier → effort "low", main tier → effort "medium". */
export function effortFor(req: LlmRequest<unknown>, tier: "fast" | "main"): "low" | "medium" | "high" {
  return req.effort ?? (tier === "fast" ? "low" : "medium");
}

/** Combines the caller's signal with a timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Calls a provider with engine extensions (images, timeout); plain providers ignore them. */
export function completeWithImages<T>(p: LlmProvider, req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
  return p.complete(req);
}
