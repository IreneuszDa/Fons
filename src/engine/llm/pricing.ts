/**
 * Price table (USD per million tokens) used to compute ModelUsage.costUsd.
 * Anthropic prices are list prices. Mistral prices are ESTIMATES (check the current price list).
 * OpenAI prices: official price list read on 2026-11-21 (standard tier, uncached input — the engine
 * does not use cached input pricing, so costs are an upper bound when the provider caches prompts).
 */
export const OPENAI_PRICES_READ_ON = "2026-11-21";

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  estimate: boolean;
}

const PRICES: { prefix: string; price: Price }[] = [
  { prefix: "claude-opus-5-5", price: { inputPerMTok: 4, outputPerMTok: 20, estimate: false } },
  { prefix: "claude-sonnet-5-5", price: { inputPerMTok: 2, outputPerMTok: 10, estimate: false } },
  { prefix: "claude-haiku-5-5", price: { inputPerMTok: 0.1, outputPerMTok: 0.5, estimate: false } },
  // Possible server-side refusal fallback targets.
  { prefix: "claude-opus-5", price: { inputPerMTok: 5, outputPerMTok: 25, estimate: false } },
  { prefix: "claude-opus-4-8", price: { inputPerMTok: 5, outputPerMTok: 25, estimate: true } },
  // Mistral — estimates.
  { prefix: "mistral-large", price: { inputPerMTok: 2, outputPerMTok: 6, estimate: true } },
  { prefix: "mistral-medium", price: { inputPerMTok: 0.4, outputPerMTok: 2, estimate: true } },
  { prefix: "mistral-small", price: { inputPerMTok: 0.2, outputPerMTok: 0.6, estimate: true } },
  { prefix: "pixtral-large", price: { inputPerMTok: 2, outputPerMTok: 6, estimate: true } },
  // OpenAI — price list read on 2026-11-21 (input / output per 1M tokens).
  { prefix: "gpt-6.2-astra", price: { inputPerMTok: 8, outputPerMTok: 40, estimate: false } },
  { prefix: "gpt-6.2-sol", price: { inputPerMTok: 2, outputPerMTok: 10, estimate: false } },
  { prefix: "gpt-6.1-terra", price: { inputPerMTok: 1, outputPerMTok: 5, estimate: false } },
  { prefix: "gpt-6-luna", price: { inputPerMTok: 0.1, outputPerMTok: 0.5, estimate: false } },
  // Other / unknown OpenAI ids — ESTIMATES (conservative: priced like the main model).
  { prefix: "gpt-6", price: { inputPerMTok: 2, outputPerMTok: 10, estimate: true } },
  { prefix: "gpt-5", price: { inputPerMTok: 1.25, outputPerMTok: 10, estimate: true } },
];

const FALLBACK_BY_PROVIDER: Record<string, Price> = {
  anthropic: { inputPerMTok: 4, outputPerMTok: 20, estimate: true },
  mistral: { inputPerMTok: 2, outputPerMTok: 6, estimate: true },
  openai: { inputPerMTok: 2, outputPerMTok: 10, estimate: true },
  gemini: { inputPerMTok: 1.5, outputPerMTok: 7.5, estimate: true },
  fake: { inputPerMTok: 0, outputPerMTok: 0, estimate: false },
};

export function priceFor(model: string, provider: string): Price {
  const m = model.toLowerCase();
  // Standard list price, including thinking tokens. Google scheduled the promotion to end on 2026-12-31.
  // https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
  if (provider === "gemini" && /^gemini-3\.8-flash(?:$|-\d)/.test(m)) {
    return Date.now() < Date.UTC(2027, 0, 1)
      ? { inputPerMTok: 0.75, outputPerMTok: 3.75, estimate: false }
      : { inputPerMTok: 1.5, outputPerMTok: 7.5, estimate: false };
  }
  // Longest matching prefix wins ("claude-opus-5-5" before "claude-opus-5").
  let best: { prefix: string; price: Price } | undefined;
  for (const p of PRICES) {
    if (m.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best?.price ?? FALLBACK_BY_PROVIDER[provider] ?? { inputPerMTok: 0, outputPerMTok: 0, estimate: true };
}

export function costUsd(model: string, provider: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model, provider);
  const cost = (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
