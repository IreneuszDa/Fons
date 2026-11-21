/**
 * Mistral provider (second model family; EU endpoint api.eu.mistral.ai, processing in the EEA).
 *
 * Structured output: responseFormat { type: "json_schema", jsonSchema: { name, schemaDefinition, strict } }
 * with a strict JSON schema generated from the zod schema, validated again with zod on our side.
 * finish_reason "length" → one retry with more tokens, then LlmUnavailableError("schema").
 * Mistral prices in pricing.ts are estimates.
 */
import { Mistral } from "@mistralai/mistralai";
import * as mistralErrors from "@mistralai/mistralai/models/errors";
import { z } from "zod";
import { LlmUnavailableError, type LlmResponse } from "../../shared/contracts";
import { costUsd } from "./pricing";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_TOKENS_RETRY_CAP,
  type EngineLlmProvider,
  type EngineLlmRequest,
  type ProviderModels,
} from "./types";

export interface MistralLikeClient {
  chat: {
    complete(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
}

interface MistralResponseLike {
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  choices?: { finishReason?: string; message?: { content?: unknown } }[];
}

export interface MistralProviderOptions {
  apiKey?: string;
  models: ProviderModels;
  defaultTier?: "fast" | "main";
  client?: MistralLikeClient;
}

/** Strict-mode JSON schema: every property required, additionalProperties false, no $schema. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return makeStrict(js) as Record<string, unknown>;
}

function makeStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(makeStrict);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = makeStrict(v);
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties as Record<string, unknown>);
    out.additionalProperties = false;
  }
  return out;
}

export function mapMistralError(e: unknown): LlmUnavailableError {
  if (e instanceof LlmUnavailableError) return e;
  if (e instanceof mistralErrors.RequestTimeoutError || e instanceof mistralErrors.RequestAbortedError) {
    return new LlmUnavailableError("timeout");
  }
  if (e instanceof mistralErrors.ConnectionError) return new LlmUnavailableError("provider_error", "connection");
  if (e instanceof mistralErrors.MistralError) {
    if (e.statusCode === 429) return new LlmUnavailableError("rate_limit");
    if (e.statusCode === 401 || e.statusCode === 403) return new LlmUnavailableError("provider_error", "auth");
    return new LlmUnavailableError("provider_error", `status_${e.statusCode}`);
  }
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return new LlmUnavailableError("timeout");
  }
  return new LlmUnavailableError("provider_error");
}

export class MistralProvider implements EngineLlmProvider {
  readonly name = "mistral";
  readonly family = "mistral";
  readonly available: boolean;
  readonly models: ProviderModels;
  readonly supportsVision = true;
  readonly processingRegion = "eea" as const;
  private readonly defaultTier: "fast" | "main";
  private readonly client: MistralLikeClient | undefined;

  constructor(opts: MistralProviderOptions) {
    this.models = opts.models;
    this.defaultTier = opts.defaultTier ?? "main";
    this.client =
      opts.client ??
      (opts.apiKey
        ? (new Mistral({ apiKey: opts.apiKey, server: "eu" }) as unknown as MistralLikeClient)
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
    let retried = false;

    const userContent: unknown =
      req.images && req.images.length > 0
        ? [
            ...req.images.map((img) => ({ type: "image_url", imageUrl: `data:${img.mime};base64,${img.base64}` })),
            { type: "text", text: req.user },
          ]
        : req.user;

    for (;;) {
      let res: MistralResponseLike;
      try {
        res = (await this.client.chat.complete(
          {
            model,
            maxTokens,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: userContent },
            ],
            responseFormat: {
              type: "json_schema",
              jsonSchema: {
                name: req.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
                schemaDefinition: toStrictJsonSchema(req.schema),
                strict: true,
              },
            },
          },
          { timeoutMs, signal: req.signal, retries: { strategy: "none" } },
        )) as MistralResponseLike;
      } catch (e) {
        throw mapMistralError(e);
      }
      inputTokens += res.usage?.promptTokens ?? 0;
      outputTokens += res.usage?.completionTokens ?? 0;
      const choice = res.choices?.[0];
      if (choice?.finishReason === "length") {
        if (retried || maxTokens >= MAX_TOKENS_RETRY_CAP) throw new LlmUnavailableError("schema", "max_tokens");
        retried = true;
        maxTokens = Math.min(MAX_TOKENS_RETRY_CAP, maxTokens * 2);
        continue;
      }
      const raw = choice?.message?.content;
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("")
            : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmUnavailableError("schema", "invalid_json");
      }
      const check = req.schema.safeParse(parsed);
      if (!check.success) throw new LlmUnavailableError("schema", "schema_mismatch");
      const servedModel = res.model ?? model;
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
  }
}
