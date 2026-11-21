/**
 * FakeLlmProvider — deterministic, heuristic stand-in for a language model.
 * For unit tests and for an explicit LLM_PROVIDER=fake only; never chosen silently.
 *
 * It reads the fenced blocks of each prompt (see prompts.ts / fence.ts) and answers per schema:
 *  - claims: sentences of the input with >= 3 content words (opinion / forecast markers → type);
 *    "Czy …?" → question_yesno with the declarative claim; "Kto/Ile/… ?" → question_open,
 *  - open_answer: the fragment sentence with the best overlap with the question (or found = false),
 *  - assessment: best-overlapping sentence of each fragment as a verbatim quote; relation from overlap
 *    and negation mismatch,
 *  - verifier_votes: configured vote (default "zgoda"),
 *  - image_transcription: configured text (a fake cannot see images),
 *  - smoothing: returns the input unchanged.
 */
import { LlmUnavailableError, type LlmResponse } from "../../shared/contracts";
import { contentWords, foldForMatch, ngramContainment, splitSentences, truncateWords } from "../text";
import { parseFences } from "./fence";
import type { EngineLlmProvider, EngineLlmRequest, ProviderModels } from "./types";

type Vote = "zgoda" | "sprzeciw" | "niepewne";

export interface FakeLlmOptions {
  available?: boolean;
  name?: string;
  family?: string;
  models?: ProviderModels;
  supportsVision?: boolean;
  processingRegion?: "eea" | "us" | "local";
  /** Text "seen" on images (vision). Undefined → unreadable. */
  visionText?: string;
  verifierVote?: Vote;
  /** Fail every call (or calls with the given purpose) with this reason. */
  failWith?: LlmUnavailableError["reason"] | Partial<Record<string, LlmUnavailableError["reason"]>>;
  /**
   * Test hook: return a raw answer for a request (validated against the schema), or undefined to
   * use the heuristic answer. `heuristic()` computes the default answer for modification.
   */
  override?: (req: EngineLlmRequest<unknown>, heuristic: () => unknown) => unknown;
}

export interface FakeCall {
  purpose: string;
  schemaName: string;
  system: string;
  user: string;
  tier?: "fast" | "main";
  images: number;
}

const OPINION = /\b(uwazam|moim zdaniem|mysle|sadze|najlepsz\w*|najgorsz\w*|piekn\w*|okropn\w*|powinien|powinna|powinno|powinni|wspanial\w*|fataln\w*|beznadziej\w*|skandaliczn\w*)\b/;
const FORECAST = /\b(bedzie|beda|za rok|w przyszlosci|wkrotce|przewiduje\w*|prognoz\w*|zostanie|zostana)\b/;
const NEGATION = /\b(nie|nigdy|zaden|zadna|zadne|brak|falsz\w*|nieprawd\w*|not|never|false|no)\b/;

function hasNegation(s: string): boolean {
  return NEGATION.test(foldForMatch(s));
}

export class FakeLlmProvider implements EngineLlmProvider {
  readonly name: string;
  readonly family: string;
  readonly available: boolean;
  readonly models: ProviderModels;
  readonly supportsVision: boolean;
  readonly processingRegion: "eea" | "us" | "local";
  readonly calls: FakeCall[] = [];

  constructor(private readonly opts: FakeLlmOptions = {}) {
    this.name = opts.name ?? "fake";
    this.family = opts.family ?? "fake";
    this.available = opts.available ?? true;
    this.models = opts.models ?? { main: "fake-heuristic", fast: "fake-heuristic-fast" };
    this.supportsVision = opts.supportsVision ?? false;
    this.processingRegion = opts.processingRegion ?? "local";
  }

  async complete<T>(req: EngineLlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls.push({
      purpose: req.purpose,
      schemaName: req.schemaName,
      system: req.system,
      user: req.user,
      tier: req.tier,
      images: req.images?.length ?? 0,
    });
    if (!this.available) throw new LlmUnavailableError("no_key");
    const fail = this.opts.failWith;
    if (typeof fail === "string") throw new LlmUnavailableError(fail);
    if (fail && fail[req.purpose]) throw new LlmUnavailableError(fail[req.purpose]!);

    const overridden = this.opts.override?.(req as EngineLlmRequest<unknown>, () => this.answer(req));
    const raw = overridden !== undefined ? overridden : this.answer(req);
    const check = req.schema.safeParse(raw);
    if (!check.success) throw new LlmUnavailableError("schema", "fake_schema_mismatch");
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(raw).length / 4);
    const tier = req.tier ?? "main";
    return {
      data: check.data,
      usage: {
        purpose: req.purpose,
        provider: this.name,
        model: this.models[tier],
        inputTokens,
        outputTokens,
        latencyMs: 0,
        costUsd: 0,
      },
    };
  }

  private answer(req: EngineLlmRequest<unknown>): unknown {
    const fences = parseFences(req.user);
    const byLabel = (l: string) => fences.find((f) => f.label === l)?.content ?? "";
    switch (req.schemaName) {
      case "claims":
        return fakeClaimsOut(byLabel("WEJSCIE"));
      case "open_answer": {
        const question = byLabel("PYTANIE");
        let best = { ref: "", quote: "", score: 0 };
        for (const f of fences.filter((x) => x.label.startsWith("FRAGMENT_"))) {
          for (const s of splitSentences(f.content)) {
            const score = ngramContainment(question, s);
            if (score > best.score) best = { ref: f.label.slice("FRAGMENT_".length), quote: truncateWords(s, 300), score };
          }
        }
        return best.score >= 0.3 ? { found: true, ref: best.ref, quote: best.quote } : { found: false, ref: "", quote: "" };
      }
      case "assessment":
      case "assessment_proposal": {
        const claim = byLabel("TWIERDZENIE");
        const content = fences
          .filter((f) => f.label.startsWith("FRAGMENT_"))
          .map((f) => fakeAssess(f.label.slice("FRAGMENT_".length), claim, f.content));
        const fixedRole = fences
          .filter((f) => f.label.startsWith("TEZA_"))
          .map((f) => ({ ref: f.label.slice("TEZA_".length), match: fakeFixedMatch(claim, f.content) }));
        if (req.schemaName === "assessment") return { content, fixedRole };
        const proposedVerdict = content.some((c) => c.relation === "WSPIERA")
          ? "POTWIERDZONE"
          : content.some((c) => c.relation === "OBALA")
            ? "FALSZYWE"
            : "BRAK_DOWODOW";
        return { content, fixedRole, proposedVerdict };
      }
      case "verifier_votes":
        return {
          votes: fences
            .filter((f) => f.label.startsWith("POZYCJA_"))
            .map((f) => ({ ref: f.label.slice("POZYCJA_".length), vote: this.opts.verifierVote ?? "zgoda" })),
        };
      case "image_transcription": {
        const t = this.opts.visionText;
        if (!t) return { readable: false, text: "", dates: [] };
        const dates = [...t.matchAll(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
        return { readable: true, text: t, dates };
      }
      case "smoothing":
        return { text: byLabel("TEKST") };
      default:
        throw new LlmUnavailableError("schema", "fake_unknown_schema");
    }
  }
}

const EMPTY_QUESTION = { searchPl: [] as string[], searchEn: "", entities: [] as string[], aboutPresent: false };
const OPEN_Q = /^(kto|co|ile|kiedy|gdzie|jaki|jaka|jakie|ktory|ktora|ktore|jak|dlaczego)\b/;

function fakeClaimsOut(input: string) {
  const t = input.trim();
  const f = foldForMatch(t);
  if (/\?\s*$/.test(t) && OPEN_Q.test(f)) {
    const kw = contentWords(t);
    return {
      inputMode: "question_open",
      claims: [],
      question: { searchPl: [kw.join(" ")], searchEn: t, entities: [], aboutPresent: /\b(jest|sa|obecnie|teraz)\b/.test(f) },
    };
  }
  if (/\?\s*$/.test(t) && /^czy\b/.test(f)) {
    const declarative = t
      .replace(/^czy\s+(to\s+prawda,?\s+(ze|że)\s+)?/i, "")
      .replace(/\?\s*$/, "")
      .trim();
    const text = declarative.charAt(0).toUpperCase() + declarative.slice(1) + ".";
    return { inputMode: "question_yesno", claims: fakeClaims(text, 2), question: EMPTY_QUESTION };
  }
  return { inputMode: "claim", claims: fakeClaims(t), question: EMPTY_QUESTION };
}

function fakeClaims(input: string, minWords = 3) {
  const sentences = splitSentences(input).filter((s) => contentWords(s).length >= minWords);
  return sentences.slice(0, 3).map((s, i) => {
    const f = foldForMatch(s);
    const type = OPINION.test(f) ? "opinia" : FORECAST.test(f) ? "prognoza" : "fakt";
    const iso = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/.exec(s);
    const year = /\b((?:19|20)\d{2})\b/.exec(s);
    const date = iso ? iso[0] : year ? (year[1] ?? null) : null;
    const kw = contentWords(s);
    return {
      text: s,
      type,
      isMain: i === 0,
      temporalKind: date ? "jednorazowe" : "stan",
      date,
      keywordsPl: [kw.slice(0, 4).join(" "), kw.slice(-4).join(" ")].filter((k) => k.length > 0),
      keywordEn: s,
      lemmasPl: kw.slice(0, 6),
      entities: [...s.matchAll(/\b\p{Lu}[\p{L}-]+/gu)].map((m) => m[0]).slice(1, 5),
      sourceText: s,
      parts: [] as string[],
      assertedAspect: null,
    };
  });
}

function fakeAssess(ref: string, claim: string, fragment: string) {
  let best = "";
  let bestScore = 0;
  for (const s of splitSentences(fragment)) {
    const score = ngramContainment(claim, s);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const period = /\b((?:19|20)\d{2})\b/.exec(best)?.[1] ?? null;
  if (bestScore >= 0.55) {
    const relation = hasNegation(claim) !== hasNegation(best) ? "OBALA" : "WSPIERA";
    return { ref, relation, aspect: "sedno", period, quote: truncateWords(best, 300) };
  }
  if (bestScore >= 0.3) {
    return { ref, relation: "INNY_KONTEKST", aspect: "sedno", period, quote: truncateWords(best, 300) };
  }
  return { ref, relation: "BEZ_ZWIAZKU", aspect: "sedno", period: null, quote: "" };
}

function fakeFixedMatch(claim: string, thesis: string): "ta_sama" | "zaprzeczona" | "inna" | "niepewne" {
  const score = Math.max(ngramContainment(claim, thesis), ngramContainment(thesis, claim));
  if (score >= 0.5) return hasNegation(claim) !== hasNegation(thesis) ? "zaprzeczona" : "ta_sama";
  if (score >= 0.3) return "niepewne";
  return "inna";
}
