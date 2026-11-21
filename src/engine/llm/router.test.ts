import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmUnavailableError } from "../../shared/contracts";
import type { AppConfig } from "../../server/config";
import { FakeLlmProvider } from "./fake";
import { createLlmProviders } from "./index";
import { ModelRouter, ROUTING_TABLE, runWithRouteTrace, tierFor, type RouteTrace } from "./router";
import type { EngineLlmRequest } from "./types";

const Schema = z.object({ text: z.string() });
const req = (purpose: string, extra: Partial<EngineLlmRequest<{ text: string }>> = {}): EngineLlmRequest<{ text: string }> => ({
  purpose,
  system: "s",
  user: "<<<BEGIN TEKST 000000000000000000000000>>>\nx\n<<<END TEKST 000000000000000000000000>>>",
  schema: Schema,
  schemaName: "smoothing",
  ...extra,
});

/** Fake that fails on the given tiers with the given reason. */
function fake(name: string, family: string, failOn: Partial<Record<"fast" | "main", LlmUnavailableError["reason"]>> = {}) {
  return new FakeLlmProvider({
    name,
    family,
    models: { main: `${name}-main`, fast: `${name}-fast` },
    override: (r) => {
      const reason = failOn[(r.tier ?? "main") as "fast" | "main"];
      if (reason) throw new LlmUnavailableError(reason);
      return undefined;
    },
  });
}

function trace(): RouteTrace {
  return { usages: [], decisions: [] };
}

describe("routing table", () => {
  it("maps purposes to tiers explicitly", () => {
    expect(ROUTING_TABLE).toMatchObject({ claims: "fast", router: "fast", verifier: "fast", vision: "fast", assess: "main", open_answer: "main" });
    expect(tierFor("claims", "main")).toBe("fast");
    expect(tierFor("assess", "fast")).toBe("main");
    expect(tierFor("unknown", "fast")).toBe("fast");
    expect(tierFor("unknown")).toBe("main");
  });

  it("the table overrides the caller's tier", async () => {
    const p = fake("openai", "openai");
    const r = new ModelRouter({ primary: p, log: () => {} });
    const res = await r.complete(req("claims", { tier: "main" }));
    expect(res.usage.model).toBe("openai-fast");
    expect(p.calls.map((c) => c.tier)).toEqual(["fast"]);
  });

  it("looks like its primary provider", () => {
    const p = new FakeLlmProvider({ name: "openai", family: "openai", supportsVision: true, processingRegion: "us" });
    const r = new ModelRouter({ primary: p, log: () => {} });
    expect([r.name, r.family, r.available, r.supportsVision, r.processingRegion]).toEqual(["openai", "openai", true, true, "us"]);
  });
});

describe("escalation", () => {
  for (const reason of ["schema", "refusal", "timeout"] as const) {
    it(`fast tier ${reason} → retried once on the main tier`, async () => {
      const p = fake("openai", "openai", { fast: reason });
      const t = trace();
      const lines: string[] = [];
      const res = await runWithRouteTrace(t, () => new ModelRouter({ primary: p, log: (l) => lines.push(l) }).complete(req("claims")));
      expect(res.usage.model).toBe("openai-main");
      expect(p.calls.map((c) => c.tier)).toEqual(["fast", "main"]);
      expect(t.decisions.map((d) => [d.step, d.tier, d.outcome])).toEqual([
        ["primary", "fast", "failed"],
        ["escalated", "main", "ok"],
      ]);
      expect(t.usages).toEqual([expect.objectContaining({ purpose: "claims:failed", model: "openai-fast", costUsd: 0, inputTokens: 0 })]);
      expect(lines[0]).toMatch(/^\[router\] purpose=claims tier=fast step=primary provider=openai model=openai-fast outcome=failed reason=/);
    });
  }

  it("fast tier provider error → no same-provider retry; fallback family on the same tier", async () => {
    const p = fake("openai", "openai", { fast: "rate_limit" });
    const fb = fake("anthropic", "anthropic");
    const res = await new ModelRouter({ primary: p, fallback: fb, log: () => {} }).complete(req("claims"));
    expect(p.calls.map((c) => c.tier)).toEqual(["fast"]);
    expect(res.usage.provider).toBe("anthropic");
    expect(res.usage.model).toBe("anthropic-fast");
  });

  it("main tier failure → fallback provider of another family", async () => {
    const p = fake("openai", "openai", { main: "provider_error" });
    const fb = fake("anthropic", "anthropic");
    const t = trace();
    const res = await runWithRouteTrace(t, () => new ModelRouter({ primary: p, fallback: fb, log: () => {} }).complete(req("assess")));
    expect(res.usage).toMatchObject({ provider: "anthropic", model: "anthropic-main", purpose: "assess" });
    expect(t.decisions.map((d) => d.step)).toEqual(["primary", "fallback"]);
  });

  it("escalated main failure → fallback provider", async () => {
    const p = fake("openai", "openai", { fast: "schema", main: "timeout" });
    const fb = fake("mistral", "mistral");
    const res = await new ModelRouter({ primary: p, fallback: fb, log: () => {} }).complete(req("verifier"));
    expect(res.usage.model).toBe("mistral-main");
  });

  it("main failure without a fallback → LlmUnavailableError", async () => {
    const p = fake("openai", "openai", { main: "provider_error" });
    const err = await new ModelRouter({ primary: p, log: () => {} }).complete(req("assess")).catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err.reason).toBe("provider_error");
  });

  it("a fallback from the same family is ignored", async () => {
    const p = fake("openai", "openai", { main: "provider_error" });
    const same = fake("openai2", "openai");
    const r = new ModelRouter({ primary: p, fallback: same, log: () => {} });
    expect(r.fallback).toBeUndefined();
    await expect(r.complete(req("assess"))).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("a caller abort is never escalated", async () => {
    const p = fake("openai", "openai", { fast: "timeout" });
    const ac = new AbortController();
    ac.abort();
    await expect(new ModelRouter({ primary: p, log: () => {} }).complete(req("claims", { signal: ac.signal }))).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(p.calls).toHaveLength(1);
  });

  it("vision requests skip a fallback without vision", async () => {
    const p = new FakeLlmProvider({ name: "openai", family: "openai", supportsVision: true, failWith: "provider_error" });
    const fb = new FakeLlmProvider({ name: "mistral", family: "mistral", supportsVision: false });
    const err = await new ModelRouter({ primary: p, fallback: fb, log: () => {} })
      .complete(req("vision", { images: [{ mime: "image/png", base64: "AAA" }] }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(fb.calls).toHaveLength(0);
  });
});

describe("createLlmProviders wiring", () => {
  const base: AppConfig = {
    env: "test",
    port: 1,
    publicBaseUrl: "http://x",
    dbPath: ":memory:",
    llmProvider: "openai",
    modelMain: "gpt-6.2-sol",
    modelFast: "gpt-6-luna",
    adminPassword: "x",
    adminPasswordGenerated: false,
    userIdPepper: "p",
    dailyTokenBudget: 1,
    rateLimitPerMinute: 1,
    liveSearch: false,
    verdictMode: "rules",
  };

  it("keyed providers are routed; the main router falls back to the other family", () => {
    const { main, verifier } = createLlmProviders({ ...base, openaiApiKey: "o", anthropicApiKey: "a", verifierProvider: "anthropic" });
    expect(main).toBeInstanceOf(ModelRouter);
    expect((main as ModelRouter).fallback?.family).toBe("anthropic");
    expect(verifier).toBeInstanceOf(ModelRouter);
    expect((verifier as ModelRouter).fallback).toBeUndefined();
    expect(verifier.family).toBe("anthropic");
  });

  it("single key: routed, no fallback", () => {
    const { main, singleKey } = createLlmProviders({ ...base, openaiApiKey: "o" });
    expect(main).toBeInstanceOf(ModelRouter);
    expect((main as ModelRouter).fallback).toBeUndefined();
    expect(singleKey).toBe(true);
  });
});
