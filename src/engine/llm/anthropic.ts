/**
 * Anthropic (Claude) provider.
 *
 * - Model from AppConfig (MODEL_MAIN / MODEL_FAST; default claude-opus-5-5 for both tiers).
 * - Effort via output_config.effort: fast tier "low", main tier "medium" (overridable per request).
 * - No `thinking` parameter (adaptive thinking is the default on Opus 5.5) and no budget_tokens,
 *   temperature or top_p — those return 400 on this model.
 * - Structured outputs: output_config.format = JSON schema generated from the zod schema
 *   (zodOutputFormat), validated again with zod on our side.
 * - Server-side refusal fallback: betas ["server-side-fallback-2026-07-01"], fallbacks: "default".
 *   This composes with structured outputs: per the SDK's BetaFallbackParam docs, a fallback attempt
 *   "uses the request's `format`" unless an entry overrides it, and the fallback targets
 *   (claude-opus-5 / claude-opus-4-8) support structured outputs. If the beta is not enabled for the
 *   organization (400), we turn it off for this provider instance and retry once without it.
 * - stop_reason "refusal" → LlmUnavailableError("refusal"); "max_tokens" → one retry with more
 *   tokens, then LlmUnavailableError("schema").
 * - Typed SDK errors → LlmUnavailableError reasons; provider error text never reaches users.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmUnavailableError, type LlmResponse } from "../../shared/contracts";
import { costUsd } from "./pricing";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_TOKENS_RETRY_CAP,
  effortFor,
  type EngineLlmProvider,
  type EngineLlmRequest,
  type ProviderModels,
} from "./types";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Minimal surface of the SDK client we use (lets tests inject a stub without network). */
export interface AnthropicLikeClient {
  beta: {
    messages: {
      create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
    };
  };
}

interface AnthropicResponseLike {
  model?: string;
  stop_reason?: string | null;
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    iterations?: { input_tokens?: number; output_tokens?: number }[] | null;
  };
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  models: ProviderModels;
  defaultTier?: "fast" | "main";
  enableFallbacks?: boolean;
  client?: AnthropicLikeClient;
}

export function mapAnthropicError(e: unknown): LlmUnavailableError {
  if (e instanceof LlmUnavailableError) return e;
  // Most specific first (APIConnectionTimeoutError ⊂ APIConnectionError ⊂ APIError).
  if (e instanceof APIUserAbortError) return new LlmUnavailableError("timeout");
  if (e instanceof APIConnectionTimeoutError) return new LlmUnavailableError("timeout");
  if (e instanceof RateLimitError) return new LlmUnavailableError("rate_limit");
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
    return new LlmUnavailableError("provider_error", "auth");
  }
  if (e instanceof APIConnectionError) return new LlmUnavailableError("provider_error", "connection");
  if (e instanceof APIError) return new LlmUnavailableError("provider_error", `status_${String(e.status)}`);
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return new LlmUnavailableError("timeout");
  }
  return new LlmUnavailableError("provider_error");
}

export class AnthropicProvider implements EngineLlmProvider {
  readonly name = "anthropic";
  readonly family = "anthropic";
  readonly available: boolean;
  readonly models: ProviderModels;
  readonly supportsVision = true;
  readonly processingRegion = "us" as const;
  private readonly defaultTier: "fast" | "main";
  private fallbacksEnabled: boolean;
  private readonly client: AnthropicLikeClient | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.models = opts.models;
    this.defaultTier = opts.defaultTier ?? "main";
    this.fallbacksEnabled = opts.enableFallbacks ?? true;
    this.client =
      opts.client ??
      (opts.apiKey
        ? (new Anthropic({ apiKey: opts.apiKey, maxRetries: 1 }) as unknown as AnthropicLikeClient)
        : undefined);
    this.available = this.client !== undefined;
  }

  async complete<T>(req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
    if (!this.client) throw new LlmUnavailableError("no_key");
    const tier = req.tier ?? this.defaultTier;
    const model = this.models[tier];
    let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS[tier];
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS[tier];
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let servedModel = model;
    let retriedMaxTokens = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const body = this.buildBody(req, model, tier, maxTokens);
      let res: AnthropicResponseLike;
      try {
        res = (await this.client.beta.messages.create(body, {
          timeout: timeoutMs,
          signal: req.signal,
        })) as AnthropicResponseLike;
      } catch (e) {
        if (e instanceof BadRequestError && this.fallbacksEnabled) {
          // The fallback beta may not be enabled for this organization — continue without it.
          this.fallbacksEnabled = false;
          continue;
        }
        throw mapAnthropicError(e);
      }

      const usage = readUsage(res);
      inputTokens += usage.input;
      outputTokens += usage.output;
      servedModel = res.model ?? model;

      if (res.stop_reason === "refusal") throw new LlmUnavailableError("refusal");
      if (res.stop_reason === "max_tokens") {
        if (retriedMaxTokens || maxTokens >= MAX_TOKENS_RETRY_CAP) {
          throw new LlmUnavailableError("schema", "max_tokens");
        }
        retriedMaxTokens = true;
        maxTokens = Math.min(MAX_TOKENS_RETRY_CAP, maxTokens * 2);
        continue;
      }

      const text = finalText(res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmUnavailableError("schema", "invalid_json");
      }
      const check = req.schema.safeParse(parsed);
      if (!check.success) throw new LlmUnavailableError("schema", "schema_mismatch");
      return {
        data: check.data,
        usage: {
          purpose: req.purpose,
          provider: this.name,
          model: servedModel,
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - started,
          costUsd: costUsd(servedModel, this.name, inputTokens, outputTokens),
        },
      };
    }
    throw new LlmUnavailableError("schema", "max_tokens");
  }

  private buildBody<T>(req: EngineLlmRequest<T>, model: string, tier: "fast" | "main", maxTokens: number) {
    const format = zodOutputFormat(req.schema as never) as { schema: Record<string, unknown> };
    const content: Record<string, unknown>[] = [];
    for (const img of req.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.base64 } });
    }
    content.push({ type: "text", text: req.user });
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: "user", content }],
      output_config: {
        effort: effortFor(req, tier),
        format: { type: "json_schema", schema: format.schema },
      },
    };
    if (this.fallbacksEnabled) {
      body.betas = [FALLBACK_BETA];
      body.fallbacks = "default";
    }
    return body;
  }
}

function readUsage(res: AnthropicResponseLike): { input: number; output: number } {
  const u = res.usage;
  if (!u) return { input: 0, output: 0 };
  // With a server-side fallback, `iterations` lists every attempt; top-level usage covers only the
  // attempt that produced the message.
  if (Array.isArray(u.iterations) && u.iterations.length > 0) {
    let input = 0;
    let output = 0;
    for (const it of u.iterations) {
      input += it.input_tokens ?? 0;
      output += it.output_tokens ?? 0;
    }
    return { input, output };
  }
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { input, output: u.output_tokens ?? 0 };
}

/** Text of the final answer: text blocks after the last `fallback` boundary block. */
function finalText(res: AnthropicResponseLike): string {
  const blocks = res.content ?? [];
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === "fallback") start = i + 1;
  });
  return blocks
    .slice(start)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}
