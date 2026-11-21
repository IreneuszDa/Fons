import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmUnavailableError } from "../../shared/contracts";
import { loadConfig, type AppConfig } from "../../server/config";
import { createLlmProviders } from "./index";
import { OpenAiProvider, openAiBaseUrl, type FetchLike } from "./openai";
import { processingRegion } from "./types";

const Schema = z.object({ answer: z.string(), n: z.number().nullable() });
const req = { purpose: "test", system: "sys", user: "u", schema: Schema, schemaName: "t.schema" } as const;
const models = { main: "gpt-main", fast: "gpt-fast" };

function completion(content: string | null, extra: Record<string, unknown> = {}, finish = "stop") {
  return {
    model: "gpt-main-2026",
    usage: { prompt_tokens: 100, completion_tokens: 20 },
    choices: [{ finish_reason: finish, message: { content, refusal: null, ...extra } }],
  };
}

function stub(responses: (Response | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OpenAiProvider", () => {
  it("sends a strict json_schema request and validates the answer with zod", async () => {
    const { fetchImpl, calls } = stub([json(completion('{"answer":"ok","n":null}'))]);
    const p = new OpenAiProvider({ apiKey: "k", models, fetchImpl });
    const r = await p.complete({ ...req, tier: "fast" });
    expect(r.data).toEqual({ answer: "ok", n: null });
    expect(r.usage).toMatchObject({ provider: "openai", model: "gpt-main-2026", inputTokens: 100, outputTokens: 20 });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer k");
    expect(c.body.model).toBe("gpt-fast");
    expect(c.body.reasoning_effort).toBe("low");
    const rf = c.body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: { additionalProperties: boolean; required: string[] } } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.name).toBe("t_schema");
    expect(rf.json_schema.schema.additionalProperties).toBe(false);
    expect(rf.json_schema.schema.required).toEqual(["answer", "n"]);
    expect(c.body).not.toHaveProperty("temperature");
  });

  it("EU data residency → eu.api.openai.com and EEA processing", () => {
    expect(openAiBaseUrl("eu")).toBe("https://eu.api.openai.com/v1");
    expect(openAiBaseUrl(undefined)).toBe("https://api.openai.com/v1");
    expect(processingRegion(new OpenAiProvider({ apiKey: "k", models, dataResidency: "eu" }))).toBe("eea");
    expect(processingRegion(new OpenAiProvider({ apiKey: "k", models }))).toBe("us");
  });

  it("no key → no_key without any request", async () => {
    const { fetchImpl, calls } = stub([]);
    const p = new OpenAiProvider({ models, fetchImpl });
    expect(p.available).toBe(false);
    await expect(p.complete(req)).rejects.toMatchObject({ reason: "no_key" });
    expect(calls).toHaveLength(0);
  });

  it("refusal and content_filter → refusal", async () => {
    const a = stub([json(completion(null, { refusal: "nope" }))]);
    await expect(new OpenAiProvider({ apiKey: "k", models, fetchImpl: a.fetchImpl }).complete(req)).rejects.toMatchObject({ reason: "refusal" });
    const b = stub([json(completion("", {}, "content_filter"))]);
    await expect(new OpenAiProvider({ apiKey: "k", models, fetchImpl: b.fetchImpl }).complete(req)).rejects.toMatchObject({ reason: "refusal" });
  });

  it("finish_reason length → one retry with doubled tokens, then schema error", async () => {
    const ok = stub([json(completion("{", {}, "length")), json(completion('{"answer":"a","n":1}'))]);
    const r = await new OpenAiProvider({ apiKey: "k", models, fetchImpl: ok.fetchImpl }).complete({ ...req, tier: "fast" });
    expect(r.data.n).toBe(1);
    expect(ok.calls[1]!.body.max_completion_tokens).toBe(2 * (ok.calls[0]!.body.max_completion_tokens as number));
    expect(r.usage.inputTokens).toBe(200);
    const bad = stub([json(completion("{", {}, "length")), json(completion("{", {}, "length"))]);
    await expect(new OpenAiProvider({ apiKey: "k", models, fetchImpl: bad.fetchImpl }).complete(req)).rejects.toMatchObject({ reason: "schema" });
  });

  it("invalid JSON or schema mismatch → schema error", async () => {
    const a = stub([json(completion("not json"))]);
    await expect(new OpenAiProvider({ apiKey: "k", models, fetchImpl: a.fetchImpl }).complete(req)).rejects.toMatchObject({ reason: "schema" });
    const b = stub([json(completion('{"answer":1}'))]);
    await expect(new OpenAiProvider({ apiKey: "k", models, fetchImpl: b.fetchImpl }).complete(req)).rejects.toMatchObject({ reason: "schema" });
  });

  it("maps HTTP errors without exposing provider text", async () => {
    const cases: [Response | Error, string][] = [
      [json({ error: { message: "slow down" } }, 429), "rate_limit"],
      [json({ error: { code: "insufficient_quota" } }, 429), "budget"],
      [json({ error: { message: "bad key sk-secret" } }, 401), "provider_error"],
      [json({ error: { message: "boom" } }, 500), "provider_error"],
      [Object.assign(new Error("t"), { name: "TimeoutError" }), "timeout"],
      [new TypeError("fetch failed"), "provider_error"],
    ];
    for (const [res, reason] of cases) {
      const s = stub([res]);
      const err = await new OpenAiProvider({ apiKey: "k", models, fetchImpl: s.fetchImpl }).complete(req).catch((e) => e);
      expect(err).toBeInstanceOf(LlmUnavailableError);
      expect(err.reason).toBe(reason);
      expect(String(err.message)).not.toContain("sk-secret");
    }
  });

  it("drops reasoning_effort once if the model rejects it", async () => {
    const s = stub([
      json({ error: { message: "Unsupported parameter: 'reasoning_effort'", param: "reasoning_effort" } }, 400),
      json(completion('{"answer":"ok","n":2}')),
      json(completion('{"answer":"ok","n":3}')),
    ]);
    const p = new OpenAiProvider({ apiKey: "k", models, fetchImpl: s.fetchImpl });
    expect((await p.complete(req)).data.n).toBe(2);
    expect(s.calls[1]!.body).not.toHaveProperty("reasoning_effort");
    expect((await p.complete(req)).data.n).toBe(3);
    expect(s.calls[2]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("sends store:false and drops it once if the endpoint rejects it", async () => {
    const s = stub([
      json({ error: { message: "Unrecognized request argument supplied: store", param: "store" } }, 400),
      json(completion('{"answer":"ok","n":2}')),
    ]);
    const p = new OpenAiProvider({ apiKey: "k", models, fetchImpl: s.fetchImpl });
    expect((await p.complete(req)).data.n).toBe(2);
    expect(s.calls[0]!.body.store).toBe(false);
    expect(s.calls[1]!.body).not.toHaveProperty("store");
  });

  it("prices gpt-6.2-sol / gpt-6-luna from the 2026-11-21 price list", async () => {
    const s = stub([json({ ...completion('{"answer":"ok","n":1}'), model: "gpt-6.2-sol-2026-10-01", usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } })]);
    const r = await new OpenAiProvider({ apiKey: "k", models, fetchImpl: s.fetchImpl }).complete(req);
    expect(r.usage.costUsd).toBe(3); // 1M × 2 + 0.1M × 10
  });

  it("sends images as data URLs", async () => {
    const s = stub([json(completion('{"answer":"ok","n":1}'))]);
    await new OpenAiProvider({ apiKey: "k", models, fetchImpl: s.fetchImpl }).complete({ ...req, images: [{ mime: "image/png", base64: "AAA" }] });
    const user = (s.calls[0]!.body.messages as { role: string; content: unknown }[])[1]!;
    expect(user.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "text", text: "u" },
    ]);
  });
});

describe("OpenAI in config and factory", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("LLM_PROVIDER=openai with OPENAI_API_KEY selects openai with default models", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("MODEL_MAIN", "");
    vi.stubEnv("MODEL_FAST", "");
    vi.stubEnv("ADMIN_PASSWORD", "x");
    vi.stubEnv("USER_ID_PEPPER", "p");
    const cfg = loadConfig({ dbPath: ":memory:" });
    expect(cfg.llmProvider).toBe("openai");
    expect(cfg.openaiApiKey).toBe("sk-test");
    expect(cfg.modelMain).toBeTruthy();
    const { main, verifier, singleKey } = createLlmProviders(cfg);
    expect(main.name).toBe("openai");
    expect(main.available).toBe(true);
    expect(verifier.family).toBe("openai");
    expect(singleKey).toBe(true);
    vi.unstubAllEnvs();
  });

  it("a keyed provider is chosen when the requested one has no key", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("ADMIN_PASSWORD", "x");
    vi.stubEnv("USER_ID_PEPPER", "p");
    expect(loadConfig({ dbPath: ":memory:" }).llmProvider).toBe("openai");
    vi.unstubAllEnvs();
  });

  it("openai + anthropic keys with VERIFIER_PROVIDER=anthropic → cross-family verifier", () => {
    const cfg: AppConfig = {
      env: "test",
      port: 1,
      publicBaseUrl: "http://x",
      dbPath: ":memory:",
      llmProvider: "openai",
      openaiApiKey: "o",
      anthropicApiKey: "a",
      verifierProvider: "anthropic",
      modelMain: "gpt-main",
      modelFast: "gpt-fast",
      adminPassword: "x",
      adminPasswordGenerated: false,
      userIdPepper: "p",
      dailyTokenBudget: 1,
      rateLimitPerMinute: 1,
      liveSearch: false,
      verdictMode: "rules",
    };
    const { main, verifier, singleKey } = createLlmProviders(cfg);
    expect(main.family).toBe("openai");
    expect(verifier.family).toBe("anthropic");
    expect(singleKey).toBe(false);
  });
});
