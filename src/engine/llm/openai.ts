/**
 * OpenAI provider (Chat Completions over plain fetch — no SDK dependency).
 *
 * Structured output: response_format { type: "json_schema", json_schema: { name, schema, strict: true } }
 * with the same strict JSON schema as the Mistral provider, validated again with zod on our side.
 *  - OPENAI_DATA_RESIDENCY=eu → https://eu.api.openai.com (only for projects created with EU data
 *    residency); otherwise https://api.openai.com and processing in the USA (reported to the user).
 *  - finish_reason "length" → one retry with more tokens, then LlmUnavailableError("schema").
 *  - message.refusal → LlmUnavailableError("refusal").
 *  - reasoning_effort is sent (fast → low, main → medium); if the model rejects the parameter (400),
 *    the provider stops sending it for this instance and retries once.
 *  - store: false is sent (no storage of completions on the provider side for distillation/evals);
 *    if an endpoint rejects the parameter (400), it is dropped once for this instance.
 * Provider error bodies are never surfaced to users — only LlmUnavailableError reasons.
 */
import { LlmUnavailableError, type LlmResponse } from "../../shared/contracts";
import { toStrictJsonSchema } from "./mistral";
import { costUsd } from "./pricing";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_TOKENS_RETRY_CAP,
  effortFor,
  withTimeout,
  type EngineLlmProvider,
  type EngineLlmRequest,
  type ProviderModels,
} from "./types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiProviderOptions {
  apiKey?: string;
  models: ProviderModels;
  defaultTier?: "fast" | "main";
  /** "eu" → eu.api.openai.com (EEA processing); anything else → api.openai.com (USA). */
  dataResidency?: string;
  /** Injected for tests. */
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

interface ChatCompletionLike {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
}

export function openAiBaseUrl(dataResidency: string | undefined): string {
  return dataResidency?.trim().toLowerCase() === "eu" ? "https://eu.api.openai.com/v1" : "https://api.openai.com/v1";
}

export class OpenAiProvider implements EngineLlmProvider {
  readonly name = "openai";
  readonly family = "openai";
  readonly available: boolean;
  readonly models: ProviderModels;
  readonly supportsVision = true;
  readonly processingRegion: "eea" | "us";
  private readonly defaultTier: "fast" | "main";
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private sendEffort = true;
  private sendStore = true;
  static residencyWarned = false;

  constructor(opts: OpenAiProviderOptions) {
    this.models = opts.models;
    this.defaultTier = opts.defaultTier ?? "main";
    this.apiKey = opts.apiKey;
    this.available = !!opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? openAiBaseUrl(opts.dataResidency);
    this.processingRegion = opts.dataResidency?.trim().toLowerCase() === "eu" ? "eea" : "us";
  }

  async complete<T>(req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
    if (!this.apiKey) throw new LlmUnavailableError("no_key");
    const tier = req.tier ?? this.defaultTier;
    const model = this.models[tier];
    let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS[tier];
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS[tier];
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let lengthRetried = false;
    let effortRetried = false;
    let storeRetried = false;

    const userContent: unknown =
      req.images && req.images.length > 0
        ? [
            ...req.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
            { type: "text", text: req.user },
          ]
        : req.user;
    const schema = toStrictJsonSchema(req.schema);
    const schemaName = req.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

    for (;;) {
      const body: Record<string, unknown> = {
        model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } },
      };
      if (this.sendEffort) body.reasoning_effort = effortFor(req, tier);
      if (this.sendStore) body.store = false;

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: withTimeout(req.signal, timeoutMs),
        });
      } catch (e) {
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
          throw new LlmUnavailableError("timeout");
        }
        throw new LlmUnavailableError("provider_error", "connection");
      }

      if (!res.ok) {
        let errText = "";
        try {
          errText = await res.text();
        } catch {
          /* ignore */
        }
        if (res.status === 400 && this.sendEffort && !effortRetried && /reasoning_effort|reasoning/i.test(errText)) {
          this.sendEffort = false;
          effortRetried = true;
          continue;
        }
        if (res.status === 400 && this.sendStore && !storeRetried && /["'\s]store["'\s]|param[^a-z]*store/i.test(errText)) {
          this.sendStore = false;
          storeRetried = true;
          continue;
        }
        if (res.status === 429) {
          throw new LlmUnavailableError(/insufficient_quota/.test(errText) ? "budget" : "rate_limit");
        }
        if (res.status === 401 && /geography restrictions/i.test(errText)) {
          // OPENAI_DATA_RESIDENCY=eu with a project that has no EU data residency. We never silently
          // fall back to the US endpoint (that would move processing out of the EEA).
          if (!OpenAiProvider.residencyWarned) {
            OpenAiProvider.residencyWarned = true;
            console.warn(
              "[llm] OPENAI_DATA_RESIDENCY=eu, ale projekt OpenAI nie ma rezydencji danych w UE — endpoint eu.api.openai.com odrzuca klucz. " +
                "Usuń OPENAI_DATA_RESIDENCY (przetwarzanie w USA, raport to ujawnia) albo użyj klucza projektu z rezydencją w UE.",
            );
          }
          throw new LlmUnavailableError("provider_error", "eu_residency_not_enabled");
        }
        if (res.status === 401 || res.status === 403) throw new LlmUnavailableError("provider_error", "auth");
        if (res.status === 408 || res.status === 504) throw new LlmUnavailableError("timeout");
        throw new LlmUnavailableError("provider_error", `status_${res.status}`);
      }

      let json: ChatCompletionLike;
      try {
        json = (await res.json()) as ChatCompletionLike;
      } catch {
        throw new LlmUnavailableError("schema", "invalid_json");
      }
      inputTokens += json.usage?.prompt_tokens ?? 0;
      outputTokens += json.usage?.completion_tokens ?? 0;
      const choice = json.choices?.[0];
      if (choice?.message?.refusal) throw new LlmUnavailableError("refusal");
      if (choice?.finish_reason === "content_filter") throw new LlmUnavailableError("refusal");
      if (choice?.finish_reason === "length") {
        if (lengthRetried || maxTokens >= MAX_TOKENS_RETRY_CAP) throw new LlmUnavailableError("schema", "max_tokens");
        lengthRetried = true;
        maxTokens = Math.min(MAX_TOKENS_RETRY_CAP, maxTokens * 2);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(choice?.message?.content ?? "");
      } catch {
        throw new LlmUnavailableError("schema", "invalid_json");
      }
      const check = req.schema.safeParse(parsed);
      if (!check.success) throw new LlmUnavailableError("schema", "schema_mismatch");
      const servedModel = json.model ?? model;
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
