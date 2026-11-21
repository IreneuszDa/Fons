/**
 * Orchestrator — PLAN §3 steps 1–9. Code is the orchestrator: no model has tools, untrusted content
 * only ever reaches models inside random fences, and the verdict is computed by the rules module.
 *
 *  1 normalize (text / URL / image) + PII masking + relative dates
 *  2 detector hits → securityEvents + warning
 *  3 claim extraction + input mode (fast tier) ∥ 4 retrieval of the raw text, then per-claim retrieval
 *    (pool of 40 per claim → lexical rerank → top 8 fragments)
 *    - long text (article, transcript): up to 6 claims ranked by importance; a claim about several subjects
 *      is checked part by part (claims.ts parts) and the verdicts are aggregated by code (verdict/compound.ts);
 *      at most MAX_CHECK_UNITS units, live search only for the first LIVE_MAX_UNITS of them (cost and time),
 *    - yes/no question → one declarative claim, normal verdict pipeline (inputMode "question_yesno"),
 *    - open question → answer.ts: verbatim quote picked by the main model, checked by code + verifier,
 *      answer text built by code from the record (inputMode "question_open", no verdict),
 *  5 evidence assessment (main tier, one call per claim, claims in parallel)
 *  6 quote check + one batched verifier call for decisive candidates
 *  7 decideVerdict (or model_proposed + code gates)
 *  8 justification from templates (optional validated smoothing)
 *  9 report assembly (EvidenceItem fields copied from CorpusRecord only)
 *
 * LLM calls per query: 1 (claims) + <= 8 (assess, one per claim or part; <= 3 for a short message)
 * + <= 1 (verifier) [+1 vision] [+1 smoothing].
 * Open question: 1 (claims) + 1 (open answer) + <= 1 (verifier).
 * Every model call goes through the model router (llm/router.ts); failed attempts and escalations are
 * recorded in report.models through a request-scoped route trace.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  LlmUnavailableError,
  VerdictReport,
  type ChannelId,
  type Claim,
  type ClaimVerdict,
  type CorpusRecord,
  type CorpusStore,
  type DetectorHit,
  type EvidenceAssessment,
  type EvidenceCandidate,
  type EvidenceItem,
  type InputKind,
  type LlmProvider,
  type ModelUsage,
  type NormalizedInput,
  type ReportWarning,
  type RetrievalBranch,
  type RetrievalQuery,
  type SourceActivity,
  type StrengthCard,
  type TechStatus,
  type Verdict,
} from "../shared/contracts";
import type { VerificationStage } from "../shared/chat";
import type { AppConfig } from "../server/config";
import {
  answerSummaryPl,
  archivalAnswerPl,
  asksAboutPresent,
  buildAnswer,
  checkOpenAnswer,
  isArchival,
  noAnswerSummaryPl,
  runOpenAnswer,
  verifyOpenAnswer,
  type OpenAnswer,
} from "./answer";
import { MAX_FRAGMENTS_PER_CLAIM, prepareEvidence, runAssessment, toAssessments, type PreparedRecord } from "./assess";
import { checkUnits, extractClaims, isLongInput, roleQueryFor, type ExtractedClaim, type OpenQuestion } from "./claims";
import { buildCompoundReasonPl, buildJustification, buildSummaryPl, smoothJustification, type DecisionLike } from "./justify";
import { aggregateCompound, type PartOutcome } from "./verdict/compound";
import { createLlmProviders } from "./llm";
import { runWithRouteTrace, type RouteTrace } from "./llm/router";
import { modelNameFor, processingRegion } from "./llm/types";
import type { InputMode } from "./prompts";
import { lexicalRerank, scoreCandidates } from "./retrieval/rerank";
import { diversifyFragments } from "./retrieval/diversity";
import { narrativeLinks } from "./retrieval/incidents";
import { currentLiveScope, liveUsageModels, runWithLiveScope } from "./retrieval/live-usage";
import {
  STATUS_PL,
  WARNING_PL,
  branchNamePl,
  branchUnavailablePl,
  incidentPl,
  nonEeaPl,
  warning,
} from "./messages";
import { normalizeInput } from "./normalize";
import {
  createCorpusStore,
  createRetrievalBranches,
  decideVerdict,
  detectInjection,
  fetchPage,
  isDecisive,
  maskPii,
  matchIncidentDomains,
  pinOfficialRecords,
  retrieve,
  stripFlaggedSentences,
  warmUp,
} from "./ports";
import { applyVote, runVerifier, type VerifierCandidate } from "./verifier";
import { hostOf } from "./text";
import type { CreateBranchesOptions } from "./retrieval";

type Database = BetterSqlite3.Database;

export const PIPELINE_VERSION = "engine-2026.11.22-11";

const PER_BRANCH_TIMEOUT_MS = 4000;
/** Live search (paid, slow) only for the first units in importance order; the rest use the corpus. */
export const LIVE_MAX_UNITS = 3;
/** The raw-text query uses live search only for a short message (for a long text it is just its beginning). */
const RAW_LIVE_MAX_CHARS = 600;
/**
 * Claim about a named person: a second, name-free query („Prezydentem Polski jest”) finds the page that says who
 * really holds the office; up to ROLE_PINNED_SLOTS primary records from it (covering ≥ ROLE_MIN_COVERAGE of its
 * terms) are always among the assessed fragments. Without it the pool fills with records about the person.
 */
const ROLE_QUERY_LIMIT = 20;
const ROLE_PINNED_SLOTS = 2;
const ROLE_MIN_COVERAGE = 0.6;
/** Parallel assessment calls (main tier) per request. */
const ASSESS_CONCURRENCY = 4;

/** Promise.allSettled with at most `limit` tasks running at once (results in input order). */
async function settledWithLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Round-robin across claims, so the verifier's item cap never leaves a later claim without a check. */
function interleaveByClaim<T extends { claim: Claim }>(xs: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const x of xs) groups.set(x.claim.id, [...(groups.get(x.claim.id) ?? []), x]);
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let i = 0; out.length < xs.length; i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}
/** Candidates from the raw-text query (added after the per-claim ones). */
const RAW_QUERY_LIMIT = 20;
/** Candidate pool per claim after fusion; the lexical rerank then keeps MAX_FRAGMENTS_PER_CLAIM. */
const CLAIM_QUERY_LIMIT = 40;

export interface VerifyRequest {
  kind: InputKind;
  text?: string;
  url?: string;
  images?: { mime: string; base64: string }[];
  channel: ChannelId;
  receivedAt: string;
  fault?: string;
  onActivity?: (stage: VerificationStage) => void;
}

export interface EngineDeps {
  llm: LlmProvider;
  verifier: LlmProvider;
  singleKey: boolean;
  store: CorpusStore;
  db: Database;
  branches: RetrievalBranch[];
  fetchPage: typeof fetchPage;
  now: () => Date;
  verdictMode: "rules" | "model_proposed";
  /** Optional, off by default: smoothing of the template justification by the fast model (validated). */
  smoothing?: boolean;
  /** Diagnostics hook (quality work, tests): receives intermediate results; never user-facing. */
  debug?: (step: string, data: unknown) => void;
}

export interface VerifyOptions {
  /** Already-normalised input (e.g. computed by the server for the cache key) — skips step 1. */
  normalized?: NormalizedInput;
  signal?: AbortSignal;
}

export function createEngineDeps(
  db: Database,
  cfg: AppConfig,
  opts: { liveOptions?: CreateBranchesOptions["liveOptions"] } = {},
): EngineDeps {
  const { main, verifier, singleKey } = createLlmProviders(cfg);
  const branches = createRetrievalBranches(db, { liveSearch: cfg.liveSearch, liveConfig: cfg, liveOptions: opts.liveOptions });
  // Start loading the embedding model / index now, so the first query does not hit the branch timeout.
  void warmUp(branches).catch(() => undefined);
  return {
    llm: main,
    verifier,
    singleKey,
    store: createCorpusStore(db),
    db,
    branches,
    fetchPage,
    now: () => new Date(),
    verdictMode: cfg.verdictMode,
    smoothing: false,
  };
}

/** Cache key: hash(normalised input) + corpus snapshot + pipeline version (+ mode/models). */
export function cacheKeyFor(req: VerifyRequest, normalized: NormalizedInput, deps: EngineDeps): string {
  let snapshot = "unknown";
  try {
    snapshot = deps.store.snapshotId();
  } catch {
    /* corpus unavailable — key still deterministic */
  }
  const imageHash =
    req.kind === "image" && req.images?.length
      ? createHash("sha256")
          .update(req.images.map((i) => `${i.mime}:${i.base64}`).join("|"))
          .digest("hex")
      : undefined;
  const payload = JSON.stringify({
    v: PIPELINE_VERSION,
    snapshot,
    kind: normalized.kind,
    text: normalized.textResolvedDates,
    url: normalized.submittedUrl ?? null,
    image: imageHash ?? null,
    mode: deps.verdictMode,
    llm: `${deps.llm.name}/${modelNameFor(deps.llm, "main")}`,
    verifier: `${deps.verifier.name}/${modelNameFor(deps.verifier, "fast")}`,
    singleKey: deps.singleKey,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ───────────────────────────── helpers ─────────────────────────────

function parseFaults(fault: string | undefined): Set<string> {
  return new Set(
    (fault ?? "")
      .split(/[,\s]+/)
      .map((f) => f.trim())
      .filter(Boolean),
  );
}

class DownProvider implements LlmProvider {
  readonly available = false;
  constructor(private readonly base: LlmProvider) {}
  get name() {
    return this.base.name;
  }
  get family() {
    return this.base.family;
  }
  async complete<T>(): Promise<never> {
    throw new LlmUnavailableError("provider_error", "fault_injected");
  }
}

function failingBranch(id: string, required: boolean): RetrievalBranch {
  return {
    id,
    required,
    search: async () => {
      throw new Error("fault_injected");
    },
  };
}

function applyBranchFaults(branches: RetrievalBranch[], faults: Set<string>): RetrievalBranch[] {
  let out = branches;
  if (faults.has("corpus_down")) {
    out = out.map((b) => (b.required ? failingBranch(b.id, true) : b));
    if (!out.some((b) => b.required)) out = [...out, failingBranch("corpus", true)];
  }
  if (faults.has("live_down")) {
    const isLive = (b: RetrievalBranch) => /live/i.test(b.id);
    out = out.some(isLive) ? out.map((b) => (isLive(b) ? failingBranch(b.id, false) : b)) : [...out, failingBranch("live", false)];
  }
  return out;
}

interface RetrievalOutcome {
  candidates: EvidenceCandidate[];
  requiredFailed: boolean;
  searched: string[];
}

type SearchStatus = SourceActivity["branches"][number]["status"];

function pseudoClaim(text: string): Claim {
  return {
    id: "c0",
    text: text.slice(0, 600),
    type: "fakt",
    isMain: true,
    temporal: { kind: "brak" },
    inputOverlap: 1,
  };
}

function llmStatusMessage(e: LlmUnavailableError): string {
  if (e.reason === "no_key") return STATUS_PL.llmNotConfigured;
  if (e.reason === "budget") return STATUS_PL.llmBudget;
  return STATUS_PL.llmDown;
}

function emptyStrength(): StrengthCard {
  return {
    level: "slaba",
    primarySources: 0,
    independentPublishers: 0,
    newestEvidenceAt: null,
    archivalWarning: false,
    verifierAgreement: "brak",
    notes: [],
  };
}

const RULE_FOR_VERDICT: Record<Verdict, number> = {
  NIE_PODLEGA: 1,
  BRAK_DOWODOW: 2,
  POTWIERDZONE: 7,
  FALSZYWE: 8,
  WPROWADZAJACE: 9,
};

/**
 * verdictMode "model_proposed": code gates on the model's proposal —
 * opinion/forecast → NIE_PODLEGA; no verified quote → BRAK_DOWODOW;
 * never POTWIERDZONE without a verified WSPIERA (and never FALSZYWE without a verified OBALA).
 */
export function gateProposedVerdict(
  claim: Claim,
  proposed: Verdict | undefined,
  assessments: EvidenceAssessment[],
): { verdict: Verdict; ruleApplied: number; gated: boolean } {
  if (claim.type !== "fakt") return { verdict: "NIE_PODLEGA", ruleApplied: 1, gated: proposed !== "NIE_PODLEGA" };
  const valid = assessments.filter((a) => a.quoteVerified && !a.excluded && a.relation !== "BEZ_ZWIAZKU");
  if (valid.length === 0 || !proposed) return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: proposed !== "BRAK_DOWODOW" };
  if (proposed === "POTWIERDZONE" && !valid.some((a) => a.relation === "WSPIERA")) {
    return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: true };
  }
  if (proposed === "FALSZYWE" && !valid.some((a) => a.relation === "OBALA")) {
    return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: true };
  }
  return { verdict: proposed, ruleApplied: RULE_FOR_VERDICT[proposed], gated: false };
}

function evidenceGroup(rel: EvidenceAssessment["relation"]): EvidenceItem["group"] {
  if (rel === "WSPIERA") return "wspierajace";
  if (rel === "OBALA") return "obalajace";
  return "kontekst";
}

/** EvidenceItem — descriptive fields copied from the CorpusRecord, never from model output. */
function toEvidenceItem(a: EvidenceAssessment, r: CorpusRecord): EvidenceItem {
  return {
    recordId: r.id,
    title: r.title,
    publisher: r.publisher,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    url: r.url,
    quote: a.quote, // verified span cut from r.text (quotes.ts) or chosen by code
    relation: a.relation,
    aspect: a.aspect,
    sourceType: r.type,
    level: r.level,
    role: r.role,
    ...(r.rating?.raw ? { ratingRaw: r.rating.raw } : {}),
    group: evidenceGroup(a.relation),
  };
}

function providerLabel(p: LlmProvider, tier: "fast" | "main"): string {
  return `${modelNameFor(p, tier)} — ${providerBrand(p.name)}`;
}

function providerBrand(name: string): string {
  return name === "anthropic" ? "Claude (Anthropic)" : name === "mistral" ? "Mistral" : name === "openai" ? "OpenAI" : name;
}

export function buildTransparencyPl(opts: {
  mode: "rules" | "model_proposed";
  main: LlmProvider;
  verifier: LlmProvider;
  singleKey: boolean;
  verifierUsed: boolean;
  status: TechStatus;
  inputMode?: InputMode;
  answered?: boolean;
}): string {
  if (opts.status !== "OK") {
    return "Nie wydaliśmy werdyktu. Kod przerwał sprawdzanie, bo zabrakło elementu koniecznego do rzetelnej oceny; żaden model nie wydał oceny zamiast niego.";
  }
  const x = providerLabel(opts.main, "main");
  const y = providerLabel(opts.verifier, "fast");
  if (opts.inputMode === "question_open") {
    if (!opts.answered) {
      return "Fons odpowiada tylko cytatem ze źródła z katalogu. Żaden fragment nie odpowiadał wprost na pytanie, dlatego nie podajemy odpowiedzi — model nie odpowiada z własnej wiedzy.";
    }
    const check = !opts.verifierUsed
      ? ""
      : opts.singleKey
        ? ` Model ${y} sprawdził, czy cytat odpowiada na pytanie — to ten sam dostawca (tryb jednego klucza).`
        : ` Model ${y} (inny dostawca) sprawdził, czy cytat odpowiada na pytanie.`;
    return (
      `Model ${x} wskazał fragment źródła, który odpowiada na pytanie. Kod sprawdził, że cytat występuje dosłownie w źródle z katalogu, ` +
      `i wstawił wydawcę, datę i link z bazy.${check} Odpowiedź nie pochodzi z wiedzy modelu. Przeczytaj źródło sam.`
    );
  }
  const code = "Kod sprawdził: obecność cytatu w źródle z katalogu, poziom źródła, daty, niezależność wydawców.";
  const verifierPart = !opts.verifierUsed
    ? "Weryfikator nie był potrzebny, bo nie było dowodu rozstrzygającego."
    : opts.singleKey
      ? `Model ${y} to sprawdził — to ten sam dostawca (tryb jednego klucza), czyli słabsza kontrola niż model innego dostawcy; karta siły dowodów uwzględnia to jako osobny czynnik.`
      : `Model ${y} (inny dostawca) to sprawdził.`;
  if (opts.mode === "model_proposed") {
    return (
      `Model ${x} zaproponował werdykt, kod sprawdził warunki: bez sprawdzonego cytatu wynik to „brak wystarczających dowodów”, ` +
      `opinie i prognozy nie podlegają weryfikacji, a potwierdzenie wymaga sprawdzonego cytatu, który wspiera twierdzenie. ` +
      `${code} ${verifierPart} Przeczytaj źródło sam.`
    );
  }
  return `${code} Model ${x} ocenił, czy cytat wspiera twierdzenie. ${verifierPart} Przeczytaj źródło sam.`;
}

// ───────────────────────────── run context ─────────────────────────────

class Run {
  readonly started = performance.now();
  readonly timings: Record<string, number> = {};
  readonly models: ModelUsage[] = [];
  readonly events: DetectorHit[] = [];
  readonly warnings: ReportWarning[] = [];
  readonly assessedRecords = new Set<string>();
  private readonly branchResults = new Map<string, { outcomes: Set<SearchStatus>; records: Set<string> }>();
  private readonly startedStages = new Set<VerificationStage>();
  echo = "";
  claims: Claim[] = [];
  verifierUsed = false;
  inputMode: InputMode = "claim";
  /** Router decisions and failed attempts of this request (filled by llm/router.ts). */
  readonly route: RouteTrace = { usages: [], decisions: [] };

  constructor(
    readonly req: VerifyRequest,
    readonly deps: EngineDeps,
  ) {}

  stage(stage: VerificationStage): void {
    if (this.startedStages.has(stage)) return;
    this.startedStages.add(stage);
    try {
      this.req.onActivity?.(stage);
    } catch {
      // Losing the progress stream must not interrupt the report.
    }
  }

  async search(branches: RetrievalBranch[], q: RetrievalQuery): Promise<RetrievalOutcome> {
    if (branches.length) this.stage("searching");
    const searched: string[] = [];
    try {
      const outcome = await retrieve(branches, q, {
        perBranchTimeoutMs: PER_BRANCH_TIMEOUT_MS,
        onBranchResult: (id, status, candidates) => {
          const result = this.branchResults.get(id) ?? { outcomes: new Set<SearchStatus>(), records: new Set<string>() };
          result.outcomes.add(status);
          if (status === "completed" || status === "partial") searched.push(id);
          for (const candidate of candidates) {
            if (candidate?.recordId && Number.isFinite(candidate.score)) result.records.add(candidate.recordId);
          }
          this.branchResults.set(id, result);
        },
      });
      return { ...outcome, searched };
    } catch {
      return { candidates: [], requiredFailed: true, searched };
    }
  }

  sourceActivity(): SourceActivity {
    const records = new Set<string>();
    const branches = Array.from(this.branchResults, ([id, result]) => {
      for (const record of result.records) records.add(record);
      const completed = result.outcomes.has("completed");
      const failed = result.outcomes.has("unavailable");
      const partial = result.outcomes.has("partial") || (completed && failed);
      const status: SearchStatus = partial ? "partial" : failed ? "unavailable" : completed ? "completed" : "skipped";
      return { id, labelPl: branchNamePl(id), status, candidateCount: result.records.size };
    });
    return { branches, candidateCount: records.size, assessedCount: this.assessedRecords.size };
  }

  unavailableSearchLabels(): string[] {
    return this.sourceActivity().branches.filter(b => b.status === "unavailable").map(b => b.labelPl);
  }

  time(step: string, t0: number): void {
    this.timings[step] = Math.round(performance.now() - t0);
  }

  warn(kind: ReportWarning["kind"], textPl: string, links?: ReportWarning["links"]): void {
    if (!this.warnings.some((w) => w.kind === kind && w.textPl === textPl)) this.warnings.push(warning(kind, textPl, links));
  }

  snapshot(): string {
    try {
      return this.deps.store.snapshotId();
    } catch {
      return "nieznana";
    }
  }

  report(fields: {
    status: TechStatus;
    statusMessagePl?: string;
    verdicts?: ClaimVerdict[];
    mainVerdict?: Verdict | null;
    summaryPl?: string;
    answer?: OpenAnswer;
  }): VerdictReport {
    this.timings.total = Math.round(performance.now() - this.started);
    // Paid live search (web_search tokens + call fees) recorded in the request scope (retrieval/live-usage.ts).
    const models = [...this.models, ...this.route.usages, ...liveUsageModels()];
    const us = models.filter((m) => processingRegionFor(m.provider, this.deps) === "us");
    const usage = us.find((m) => m.purpose === "vision") ?? us[0];
    if (usage) this.warn("non_eea_processing", nonEeaPl(providerBrand(usage.provider), usage.purpose === "vision"));
    const ok = fields.status === "OK";
    const sourceActivity = this.sourceActivity();
    const degraded = sourceActivity.branches.filter(b => b.status === "partial" || b.status === "unavailable");
    for (const b of degraded) this.warn("branch_unavailable", branchUnavailablePl(b.id, b.status === "partial"));
    const report: VerdictReport = {
      inputMode: this.inputMode,
      ...(ok && fields.answer ? { answer: fields.answer } : {}),
      id: randomUUID(),
      token: randomBytes(16).toString("base64url"),
      createdAt: this.deps.now().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
      corpusSnapshot: this.snapshot(),
      verdictMode: this.deps.verdictMode,
      status: fields.status,
      ...(fields.statusMessagePl ? { statusMessagePl: fields.statusMessagePl } : {}),
      inputKind: this.req.kind,
      inputEchoMasked: this.echo,
      claims: this.claims,
      verdicts: ok ? (fields.verdicts ?? []) : [],
      mainVerdict: ok ? (fields.mainVerdict ?? null) : null,
      summaryPl: fields.summaryPl ?? fields.statusMessagePl ?? "",
      warnings: this.warnings,
      transparencyPl: buildTransparencyPl({
        mode: this.deps.verdictMode,
        main: this.deps.llm,
        verifier: this.deps.verifier,
        singleKey: this.deps.singleKey,
        verifierUsed: this.verifierUsed,
        status: fields.status,
        inputMode: this.inputMode,
        answered: !!fields.answer,
      }),
      models,
      timingsMs: this.timings,
      costUsd: Math.round(models.reduce((s, m) => s + m.costUsd, 0) * 1_000_000) / 1_000_000,
      unavailableBranches: degraded.map(b => b.id),
      sourceActivity,
      securityEvents: dedupeEvents(this.events),
      cacheHit: false,
    };
    return VerdictReport.parse(report);
  }

  stop(status: TechStatus, messagePl: string): VerdictReport {
    return this.report({ status, statusMessagePl: messagePl, summaryPl: messagePl });
  }
}

function processingRegionFor(providerName: string, deps: EngineDeps): string {
  if (deps.llm.name === providerName) return processingRegion(deps.llm);
  if (deps.verifier.name === providerName) return processingRegion(deps.verifier);
  return providerName === "anthropic" || providerName === "openai" ? "us" : "local";
}

/** One event per (location, record, pattern, excerpt) within a request (records reused across claims). */
function dedupeEvents(events: DetectorHit[]): DetectorHit[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = `${e.location}|${e.recordId ?? ""}|${e.pattern}|${e.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function safeMask(text: string): string {
  try {
    return maskPii(text).text;
  } catch {
    return "";
  }
}

// ───────────────────────────── candidates ─────────────────────────────

/** Per-claim candidates first, then raw-text hits; deduplicated by recordId (first occurrence wins). */
function mergeCandidates(...lists: EvidenceCandidate[][]): EvidenceCandidate[] {
  const seen = new Set<string>();
  const out: EvidenceCandidate[] = [];
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.recordId)) continue;
      seen.add(c.recordId);
      out.push(c);
    }
  }
  return out;
}

/** Records by id; live snapshots of the submitted page's own host are dropped (the subject is never evidence). */
function loadRecords(store: CorpusStore, ids: string[], submittedHost: string | undefined): Map<string, CorpusRecord> | null {
  let fetched: CorpusRecord[];
  try {
    fetched = store.getMany(ids);
  } catch {
    return null;
  }
  const records = new Map<string, CorpusRecord>();
  for (const r of fetched) {
    if (r.origin === "live_snapshot" && submittedHost && hostOf(r.url) === submittedHost) continue;
    records.set(r.id, r);
  }
  return records;
}

// ───────────────────────────── open questions ─────────────────────────────

interface OpenQuestionCtx {
  question: OpenQuestion;
  rawRetrieval: Promise<RetrievalOutcome>;
  branches: RetrievalBranch[];
  llm: LlmProvider;
  verifier: LlmProvider;
  normalized: NormalizedInput;
  signal?: AbortSignal;
}

/**
 * Open question: retrieve → main model picks ONE verbatim quote (or none) → quote check in code →
 * verifier → answer built from a template with fields copied from the record. Never model knowledge.
 */
async function answerOpenQuestion(run: Run, ctx: OpenQuestionCtx): Promise<VerdictReport> {
  const { deps } = run;
  const { question, branches, llm, verifier, normalized, signal } = ctx;
  const tRet = performance.now();
  const [raw, own] = await Promise.all([
    ctx.rawRetrieval,
    run.search(branches, { claim: pseudoClaim(question.questionPl), extraQueries: question.queries, limit: CLAIM_QUERY_LIMIT, signal }),
  ]);
  run.timings.retrieval = Math.round(performance.now() - tRet);
  if (raw.requiredFailed || own.requiredFailed) return run.stop("NIEPELNE", STATUS_PL.corpusDown);

  const pool = mergeCandidates(own.candidates, raw.candidates);
  const records = loadRecords(deps.store, pool.map((c) => c.recordId), hostOf(normalized.submittedUrl));
  if (!records) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
  // Fact-check records quote the false claims they debunk — never used as an answer.
  const contentPool = pool.filter((c) => records.get(c.recordId)?.role === "tresc");
  const ranked = lexicalRerank(contentPool, records, {
    queryTexts: [question.questionPl, ...question.queries],
    mustHave: question.mustHave,
  });
  // Source first: the official channel of the institution the question is about is always among the fragments;
  // the rest is diversified (at most a few records of one source, level-1 records reserved).
  const rankedIds = diversifyFragments(
    ranked.map((c) => c.recordId),
    records,
    { max: MAX_FRAGMENTS_PER_CLAIM, pinned: pinOfficialRecords([], contentPool.map((c) => c.recordId), records) },
  );
  const prepared = prepareEvidence(
    rankedIds.map((id) => records.get(id)!),
    detectInjection,
    stripFlaggedSentences,
  );
  run.events.push(...prepared.flatMap((p) => p.hits));
  const sendable = prepared.filter((p) => !p.unusable);

  let answer: OpenAnswer | undefined;
  let answerRecord: CorpusRecord | undefined;
  let archival = false;
  const t = performance.now();
  if (sendable.length > 0) {
    run.stage("assessing");
    const { out, usage } = await runOpenAnswer(llm, question.questionPl, sendable, signal);
    for (const p of sendable) run.assessedRecords.add(p.record.id);
    run.models.push(usage);
    const chk = checkOpenAnswer(out, sendable, detectInjection);
    deps.debug?.("open_answer", { fragments: sendable.map((p) => ({ ref: p.ref, recordId: p.record.id, title: p.record.title })), out, check: chk.ok ? "ok" : chk.reason });
    if (!chk.ok && chk.events) run.events.push(...chk.events);
    if (chk.ok) {
      run.verifierUsed = true;
      let vote: "zgoda" | "sprzeciw" | "niepewne" = "niepewne";
      try {
        run.stage("checking_quotes");
        const v = await verifyOpenAnswer(verifier, question.questionPl, chk.quote, signal);
        run.models.push(v.usage);
        vote = v.vote;
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
        run.warn("branch_unavailable", WARNING_PL.verifierUnavailable);
      }
      if (vote !== "sprzeciw") {
        answer = buildAnswer(question.questionPl, chk.record, chk.quote);
        answerRecord = chk.record;
        if (asksAboutPresent(question.questionPl, question.aboutPresent) && isArchival(chk.record, deps.now())) {
          archival = true;
          run.warn("archival_material", archivalAnswerPl(chk.record));
        }
      }
    }
  }
  run.timings.answer = Math.round(performance.now() - t);
  if (run.events.some((ev) => ev.location === "evidence" || ev.location === "quote")) run.warn("injection_detected", WARNING_PL.injection);
  if (deps.singleKey && run.verifierUsed) run.warn("single_key_verifier", WARNING_PL.singleKey);

  const searchedPl = [...new Set([...raw.searched, ...own.searched].map(branchNamePl))];
  const summaryPl =
    answer && answerRecord ? answerSummaryPl(answerRecord, archival) : noAnswerSummaryPl(searchedPl, run.unavailableSearchLabels());
  return run.report({ status: "OK", verdicts: [], mainVerdict: null, summaryPl, ...(answer ? { answer } : {}) });
}

// ───────────────────────────── pipeline ─────────────────────────────

export async function verifyInput(req: VerifyRequest, deps: EngineDeps, opts: VerifyOptions = {}): Promise<VerdictReport> {
  // Own live-search cost scope when the caller (eval, scripts, tests) did not open one; the server and MCP open
  // theirs (withLiveUsage there is idempotent — the report already carries the "live_search" entries).
  if (!currentLiveScope()) return runWithLiveScope({}, () => verifyInput(req, deps, opts));
  const run = new Run(req, deps);
  try {
    return await runWithRouteTrace(run.route, () => pipeline(run, opts));
  } catch (e) {
    if (e instanceof LlmUnavailableError) return run.stop("NIEPELNE", llmStatusMessage(e));
    return run.stop("AWARIA", STATUS_PL.systemError);
  }
}

async function pipeline(run: Run, opts: VerifyOptions): Promise<VerdictReport> {
  const { req, deps } = run;
  const faults = parseFaults(req.fault);
  const llm: LlmProvider = faults.has("llm_down") ? new DownProvider(deps.llm) : deps.llm;
  const verifier: LlmProvider = faults.has("llm_down") ? new DownProvider(deps.verifier) : deps.verifier;
  const branches = applyBranchFaults(deps.branches, faults);
  const signal = opts.signal;
  const receivedAt = Number.isNaN(Date.parse(req.receivedAt)) ? deps.now() : new Date(req.receivedAt);

  run.echo = safeMask(req.kind === "url" ? (req.url ?? req.text ?? "") : req.kind === "image" ? "[obraz]" : (req.text ?? ""));

  // Scenario J: no key → NIEPELNE, never a verdict, never provider text.
  if (!deps.llm.available) return run.stop("NIEPELNE", STATUS_PL.llmNotConfigured);
  if (faults.has("llm_down")) return run.stop("NIEPELNE", STATUS_PL.llmDown);

  // ── 1. normalize ──
  let t = performance.now();
  let normalized: NormalizedInput;
  if (opts.normalized) {
    normalized = opts.normalized;
  } else {
    const n = await normalizeInput(
      { kind: req.kind, text: req.text, url: req.url, images: req.images, receivedAt: req.receivedAt },
      { fetchPage: deps.fetchPage, llm, receivedAt, ocrDown: faults.has("ocr_down"), signal },
    );
    run.models.push(...n.usage);
    run.time("normalize", t);
    if (!n.ok) {
      run.echo = n.echo || run.echo;
      run.events.push(...n.hits);
      if (n.hits.length > 0) run.warn("injection_detected", WARNING_PL.injection);
      return run.stop(n.status, n.messagePl);
    }
    normalized = n.normalized;
  }
  run.echo =
    normalized.kind === "url"
      ? [normalized.submittedUrl, normalized.pageTitle].filter(Boolean).join("\n")
      : normalized.text;

  // ── 2. detector hits ──
  run.events.push(...normalized.detectorHits);
  if (normalized.detectorHits.length > 0 || normalized.warnings.includes("injection_detected")) {
    run.warn("injection_detected", WARNING_PL.injection);
  }
  if (normalized.warnings.includes("image_limits")) run.warn("image_limits", WARNING_PL.imageLimits);

  if (!normalized.textResolvedDates.trim()) {
    return run.stop("DOPRECYZUJ", normalized.detectorHits.length > 0 ? STATUS_PL.noClaims : STATUS_PL.emptyInput);
  }

  // ── 3 ∥ 4. claims + raw-text retrieval ──
  t = performance.now();
  const noLive = branches.filter((b) => b.id !== "live");
  const rawBranches = normalized.textResolvedDates.length <= RAW_LIVE_MAX_CHARS ? branches : noLive;
  const rawRetrieval = run.search(rawBranches, {
    claim: pseudoClaim(normalized.textResolvedDates),
    limit: RAW_QUERY_LIMIT,
    signal,
  });
  let extracted: ExtractedClaim[];
  let claimLimit = Number.POSITIVE_INFINITY;
  try {
    const res = await extractClaims(llm, normalized.textResolvedDates, signal);
    run.models.push(res.usage);
    extracted = res.claims;
    claimLimit = res.claimLimit;
    // Links and images are always checked as claims (their content is the subject, not a question to us).
    run.inputMode = normalized.kind !== "text" && res.inputMode !== "claim" ? "claim" : res.inputMode;
    run.time("claims", t);
    if (run.inputMode === "question_open" && res.question) {
      return await answerOpenQuestion(run, { question: res.question, rawRetrieval, branches, llm, verifier, normalized, signal });
    }
    if (extracted.length === 0) {
      await rawRetrieval;
      run.events.push({
        location: "user_message",
        pattern: res.rejected.length > 0 ? "claim_overlap_rejected" : "no_claims_extracted",
        excerpt: normalized.text.slice(0, 120),
        severity: res.rejected.length > 0 ? "high" : "low",
      });
      return run.stop("DOPRECYZUJ", STATUS_PL.noClaims);
    }
  } catch (e) {
    await rawRetrieval;
    throw e;
  }
  run.claims = extracted.map((e) => e.claim);

  const tRet = performance.now();
  // Units checked through the pipeline: each claim, or its parts (one per subject) instead of it.
  const units = checkUnits(extracted);
  const factClaims = units.filter((e) => e.claim.type === "fakt");
  const liveUnits = new Set(factClaims.slice(0, LIVE_MAX_UNITS).map((e) => e.claim.id));
  const roleQueries = factClaims.map((e) => roleQueryFor(e.claim.text));
  const noRole: RetrievalOutcome = { candidates: [], requiredFailed: false, searched: [] };
  const [raw, ...rest] = await Promise.all([
    rawRetrieval,
    ...factClaims.map((e, i) =>
      run.search(liveUnits.has(e.claim.id) ? branches : noLive, {
        claim: e.claim,
        extraQueries: e.extraQueries,
        includeSemanticFactCheck: !roleQueries[i],
        limit: CLAIM_QUERY_LIMIT,
        signal,
      }),
    ),
    ...roleQueries.map((rq, i) =>
      rq ? run.search(noLive, { claim: { ...factClaims[i]!.claim, text: rq.query }, limit: ROLE_QUERY_LIMIT, signal }) : Promise.resolve(noRole),
    ),
  ]);
  const perClaim = rest.slice(0, factClaims.length);
  const rolePools = rest.slice(factClaims.length);
  run.timings.retrieval = Math.round(performance.now() - tRet);
  const outcomes = [raw!, ...perClaim];
  if (outcomes.some((o) => o.requiredFailed)) return run.stop("NIEPELNE", STATUS_PL.corpusDown);

  // Candidate pool per claim (per-claim ranking first, then raw-text hits) → lexical rerank.
  const submittedHost = hostOf(normalized.submittedUrl);
  const poolByClaim = new Map<string, EvidenceCandidate[]>();
  factClaims.forEach((e, i) => poolByClaim.set(e.claim.id, mergeCandidates(perClaim[i]?.candidates ?? [], raw!.candidates)));
  const allIds = [...new Set([...poolByClaim.values(), ...rolePools.map((o) => o.candidates)].flat().map((c) => c.recordId))];
  const records = loadRecords(deps.store, allIds, submittedHost);
  if (!records) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
  const recordIdsByClaim = new Map<string, string[]>();
  factClaims.forEach((e, i) => {
    const pool = (poolByClaim.get(e.claim.id) ?? []).filter((c) => records.has(c.recordId));
    const ranked = lexicalRerank(pool, records, { queryTexts: [e.claim.text, ...e.extraQueries], mustHave: e.mustHave });
    const semanticFactChecks = pool.filter((c) => c.semanticFactCheck).map((c) => c.recordId);
    // Source first: records from the official channel of the institution named in the claim are always assessed.
    const officialPinned = pinOfficialRecords([], pool.map((c) => c.recordId), records);
    // Who really holds the office: the best primary records of the name-free query come first.
    const rq = roleQueries[i];
    const rolePinned = rq
      ? scoreCandidates(
          (rolePools[i]?.candidates ?? []).filter((c) => records.get(c.recordId)?.type === "pierwotne"),
          records,
          { queryTexts: [rq.query] },
        )
          .filter((x) => x.parts.text >= ROLE_MIN_COVERAGE)
          .sort((a, b) => b.score - a.score)
          .slice(0, ROLE_PINNED_SLOTS)
          .map((x) => x.candidate.recordId)
      : [];
    // Diversity: at most FRAGMENTS_MAX_PER_SOURCE records of one source among the assessed fragments and at least
    // FRAGMENTS_LEVEL1_SLOTS level-1 records when the pool has any — fact-check records of one publisher no longer
    // crowd out the official records about the office a named politician holds (retrieval/diversity.ts).
    recordIdsByClaim.set(
      e.claim.id,
      diversifyFragments(
        ranked.map((c) => c.recordId),
        records,
        { max: MAX_FRAGMENTS_PER_CLAIM, pinned: [...rolePinned, ...officialPinned, ...semanticFactChecks] },
      ),
    );
  });

  // ── 5. evidence assessment (parallel per claim) + 6 (i–ii) quote check ──
  t = performance.now();
  const propose = deps.verdictMode === "model_proposed";
  const perClaimResults = await settledWithLimit(factClaims, ASSESS_CONCURRENCY, async (e) => {
      const recs = (recordIdsByClaim.get(e.claim.id) ?? [])
        .map((id) => records.get(id))
        .filter((r): r is CorpusRecord => !!r)
        .slice(0, MAX_FRAGMENTS_PER_CLAIM);
      const prepared: PreparedRecord[] = prepareEvidence(recs, detectInjection, stripFlaggedSentences);
      const events = prepared.flatMap((p) => p.hits);
      const sendable = prepared.filter((p) => !p.unusable);
      if (sendable.length === 0) {
        const { assessments } = toAssessments(e.claim, prepared, undefined, detectInjection);
        return { claimId: e.claim.id, assessments, events, proposed: undefined as Verdict | undefined, usage: undefined as ModelUsage | undefined };
      }
      run.stage("assessing");
      const rawA = await runAssessment(llm, e.claim, prepared, { propose, signal });
      for (const p of sendable) run.assessedRecords.add(p.record.id);
      const checked = toAssessments(e.claim, prepared, rawA.out, detectInjection);
      return {
        claimId: e.claim.id,
        assessments: checked.assessments,
        events: [...events, ...checked.events],
        proposed: rawA.proposedVerdict,
        usage: rawA.usage,
      };
  });
  run.timings.assess = Math.round(performance.now() - t);
  const assessmentsByClaim = new Map<string, EvidenceAssessment[]>();
  const proposedByClaim = new Map<string, Verdict | undefined>();
  for (const r of perClaimResults) {
    if (r.status === "rejected") throw r.reason;
    assessmentsByClaim.set(r.value.claimId, r.value.assessments);
    proposedByClaim.set(r.value.claimId, r.value.proposed);
    run.events.push(...r.value.events);
    if (r.value.usage) run.models.push(r.value.usage);
  }
  if (run.events.some((ev) => ev.location === "evidence" || ev.location === "quote")) {
    run.warn("injection_detected", WARNING_PL.injection);
  }

  // ── 6 (iii). verifier — one batched call for would-be-decisive evidence ──
  t = performance.now();
  const candidates: VerifierCandidate[] = [];
  for (const e of factClaims) {
    const all = assessmentsByClaim.get(e.claim.id) ?? [];
    for (const a of all) {
      const r = records.get(a.recordId);
      if (!r || !a.quoteVerified || a.excluded) continue;
      const relevant =
        r.role === "stala_rola"
          ? a.fixedRoleMatch === "ta_sama" || a.fixedRoleMatch === "zaprzeczona"
          : a.relation === "WSPIERA" || a.relation === "OBALA" || a.relation === "CZESCIOWO";
      if (!relevant) continue;
      let decisive = false;
      try {
        decisive = isDecisive(a, r, all, records);
      } catch {
        decisive = true;
      }
      if (decisive) candidates.push({ claim: e.claim, assessment: a, record: r });
    }
  }
  if (candidates.length > 0) {
    run.verifierUsed = true;
    try {
      run.stage("checking_quotes");
      const { votes, usage } = await runVerifier(verifier, interleaveByClaim(candidates), signal);
      run.models.push(usage);
      for (const [c, vote] of votes) {
        const list = assessmentsByClaim.get(c.claim.id) ?? [];
        const idx = list.indexOf(c.assessment);
        if (idx >= 0) list[idx] = applyVote(c.assessment, vote);
      }
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      // Verifier unavailable: evidence stays, strength lowered via "niepewne".
      for (const c of candidates) {
        const list = assessmentsByClaim.get(c.claim.id) ?? [];
        const idx = list.indexOf(c.assessment);
        if (idx >= 0) list[idx] = applyVote(c.assessment, "niepewne");
      }
      run.warn("branch_unavailable", WARNING_PL.verifierUnavailable);
    }
  }
  run.timings.verifier = Math.round(performance.now() - t);
  if (deps.singleKey) run.warn("single_key_verifier", WARNING_PL.singleKey);

  deps.debug?.("assessments", { claims: factClaims.map((e) => e.claim), byClaim: Object.fromEntries(assessmentsByClaim), extraQueries: factClaims.map((e) => e.extraQueries) });

  // ── 7. verdict per claim ──
  t = performance.now();
  const now = deps.now();
  const decisions = new Map<string, { decision: DecisionLike; strength: StrengthCard }>();
  for (const e of units) {
    const assessments = assessmentsByClaim.get(e.claim.id) ?? [];
    const d = decideVerdict({ claim: e.claim, assessments, records, now, singleKeyVerifier: deps.singleKey });
    let decision: DecisionLike = {
      verdict: d.verdict,
      ruleApplied: d.ruleApplied,
      decisiveRecordIds: d.decisiveRecordIds,
      ...(d.missingContext ? { missingContext: d.missingContext } : {}),
      ...(d.conflicting ? { conflicting: d.conflicting } : {}),
      archival: d.archival,
    };
    if (propose) {
      const g = gateProposedVerdict(e.claim, proposedByClaim.get(e.claim.id), assessments);
      decision = {
        verdict: g.verdict,
        ruleApplied: g.ruleApplied,
        decisiveRecordIds: g.verdict === "BRAK_DOWODOW" || g.verdict === "NIE_PODLEGA" ? [] : d.decisiveRecordIds,
        ...(g.verdict === "WPROWADZAJACE" && d.missingContext ? { missingContext: d.missingContext } : {}),
        ...(g.verdict === "BRAK_DOWODOW" && d.conflicting ? { conflicting: d.conflicting } : {}),
        archival: g.verdict === "WPROWADZAJACE" && d.archival,
      };
    }
    assessmentsByClaim.set(
      e.claim.id,
      assessments.map((a) => ({ ...a, decisive: decision.decisiveRecordIds.includes(a.recordId) && !a.excluded })),
    );
    decisions.set(e.claim.id, { decision, strength: d.strength ?? emptyStrength() });
    if (decision.archival) run.warn("archival_material", WARNING_PL.archival);
  }
  run.timings.verdict = Math.round(performance.now() - t);

  // ── 8. justification ──
  t = performance.now();
  const unavailablePl = run.unavailableSearchLabels();
  const searchedFor = (id: string) => {
    const i = factClaims.findIndex(e => e.claim.id === id);
    const used = [...raw!.searched, ...(perClaim[i]?.searched ?? []), ...(rolePools[i]?.searched ?? [])];
    return [...new Set(used.filter(branch => branch !== "live" || liveUnits.has(id)).map(branchNamePl))];
  };
  const justifyUnit = async (e: ExtractedClaim): Promise<ClaimVerdict> => {
    const { decision, strength } = decisions.get(e.claim.id)!;
    const assessments = assessmentsByClaim.get(e.claim.id) ?? [];
    const j = buildJustification({
      claim: e.claim,
      decision,
      assessments,
      records,
      searchedPl: searchedFor(e.claim.id),
      unavailablePl,
      verdictMode: deps.verdictMode,
    });
    let reasonPl = j.reasonPl;
    if (deps.smoothing) {
      const s = await smoothJustification(
        verifier,
        reasonPl,
        decision.verdict,
        assessments.map((a) => a.quote),
        signal,
      );
      if (s.usage) run.models.push(s.usage);
      reasonPl = s.text;
    }
    const evidence = assessments
      .filter((a) => a.quoteVerified && !a.excluded && a.relation !== "BEZ_ZWIAZKU" && records.has(a.recordId))
      .sort((x, y) => Number(y.decisive) - Number(x.decisive) || records.get(x.recordId)!.level - records.get(y.recordId)!.level)
      .slice(0, 8)
      .map((a) => toEvidenceItem(a, records.get(a.recordId)!));
    return {
      claimId: e.claim.id,
      verdict: decision.verdict,
      ruleApplied: decision.ruleApplied,
      strength,
      reasonPl,
      ...(j.missingContext ? { missingContext: j.missingContext } : {}),
      ...(decision.conflicting ? { conflicting: decision.conflicting } : {}),
      ...(j.triedPl ? { triedPl: j.triedPl } : {}),
      evidence,
    };
  };
  const verdicts: ClaimVerdict[] = [];
  for (const e of extracted) {
    if (e.parts.length === 0) {
      verdicts.push(await justifyUnit(e));
      continue;
    }
    // Claim about several subjects: each part was checked on its own; code aggregates (verdict/compound.ts).
    const partVerdicts: ClaimVerdict[] = [];
    for (const p of e.parts) partVerdicts.push(await justifyUnit(p));
    const outcomes: PartOutcome[] = e.parts.map((p, i) => ({
      claim: p.claim,
      verdict: partVerdicts[i]!.verdict,
      ruleApplied: partVerdicts[i]!.ruleApplied,
      strength: partVerdicts[i]!.strength,
      reasonPl: partVerdicts[i]!.reasonPl,
    }));
    const agg = aggregateCompound(outcomes);
    const seenRecords = new Set<string>();
    // Round-robin over parts (each part's best evidence first), one item per record.
    const evidence: ClaimVerdict["evidence"] = [];
    for (let i = 0; i < 8 && evidence.length < 8; i++) {
      for (const v of partVerdicts) {
        const ev = v.evidence[i];
        if (ev && !seenRecords.has(ev.recordId) && evidence.length < 8) {
          seenRecords.add(ev.recordId);
          evidence.push(ev);
        }
      }
    }
    const unclear = partVerdicts.find((v) => v.verdict === "BRAK_DOWODOW");
    verdicts.push({
      claimId: e.claim.id,
      verdict: agg.verdict,
      ruleApplied: agg.ruleApplied,
      strength: agg.strength,
      reasonPl: buildCompoundReasonPl(agg.verdict, outcomes),
      ...(agg.verdict === "BRAK_DOWODOW" && unclear?.triedPl ? { triedPl: unclear.triedPl } : {}),
      ...(agg.verdict === "BRAK_DOWODOW" && unclear?.conflicting ? { conflicting: unclear.conflicting } : {}),
      evidence,
    });
  }
  run.timings.justify = Math.round(performance.now() - t);

  // ── 9. report assembly ──
  const caseLinks = narrativeLinks(assessmentsByClaim, records);
  if (caseLinks.length > 0) {
    run.warn(
      "incident_narrative",
      "EUvsDisinfo opisało wcześniej podobne twierdzenie. Ustalenie pochodzenia sprawdzanej wiadomości wymaga osobnych dowodów.",
      caseLinks,
    );
  }
  try {
    const target = normalized.submittedUrl ?? (/(https?:\/\/|www\.)\S+/i.test(normalized.text) ? normalized.text : undefined);
    if (target) {
      const incidents = matchIncidentDomains(target, deps.db);
      if (incidents.length > 0) run.warn("incident_domain", incidentPl(incidents.map((i) => i.title)));
    }
  } catch {
    /* warning only — never blocks the report */
  }
  const mainClaim = extracted.find((e) => e.claim.isMain) ?? extracted[0]!;
  const mainVerdict = verdicts.find((v) => v.claimId === mainClaim.claim.id);
  let summaryPl = buildSummaryPl(mainVerdict, verdicts.length - 1, {
    allVerdicts: verdicts.map((v) => v.verdict),
    selectedFromLong: isLongInput(normalized.textResolvedDates) && extracted.length >= claimLimit,
  });
  if (run.inputMode === "question_yesno") summaryPl = `Sprawdziliśmy pytanie jako twierdzenie: „${mainClaim.claim.text.trim().replace(/[.!?…]+$/, "")}”. ${summaryPl}`;
  if (normalized.warnings.includes("truncated")) summaryPl += ` ${WARNING_PL.truncated}`;
  return run.report({ status: "OK", verdicts, mainVerdict: mainVerdict?.verdict ?? null, summaryPl });
}
