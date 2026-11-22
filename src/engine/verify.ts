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
import { relativeWindowDay } from "../security/dates";
import { passageAssessment, prioritizeConflictEvidence } from "../shared/evidence";
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
  type VideoAnalysis,
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
import { MAX_CLAIMS_LONG, asksAboutStandingFact, checkUnits, coversSubjects, extractClaims, isLongInput, needsPolarityCheck, roleQueryFor, type ExtractedClaim, type OpenQuestion } from "./claims";
import { opposingReports } from "./verdict/conflict";
import { isSingleDateClaim, quoteCorrectsSlot } from "./verdict/slots";
import { rateSeriesIds } from "./retrieval/rate-series";
import { isProfileField, officeHistoryIds, primarySubjectIds, registeredCountryName, subjectAliases } from "./retrieval/subject";
import { requestedEventDay, statedDays } from "./event-day";
import { buildCompoundReasonPl, buildJustification, buildSummaryPl, smoothJustification, type DecisionLike } from "./justify";
import { aggregateCompound, type PartOutcome } from "./verdict/compound";
import { createLlmProviders } from "./llm";
import { runWithRouteTrace, type RouteTrace } from "./llm/router";
import { modelNameFor, processingRegion } from "./llm/types";
import { lexicalRerank, scoreCandidates } from "./retrieval/rerank";
import { diversifyFragments } from "./retrieval/diversity";
import { narrativeLinks } from "./retrieval/incidents";
import { publicationAddress } from "../shared/publication-url";
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
import { normalizeInput, userNoteBesideUrl, type NormalizeOutcome } from "./normalize";
import { socialVideoPlatform } from "./video/platforms";
import { findPublicationReport, publicationQuestionPart, reportPublication } from "./publication-report";
import { answerSourceQuestion } from "./source-question";
import { archivedDocumentIdentity, asksForIdentity, compareReviewedAppearance, compareReviewedDocument, documentUrl, linkedPublicationRecords, screenshotClaim, withScreenshotReading } from "./attachment-answer";
import { asksWhatArticleReports, readArticleAccount, routeArticleRequest } from "./article-intent";
import { MAX_QUESTION_PARTS, separateQuestions } from "./question-parts";
import { reviewedMediaRecords } from "./attachment-answer";
import { findLocalTransportRecords, localTransportQuestion, unresolvedQuestion } from "./local-transport";
import { accessionComparison, accessionComparisonReport } from "./accession-comparison";
import { natoOfficeReport } from "./nato-office";
import { sejmClubReport } from "./sejm-club";
import { benefitComparisonReport } from "./benefit-comparison";
import { membershipReport, parseMembership } from "./membership";
import { createDemagogTopicIndex, type DemagogTopicIndex } from "./retrieval/demagog-topic";
import { anchorSubtitleClaims, asksForTranscript, hasOnlyText, readVideo, type VideoServices } from "./video/intake";
import { recordingFileLabel } from "../shared/attachments";
import { createVideoServices } from "./video/services";
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
  resolveRelativeDates,
  stripFlaggedSentences,
  warmUp,
} from "./ports";
import { applyVote, runVerifier, type VerifierCandidate } from "./verifier";
import { hostOf } from "./text";
import { explicitPublicationCutoff, publicationAvailable } from "./publication-window";
import type { CreateBranchesOptions } from "./retrieval";

type Database = BetterSqlite3.Database;

export const PIPELINE_VERSION = "engine-2026.11.22-36";

const PER_BRANCH_TIMEOUT_MS = 4000;
/** Live search (paid, slow) only for the first units in importance order; the rest use the corpus. */
export const LIVE_MAX_UNITS = 3;
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
  recording?: { mime: string; base64: string };
  channel: ChannelId;
  receivedAt: string;
  fault?: string;
  onActivity?: (stage: VerificationStage) => void;
}

export interface EngineDeps {
  pipelineVersion?: string;
  llm: LlmProvider;
  verifier: LlmProvider;
  singleKey: boolean;
  store: CorpusStore;
  db: Database;
  branches: RetrievalBranch[];
  fetchPage: typeof fetchPage;
  demagogTopicIndex?: DemagogTopicIndex;
  video?: VideoServices;
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
  articleRead?: NormalizeOutcome;
  signal?: AbortSignal;
}

export function createEngineDeps(
  db: Database,
  cfg: AppConfig,
  opts: {
    liveOptions?: CreateBranchesOptions["liveOptions"];
    extensions?: Pick<import("../server/extensions").FonsExtensions, "models" | "branches" | "version">;
  } = {},
): EngineDeps {
  const custom = opts.extensions?.models;
  const { main, verifier, singleKey } = custom
    ? { main: custom.main, verifier: custom.verifier ?? custom.main, singleKey: !custom.verifier || custom.verifier.family === custom.main.family }
    : createLlmProviders(cfg);
  const branches = createRetrievalBranches(db, { liveSearch: cfg.liveSearch, liveConfig: cfg, liveOptions: opts.liveOptions });
  for (const branch of opts.extensions?.branches ?? []) {
    if (!branch.id || branches.some(b => b.id === branch.id)) throw new Error(`Nieprawidłowy lub powtórzony identyfikator wyszukiwarki: ${branch.id}`);
    branches.push(branch);
  }
  // Start loading the embedding model / index now, so the first query does not hit the branch timeout.
  void warmUp(branches).catch(() => undefined);
  return {
    llm: main,
    pipelineVersion: opts.extensions ? `${PIPELINE_VERSION}/${opts.extensions.version}` : PIPELINE_VERSION,
    verifier,
    singleKey,
    store: createCorpusStore(db),
    db,
    branches,
    fetchPage,
    demagogTopicIndex: createDemagogTopicIndex(cfg.factCheckApiKey),
    video: createVideoServices(cfg),
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
    v: deps.pipelineVersion ?? PIPELINE_VERSION,
    snapshot,
    kind: normalized.kind,
    text: normalized.textResolvedDates,
    relativeDay: relativeWindowDay(req.text ?? "", new Date(req.receivedAt)),
    url: normalized.submittedUrl ?? null,
    image: imageHash ?? null,
    ...(req.recording && { recording: createHash("sha256").update(req.recording.base64, "base64").digest("hex") }),
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
  const valid = assessments.filter((a) => a.quoteVerified && !a.excluded && a.verifier !== "sprzeciw" && a.relation !== "BEZ_ZWIAZKU");
  if (valid.length === 0 || !proposed) return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: proposed !== "BRAK_DOWODOW" };
  if (proposed === "POTWIERDZONE" && !valid.some((a) => a.relation === "WSPIERA")) {
    return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: true };
  }
  if (proposed === "FALSZYWE" && !valid.some((a) => a.relation === "OBALA")) {
    return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: true };
  }
  if (proposed === "WPROWADZAJACE" && !valid.some(a => a.relation === "OBALA" || (a.relation === "INNY_KONTEKST" && a.verifier === "zgoda" && !a.fixedRoleMatch)
    || (a.relation === "CZESCIOWO" && (a.fixedRoleMatch === "ta_sama" || (a.partialMeaning === "correction" && a.verifier === "zgoda"))))) {
    return { verdict: "BRAK_DOWODOW", ruleApplied: 2, gated: true };
  }
  return { verdict: proposed, ruleApplied: RULE_FOR_VERDICT[proposed], gated: false };
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
    lang: r.lang,
    ...passageAssessment(r, a.quote, a.relation),
    ...(a.partialMeaning && { partialMeaning: a.partialMeaning }),
    aspect: a.aspect,
    sourceType: r.type,
    level: r.level,
    role: r.role,
    ...(r.rating?.raw ? { ratingRaw: r.rating.raw } : {}),
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
  verifierUnavailable?: boolean;
  status: TechStatus;
  inputMode?: VerdictReport["inputMode"];
  answered?: boolean;
}): string {
  if (opts.status !== "OK") {
    return "Nie wydaliśmy werdyktu. Kod przerwał sprawdzanie, bo zabrakło elementu koniecznego do rzetelnej oceny; żaden model nie wydał oceny zamiast niego.";
  }
  const x = providerLabel(opts.main, "main");
  const y = providerLabel(opts.verifier, "fast");
  if (opts.inputMode === "question_open") {
    if (!opts.answered) {
      return opts.verifierUnavailable
        ? "Usługa drugiego odczytu cytatu była niedostępna. Wstrzymaliśmy odpowiedź."
        : opts.verifierUsed
          ? "Drugi odczyt nie potwierdził, że cytat wystarcza do odpowiedzi na pytanie."
          : "Żaden ze sprawdzonych fragmentów nie zawierał bezpośredniej odpowiedzi na pytanie.";
    }
    const check = !opts.verifierUsed
      ? ""
      : opts.singleKey
        ? ` Model ${y} sprawdził, czy cytat odpowiada na pytanie — to ten sam dostawca (tryb jednego klucza).`
        : ` Model ${y} (inny dostawca) sprawdził, czy cytat odpowiada na pytanie.`;
    return (
      `Model ${x} wskazał fragment odpowiadający na pytanie. Kod porównał go z zapisanym rekordem i dołączył wydawcę, datę i adres publikacji.${check}`
    );
  }
  const code = "Kod sprawdził zgodność fragmentów z rekordami w katalogu, rodzaj źródła, daty i pochodzenie publikacji.";
  const verifierPart = opts.verifierUnavailable
    ? "Drugi model był niedostępny. Karta siły uwzględnia brak tej kontroli."
    : !opts.verifierUsed
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
  article?: VerdictReport["article"];
  videoAnalysis?: VideoAnalysis;
  verifierUsed = false;
  verifierUnavailable = false;
  inputMode: VerdictReport["inputMode"] = "claim";
  /** Router decisions and failed attempts of this request (filled by llm/router.ts). */
  readonly route: RouteTrace = { usages: [], decisions: [] };

  readonly faults: Set<string>;

  constructor(
    readonly req: VerifyRequest,
    readonly deps: EngineDeps,
  ) {
    this.faults = parseFaults(req.fault);
  }

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
      const outcome = await retrieve(branches, { ...q, asOf: this.req.receivedAt }, {
        perBranchTimeoutMs: PER_BRANCH_TIMEOUT_MS,
        onBranchResult: (id, status, candidates) => {
          if (status === "completed" || status === "partial") searched.push(id);
          this.recordLookup(id, status, candidates.filter(c => c?.recordId && Number.isFinite(c.score)).map(c => c.recordId));
        },
      });
      return { ...outcome, searched };
    } catch {
      return { candidates: [], requiredFailed: true, searched };
    }
  }

  recordLookup(id: string, status: SearchStatus, ids: string[]): void {
    const result = this.branchResults.get(id) ?? { outcomes: new Set<SearchStatus>(), records: new Set<string>() };
    result.outcomes.add(status);
    for (const recordId of ids) result.records.add(recordId);
    this.branchResults.set(id, result);
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
    verdictMode?: VerdictReport["verdictMode"];
    statusMessagePl?: string;
    verdicts?: ClaimVerdict[];
    mainVerdict?: Verdict | null;
    summaryPl?: string;
    answer?: OpenAnswer;
    questionParts?: VerdictReport["questionParts"];
    transparencyPl?: string;
  }): VerdictReport {
    this.timings.total = Math.round(performance.now() - this.started);
    // Paid live search (web_search tokens + call fees) recorded in the request scope (retrieval/live-usage.ts).
    const models = [...this.models, ...this.route.usages, ...liveUsageModels()];
    const processingWarning = modelProcessingWarning(models, this.deps);
    if (processingWarning) this.warn(processingWarning.kind, processingWarning.textPl);
    const ok = fields.status === "OK";
    const verdictMode = fields.verdictMode ?? this.deps.verdictMode;
    const sourceActivity = this.sourceActivity();
    const degraded = sourceActivity.branches.filter(b => b.status === "partial" || b.status === "unavailable");
    for (const b of degraded) {
      if (b.id === "live" && currentLiveScope()?.dailySearchLimitReached) {
        this.warn("daily_search_limit", "Dzienny limit wyszukiwania w sieci zablokował dalsze zapytania. Raport uwzględnia dostępne źródła.");
      } else {
        this.warn("branch_unavailable", branchUnavailablePl(b.id, b.status === "partial"));
      }
    }
    const report: VerdictReport = {
      inputMode: this.inputMode,
      ...(ok && fields.answer ? { answer: fields.answer } : {}),
      ...(fields.questionParts && { questionParts: fields.questionParts }),
      id: randomUUID(),
      token: randomBytes(16).toString("base64url"),
      createdAt: this.deps.now().toISOString(),
      pipelineVersion: this.deps.pipelineVersion ?? PIPELINE_VERSION,
      corpusSnapshot: this.snapshot(),
      verdictMode,
      status: fields.status,
      ...(fields.statusMessagePl ? { statusMessagePl: fields.statusMessagePl } : {}),
      inputKind: this.req.kind,
      ...(this.article && { article: this.article }),
      ...(this.videoAnalysis && { videoAnalysis: this.videoAnalysis }),
      inputEchoMasked: this.echo,
      claims: this.claims,
      verdicts: ok ? (fields.verdicts ?? []) : [],
      mainVerdict: ok ? (fields.mainVerdict ?? null) : null,
      summaryPl: fields.summaryPl ?? fields.statusMessagePl ?? "",
      warnings: this.warnings,
      transparencyPl: fields.transparencyPl ?? (videoTransparencyPl(this.videoAnalysis) + buildTransparencyPl({
        mode: verdictMode,
        main: this.deps.llm,
        verifier: this.deps.verifier,
        singleKey: this.deps.singleKey,
        verifierUsed: this.verifierUsed,
        verifierUnavailable: this.verifierUnavailable,
        status: fields.status,
        inputMode: this.inputMode,
        answered: !!fields.answer,
      })),
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

export type PublicationRun = Pick<Run, "req" | "deps" | "faults" | "inputMode" | "claims" | "models" | "stage" | "recordLookup" | "report">;

function videoWithoutClaims(video: VideoAnalysis): string {
  const frame = video.observations[0];
  const description = frame ? `Kadr z ${frame.seconds} s: ${frame.text}\n\n` : "";
  return description + "W nagraniu nie znalazłem twierdzenia do sprawdzenia. Jeśli chcesz zweryfikować konkretną wypowiedź, wskaż jej fragment.";
}

function videoTransparencyPl(analysis?: VideoAnalysis): string {
  if (!analysis || analysis.status === "unavailable") return "";
  if (analysis.status === "caption_only") return "Podstawą sprawdzenia był wyłącznie publiczny opis posta. Platforma nie udostępniła obrazu ani dźwięku. ";
  if (analysis.status === "subtitles_only") return "Podstawą sprawdzenia były publiczne napisy i dostępny opis posta. ";
  if (analysis.status === "transcript_only") return analysis.platform === "upload_audio"
    ? "Podstawą sprawdzenia była transkrypcja przesłanego dźwięku. "
    : "Podstawą sprawdzenia była transkrypcja dźwięku wykonana przez OpenAI i dostępny opis posta. ";
  if (analysis.provider === "openai") {
    if (!analysis.transcript.length) return "OpenAI odczytał wybrane klatki filmu. ";
    return "OpenAI odczytał wybrane klatki filmu. " + (analysis.transcriptSource === "platform"
      ? "Cytaty z napisów mają czas podany przez platformę. " : "Czasy wypowiedzi wskazują początek analizowanego fragmentu dźwięku. ");
  }
  return "Google Gemini przeanalizował nagranie. Znaczniki czasu wskazują pochodzenie twierdzeń w materiale. ";
}

export function modelProcessingWarning(models: ModelUsage[], deps: EngineDeps): ReportWarning | undefined {
  const us = models.filter(m => {
    if ((m.purpose === "video_analysis" || m.purpose === "video_transcription") && deps.video && "processingRegion" in deps.video
        && deps.video.provider === m.provider && deps.video.processingRegion) return deps.video.processingRegion === "us";
    return processingRegionFor(m.provider, deps) === "us";
  });
  const media = us.filter(m => m.purpose === "video_analysis" || m.purpose === "video_transcription");
  if (media.length) {
    const frames = media.some(m => m.purpose === "video_analysis");
    const audio = media.some(m => m.purpose === "video_transcription");
    const subject = frames && audio ? "Klatki filmu i dźwięk" : frames ? "Klatki filmu" : "Dźwięk nagrania";
    return { kind: "non_eea_processing", textPl: `${subject} przetworzono w USA przez ${providerBrand(media[0]!.provider)}, poza Europejskim Obszarem Gospodarczym.` };
  }
  const image = us.find(m => m.purpose === "vision" || m.purpose === "image_question");
  const usage = image ?? us[0];
  return usage ? { kind: "non_eea_processing", textPl: nonEeaPl(providerBrand(usage.provider), !!image) } : undefined;
}

function processingRegionFor(providerName: string, deps: EngineDeps): string {
  if (deps.llm.name === providerName) return processingRegion(deps.llm);
  if (deps.verifier.name === providerName) return processingRegion(deps.verifier);
  if (providerName === "gemini") return "unspecified";
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

/** A corpus copy of the submitted article is no more independent than the live page. */
function independentOfSubject(record: CorpusRecord, urls: (string | undefined)[]): boolean {
  const key = documentUrl(record.url);
  return !urls.some(url => url && ((key && documentUrl(url) === key)
    || (record.origin === "live_snapshot" && hostOf(record.url) === hostOf(url))));
}

function questionWithAdditionalSource(note?: string): string | undefined {
  return note && /^(.*\?)\s*(?:sprawdź|sprawdz|zobacz)\s+(?:również|też|dodatkowo|tez|rowniez)(?!\p{L})[^?!.]*[:.]?$/isu.exec(note)?.[1]?.trim();
}

function loadRecords(store: CorpusStore, ids: string[], ...subjectUrls: (string | undefined)[]): Map<string, CorpusRecord> | null {
  let fetched: CorpusRecord[];
  try {
    fetched = store.getMany(ids);
  } catch {
    return null;
  }
  const records = new Map<string, CorpusRecord>();
  for (const r of fetched) {
    if (!independentOfSubject(r, subjectUrls)) continue;
    records.set(r.id, r);
  }
  return records;
}

function questionRecords(store: CorpusStore, candidates: EvidenceCandidate[], query: string, now: Date, ...subjectUrls: (string | undefined)[]): CorpusRecord[] | null {
  const indexed = loadRecords(store, candidates.map(c => c.recordId), ...subjectUrls);
  if (!indexed) return null;
  const cutoff = explicitPublicationCutoff(query);
  const ranked = lexicalRerank(candidates.filter(c => publicationAvailable(indexed.get(c.recordId), now, cutoff)), indexed, { queryTexts: [query] });
  const ids = diversifyFragments(ranked.map(c => c.recordId), indexed, { max: 12, fixedRole: 5 });
  return linkedPublicationRecords(ids.map(id => indexed.get(id)!), store)
    .filter(record => publicationAvailable(record, now, cutoff) && independentOfSubject(record, subjectUrls));
}

type QuestionPart = NonNullable<VerdictReport["questionParts"]>[number];

async function answerQuestionParts(run: Run, questions: string[], normalized: NormalizedInput, branches: RetrievalBranch[],
  llm: LlmProvider, verifier: LlmProvider, receivedAt: Date, signal?: AbortSignal): Promise<VerdictReport> {
  run.inputMode = "question_open";
  const parts: QuestionPart[] = [];
  const context = normalized.userNote ?? normalized.textResolvedDates;
  const material = [context, normalized.attachmentText?.slice(0, 3000)].filter(Boolean).join("\n\n");
  for (const questionPl of questions.slice(0, MAX_QUESTION_PARTS)) {
    try {
      if (normalized.kind === "url" && normalized.attachmentText && asksWhatArticleReports(questionPl)) {
        run.stage("assessing");
        const account = await readArticleAccount(normalized, llm, verifier, signal);
        run.models.push(...account.usage);
        if (account.answerPl) run.verifierUsed = true;
        parts.push({ questionPl, status: account.answerPl ? "answered" : "insufficient", evidence: [],
          answerPl: account.answerPl ?? "Nie udało się potwierdzić streszczenia dosłownym cytatem z podanego artykułu." });
        continue;
      }
      if (normalized.kind === "text") {
        const indexed = await publicationQuestionPart(run, questionPl, signal);
        if (indexed) { parts.push(indexed); continue; }
      }
      const query = { claim: pseudoClaim(questionPl), extraQueries: [context.slice(0, 400)], limit: CLAIM_QUERY_LIMIT, signal };
      const search = await run.search(branches, query);
      const records = search.requiredFailed ? null : questionRecords(run.deps.store, search.candidates, questionPl, receivedAt, normalized.submittedUrl, run.req.url);
      if (!records || !llm.available) {
        parts.push({ questionPl, status: "unavailable", evidence: [], answerPl: records ? STATUS_PL.llmNotConfigured : STATUS_PL.corpusDown });
        continue;
      }
      run.stage("assessing");
      const synthesis = await answerSourceQuestion({ question: questionPl, subject: material, records, llm, verifier, receivedAt, signal });
      run.models.push(...synthesis.usage);
      run.events.push(...synthesis.events);
      for (const r of records.slice(0, 12)) run.assessedRecords.add(r.id);
      if (synthesis.events.length) run.warn("injection_detected", WARNING_PL.injection);
      if (synthesis.publication) {
        run.stage("checking_quotes");
        run.verifierUsed = true;
        parts.push({ questionPl, status: "answered", answerPl: synthesis.publication.answerPl, evidence: synthesis.publication.evidence });
      } else {
        const needed = synthesis.neededEvidencePl ? ` Potrzebne źródło: ${synthesis.neededEvidencePl}.` : "";
        parts.push({ questionPl, status: "insufficient", answerPl: "Dostępne źródła nie rozstrzygają tego pytania." + needed, evidence: [] });
      }
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error;
      parts.push({ questionPl, status: "unavailable", answerPl: llmStatusMessage(error), evidence: [] });
    }
  }
  if (questions.length > parts.length) run.warn("source_status", `W tej odpowiedzi sprawdzono pierwsze ${parts.length} z ${questions.length} pytań. Pozostałe możesz przesłać osobno.`);
  if (run.verifierUsed && run.deps.singleKey) run.warn("single_key_verifier", WARNING_PL.singleKey);
  const summaryPl = parts.map(p => p.questionPl + "\n" + p.answerPl).join("\n\n");
  const status = parts.every(p => p.status === "unavailable") ? "NIEPELNE" : "OK";
  return run.report({ status, summaryPl, questionParts: parts, ...(status !== "OK" && { statusMessagePl: summaryPl }),
    transparencyPl: "Pytania rozpatrzono osobno. Przy każdym wątku widać odpowiedź opartą na sprawdzonych cytatach lub powód, dla którego nie można jej podać." });
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
  const records = loadRecords(deps.store, pool.map((c) => c.recordId), normalized.submittedUrl, run.req.url);
  if (!records) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
  // Fact-check records quote the false claims they debunk — never used as an answer.
  const cutoff = explicitPublicationCutoff(question.questionPl);
  const contentPool = pool.filter((c) => records.get(c.recordId)?.role === "tresc" && publicationAvailable(records.get(c.recordId), new Date(run.req.receivedAt), cutoff));
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
      let vote: "zgoda" | "sprzeciw" | "niepewne" = "niepewne";
      try {
        run.stage("checking_quotes");
        const v = await verifyOpenAnswer(verifier, question.questionPl, chk.quote, chk.translationPl, signal);
        run.verifierUsed = true;
        run.models.push(v.usage);
        vote = v.vote;
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
        run.verifierUnavailable = true;
        run.warn("branch_unavailable", WARNING_PL.verifierUnavailable);
      }
      if (vote === "zgoda") {
        answer = buildAnswer(question.questionPl, chk.record, chk.quote, chk.translationPl);
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
  const faults = run.faults;
  const llm: LlmProvider = faults.has("llm_down") ? new DownProvider(deps.llm) : deps.llm;
  const verifier: LlmProvider = faults.has("llm_down") ? new DownProvider(deps.verifier) : deps.verifier;
  const branches = applyBranchFaults(deps.branches, faults);
  const signal = opts.signal;
  const receivedAt = Number.isNaN(Date.parse(req.receivedAt)) ? deps.now() : new Date(req.receivedAt);

  run.echo = safeMask(req.kind === "url" ? (req.url ?? req.text ?? "") : req.kind === "image" ? "[obraz]" : (req.text ?? ""));

  const url = req.kind === "url" ? (req.url ?? req.text ?? "").trim() : "";
  if (url && !faults.has("corpus_down") && deps.store.catalogPage) {
    try {
      const address = publicationAddress(url);
      if (address && new URL(address).origin + "/" !== address) {
        const records = deps.store.catalogPage(address);
        run.recordLookup("catalog_url", "completed", records.map(r => r.id));
        const entry = records.find(r => r.url === address && !detectInjection(r.title, "evidence", r.id).length);
        if (entry) run.warn("source_status", "Adres wskazuje publikację zapisaną w korpusie Fonsa. Zgodność adresu pozwala zidentyfikować materiał. Prawdziwość twierdzeń wymaga sprawdzenia jego treści.", [{ title: entry.title, url: entry.url }]);
      }
    } catch { /* an invalid URL or unavailable index cannot establish a match */ }
  }
  // Match only addresses supplied by the sender, never URLs found inside a fetched document.
  // Keep this outside retrieval and verdict computation, including for unreadable materials.
  const inputForNotice = url || (req.kind === "text" ? req.text : undefined);
  if (inputForNotice?.includes(".") && !faults.has("corpus_down")) {
    try {
      const links = matchIncidentDomains(inputForNotice, deps.db).slice(0, 3).map(({ title, url }) => ({ title, url }));
      if (links.length) run.warn("incident_domain", incidentPl(links.map(link => link.title)), links);
    } catch { /* optional catalogue */ }
  }
  const upload = req.kind === "recording" ? req.recording : undefined;
  if (req.kind === "recording" && !upload) return run.stop("NIEPELNE", "Dodaj nagranie ponownie.");
  const platform = upload ? (upload.mime.startsWith("audio/") ? "upload_audio" : "upload_video") : url && socialVideoPlatform(url);
  let videoClaims: ExtractedClaim[] | undefined;
  let subtitleFocus: string | undefined;
  let normalized = opts.normalized;
  if (url && !faults.has("corpus_down")) {
    const note = userNoteBesideUrl(req, url);
    if (asksForIdentity(note) && !detectInjection(note, "user_message").length) {
      const citedPost = await compareReviewedAppearance(note, url, deps.store, deps.fetchPage, signal);
      if (citedPost) return reportPublication(run, citedPost, safeMask(note), { basisPl: "Porównano dokładny adres wpisu z polem itemReviewed.appearance opublikowanym przez fact-checkera dla tej samej tezy oraz z metadanymi cytowanego dokumentu." });
    }
  }
  const answerMediaQuestion = async (mediaUrl: string, note: string) => {
    if (faults.has("corpus_down") || !llm.available || detectInjection(note, "user_message").length) return;
    const records = reviewedMediaRecords(mediaUrl, deps.store);
    if (!records.length) return;
    run.stage("searching");
    run.recordLookup("publications", "completed", records.map(r => r.id));
    const question = safeMask(note) || "Czego dotyczy ten materiał i co ustalono w jego weryfikacji?";
    run.stage("assessing");
    const result = await answerSourceQuestion({ question, records, llm, verifier, receivedAt, signal,
      subject: "Adres materiału jest przypisany do publikacji „" + records[0]!.title + "” w bibliografii źródeł." });
    run.models.push(...result.usage);
    run.events.push(...result.events);
    for (const record of records) run.assessedRecords.add(record.id);
    if (result.events.length) run.warn("injection_detected", WARNING_PL.injection);
    if (!result.publication) return;
    run.verifierUsed = true;
    run.stage("checking_quotes");
    if (deps.singleKey) run.warn("single_key_verifier", WARNING_PL.singleKey);
    return reportPublication(run, result.publication, question, { origin: "retrieval",
      basisPl: "Adres materiału powiązano z publikacją źródłową. Odpowiedź i jej cytaty przeszły osobne sprawdzenie." });
  };
  if (platform && url) {
    const reviewed = await answerMediaQuestion(url, userNoteBesideUrl(req, url));
    if (reviewed) return reviewed;
  }
  if (platform) {
    const started = performance.now();
    const video = await readVideo(url, platform, upload ? req.text ?? "" : userNoteBesideUrl(req, url), deps.video, stage => run.stage(stage), signal, upload);
    run.time("video", started);
    run.echo = upload ? (platform === "upload_audio" ? "[nagranie audio]" : "[przesłany film]") : safeMask(video.url);
    run.events.push(...video.hits);
    if (video.hits.length) run.warn("injection_detected", WARNING_PL.injection);
    run.models.push(...video.usages);
    // A share link has no stable post ID until the platform's guarded redirect resolves.
    // The reviewed post can be identified even if full media access is unavailable.
    if (video.url !== url && socialVideoPlatform(video.url) === platform && !faults.has("corpus_down")
        && !video.hits.some(hit => hit.location === "user_message")) {
      const focus = video.focus ?? "";
      const reviewed = await answerMediaQuestion(video.url, focus);
      if (reviewed) return reviewed;
    }
    run.videoAnalysis = video.analysis;
    if (video.analysis.status === "caption_only") run.warn("source_status", "Sprawdzam wyłącznie twierdzenia z publicznego opisu posta. Platforma nie udostępniła obrazu ani dźwięku. Aby sprawdzić samo nagranie, możesz przesłać plik w czacie.");
    if (video.message) return run.stop("NIEPELNE", video.message);
    if (video.analysis.status === "metadata_only" && video.analysis.file) {
      return run.report({ status: "OK", summaryPl: recordingFileLabel(video.analysis.file),
        transparencyPl: "FFprobe odczytał parametry strumieni i czas trwania przesłanego pliku lokalnie. Te dane techniczne nie ustalają daty ani miejsca nagrania." });
    }
    if (platform === "upload_audio" && video.analysis.transcript.length && asksForTranscript(video.focus ?? "")
        && !video.hits.some(hit => hit.location === "user_message")) {
      run.inputMode = "transcription";
      return run.report({ status: "OK", summaryPl: video.analysis.transcript.map(row => row.text).join(" "),
        transparencyPl: "Automatycznie rozpoznano mowę w przesłanym pliku. Transkrypcja może zawierać błędy odczytu." });
    }
    const question = video.focus && /\?|^(?:czy|kto|co|kiedy|ile|gdzie|dlaczego|skąd|porównaj|wyjaśnij)\s/iu.test(video.focus)
      && !video.hits.some(hit => hit.location === "user_message") ? video.focus : undefined;
    const observed = [video.analysis.title, video.analysis.caption,
      ...video.analysis.observations.map(row => row.text), ...video.analysis.transcript.map(row => row.text)].filter(Boolean).join("\n");
    let text: string;
    if (hasOnlyText(video.analysis)) {
      subtitleFocus = video.focus ?? "";
      text = [video.analysis.transcript.map(cue => cue.text).join(" "), video.analysis.caption].filter(Boolean).join("\n");
    } else {
      videoClaims = video.claims;
      run.claims = videoClaims.map(c => c.claim);
      if (!videoClaims.length && !(question && observed)) {
        return run.stop("DOPRECYZUJ", videoWithoutClaims(video.analysis));
      }
      text = videoClaims.map(c => c.claim.text).join("\n") || observed;
    }
    // A repost can be archival. Dates spoken in the clip are never resolved against submission time.
    normalized = {
      kind: upload ? "recording" : "url", text, textResolvedDates: text, ...(!upload && { submittedUrl: run.echo }),
      ...(question && { userNote: question, attachmentText: observed || text }),
      receivedAt: receivedAt.toISOString(), piiMasked: true, detectorHits: [], warnings: [],
    };
  }

  if (faults.has("llm_down")) return run.stop("NIEPELNE", STATUS_PL.llmDown);

  // ── 1. normalize ──
  let t = performance.now();
  if (!normalized) {
    const n = opts.articleRead ?? await normalizeInput(
      { kind: req.kind, text: req.text, url: req.url, images: req.images, receivedAt: req.receivedAt },
      { fetchPage: deps.fetchPage, llm, receivedAt, ocrDown: faults.has("ocr_down"), signal },
    );
    run.models.push(...n.usage);
    run.time("normalize", t);
    if (!n.ok) {
      run.echo = n.echo || run.echo;
      run.events.push(...n.hits);
      if (n.hits.length > 0) run.warn("injection_detected", WARNING_PL.injection);
      const note = url && userNoteBesideUrl(req, url);
      if (url && note && !n.hits.length && !faults.has("corpus_down") && n.messagePl !== STATUS_PL.pageBlocked && !detectInjection(note, "user_message").length) {
        const identity = archivedDocumentIdentity(note, url, deps.store);
        if (identity) {
          run.warn("source_status", n.messagePl);
          return reportPublication(run, identity, safeMask(note), { basisPl: "Zestawiono adres z archiwalnymi metadanymi dokumentu i odnośnikiem z recenzji." });
        }
      }
      const independent = questionWithAdditionalSource(note || undefined);
      if (!independent || detectInjection(independent, "user_message").length) return run.stop(n.status, n.messagePl);
      const question = await normalizeInput({ kind: "text", text: independent, receivedAt: req.receivedAt }, { fetchPage: deps.fetchPage, llm, receivedAt, ocrDown: false, signal });
      if (!question.ok) return run.stop(n.status, n.messagePl);
      normalized = question.normalized;
      run.warn("source_status", "Dodatkowej strony nie udało się odczytać. Pozostałe źródła wyszukano na podstawie pytania.");
    } else normalized = n.normalized;
  }
  if (normalized.kind === "url" && !platform && normalized.submittedUrl && normalized.attachmentText?.trim()) {
    run.article = { url: normalized.submittedUrl, ...(normalized.pageTitle && { title: normalized.pageTitle }),
      ...(normalized.pagePublishedAt && { publishedAt: normalized.pagePublishedAt }),
      ...(normalized.pageDisplayedDate && { displayedDate: normalized.pageDisplayedDate }) };
  }
  if (!upload) run.echo =
    normalized.kind === "url"
      ? [normalized.userNote, normalized.submittedUrl, normalized.pageTitle].filter(Boolean).join("\n")
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

  if (faults.has("corpus_down")) {
    for (const branch of branches.filter(b => b.required)) run.recordLookup(branch.id, "unavailable", []);
    return run.stop("NIEPELNE", STATUS_PL.corpusDown);
  }
  if (normalized.kind === "text" && !normalized.detectorHits.length && !upload && !platform) {
    const natoOffice = natoOfficeReport(run, normalized.text);
    if (natoOffice) return natoOffice;
    const club = sejmClubReport(run, normalized.text);
    if (club) return club;
    const benefits = await benefitComparisonReport(run, normalized.text, llm, verifier, receivedAt, signal);
    if (benefits) return benefits;
    const membership = parseMembership(normalized.text);
    if (membership) {
      const report = membershipReport(run, membership);
      if (report) return report;
    }
    const comparison = accessionComparison(normalized.text);
    if (comparison) {
      const report = accessionComparisonReport(run, comparison);
      if (report) return report;
    }
  }
  const additionalQuestion = normalized.kind === "url" ? questionWithAdditionalSource(normalized.userNote) : undefined;
  const note = additionalQuestion ?? (normalized.kind === "text" ? normalized.textResolvedDates : normalized.userNote);
  const questionClauses = separateQuestions(note);
  const explicitArticleQuestion = !!note && (asksForIdentity(note) || asksWhatArticleReports(note) || questionClauses.some(asksWhatArticleReports));
  const articleRoute = normalized.kind === "url" && !run.videoAnalysis && !additionalQuestion && !explicitArticleQuestion
    ? await routeArticleRequest(normalized.userNote, llm, signal) : undefined;
  if (articleRoute?.usage) run.models.push(articleRoute.usage);
  const articleReview = articleRoute?.review ?? false;
  const senderClaim = articleRoute?.claim && resolveRelativeDates(articleRoute.claim, receivedAt);
  const questions = articleReview ? [] : questionClauses;
  if (!run.videoAnalysis && questions.length && !normalized.detectorHits.some(hit => hit.location === "user_message")) {
    return answerQuestionParts(run, questions, normalized, branches, llm, verifier, receivedAt, signal);
  }
  if (!run.videoAnalysis && normalized.kind === "url" && normalized.userNote && asksWhatArticleReports(normalized.userNote)) {
    return answerQuestionParts(run, [normalized.userNote], normalized, branches, llm, verifier, receivedAt, signal);
  }
  if (!platform) {
    const published = await findPublicationReport(run, normalized, receivedAt, signal);
    if (published) return published;
  }

  const local = normalized.kind === "text" ? localTransportQuestion(normalized.text) : undefined;
  let localOutcome: RetrievalOutcome | undefined;
  if (local) {
    run.inputMode = "question_yesno";
    run.claims = [local.claim];
    const result = await run.search(branches, { claim: local.claim, extraQueries: local.searchTerms, limit: CLAIM_QUERY_LIMIT, signal });
    if (result.requiredFailed) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
    try {
      const ids = [...new Set([...findLocalTransportRecords(deps.db, local), ...result.candidates.map(c => c.recordId)])];
      const records = deps.store.getMany(ids).filter(r => local.mayAddress(r));
      const candidates = records.map(r => ({ recordId: r.id, via: "bm25" as const, score: 1 }));
      run.recordLookup("local_transport", "completed", candidates.map(c => c.recordId));
      localOutcome = { ...result, candidates };
    } catch {
      return run.stop("NIEPELNE", STATUS_PL.corpusDown);
    }
  }

  // ── 3 ∥ 4. claims + raw-text retrieval ──
  t = performance.now();
  const noLive = branches.filter((b) => b.id !== "live");
  const question = normalized.kind !== "text" ? (articleReview || senderClaim ? undefined : additionalQuestion ?? normalized.userNote) :
    !platform && normalized.text.length <= 1400 && /\?|^(?:czy|kto|kiedy|ile|gdzie|dlaczego|porównaj|wyjaśnij)\s/iu.test(normalized.text) ? normalized.text : undefined;
  const subject = additionalQuestion ? undefined : normalized.kind === "image" ? screenshotClaim(normalized) : normalized.attachmentText;
  const queryText = senderClaim ?? additionalQuestion ?? (question
    ? [question, normalized.pageTitle, subject?.slice(0, 420)].filter(Boolean).join(" ")
    : normalized.textResolvedDates);
  const polarFact = question && !local && normalized.kind === "text" && asksAboutStandingFact(question);
  if (!question && !deps.llm.available) return run.stop("NIEPELNE", STATUS_PL.llmNotConfigured);
  // Fact statements get online lookup once their checkable units are known. An opinion needs none.
  const rawRetrieval = localOutcome ? Promise.resolve(localOutcome) : run.search(question && !polarFact ? branches : noLive, {
    claim: pseudoClaim(queryText),
    limit: RAW_QUERY_LIMIT,
    signal,
  });
  let neededEvidencePl = local?.neededEvidencePl;
  if (question && !polarFact && !normalized.detectorHits.some(hit => hit.location === "user_message")) {
    const search = await rawRetrieval;
    if (search.requiredFailed) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
    const records = questionRecords(deps.store, search.candidates, queryText, receivedAt, normalized.submittedUrl, run.req.url);
    if (!records) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
    if (additionalQuestion && normalized.submittedUrl) {
      const url = documentUrl(normalized.submittedUrl);
      const suggested = deps.store.getMany([...new Set(search.candidates.map(c => c.recordId))])
        .filter(r => r.origin === "corpus" && url && documentUrl(r.url) === url && publicationAvailable(r, receivedAt, explicitPublicationCutoff(queryText)));
      records.unshift(...suggested);
    }
    const comparison = !platform && normalized.kind === "url" && compareReviewedDocument(normalized, records, deps.store);
    if (comparison) return reportPublication(run, comparison, question, { origin: "retrieval", basisPl: "Porównano cechy materiału z dokumentem wskazanym w wyszukanej publikacji." });
    if (llm.available) {
      run.stage("assessing");
      const synthesis = await answerSourceQuestion({ question, subject, records, llm, verifier, receivedAt, signal });
      run.models.push(...synthesis.usage);
      run.events.push(...synthesis.events);
      for (const record of records.slice(0, 12)) run.assessedRecords.add(record.id);
      if (synthesis.events.length) run.warn("injection_detected", WARNING_PL.injection);
      if (synthesis.publication) {
        run.stage("checking_quotes");
        run.verifierUsed = true;
        if (run.videoAnalysis) run.videoAnalysis = { ...run.videoAnalysis, claimOrigins: [] };
        const answer = normalized.kind === "image" ? withScreenshotReading(normalized, synthesis.publication) : synthesis.publication;
        if (deps.singleKey) run.warn("single_key_verifier", WARNING_PL.singleKey);
        return reportPublication(run, answer, question, { origin: "retrieval", verdictMode: "rules",
          basisPl: "Odpowiedź opracowano z wyszukanych źródeł. Kod sprawdził cytaty, a drugie wywołanie modelu oceniło, czy uzasadniają odpowiedź." });
      }
      neededEvidencePl ??= synthesis.neededEvidencePl;
    }
    if (!records.length && (local || neededEvidencePl)) {
      const claim = local?.claim ?? pseudoClaim(question);
      run.claims = [claim];
      run.inputMode = /^czy\s/iu.test(question) ? "question_yesno" : "question_open";
      return run.report({ status: "OK", verdictMode: "rules",
        ...unresolvedQuestion(claim, run.sourceActivity().branches.map(b => b.labelPl), neededEvidencePl),
        transparencyPl: "Przeszukano dostępne źródła pod kątem informacji, której dotyczy pytanie." });
    }
  }
  if (!deps.llm.available) return run.stop("NIEPELNE", STATUS_PL.llmNotConfigured);
  let extracted: ExtractedClaim[];
  let claimLimit = Number.POSITIVE_INFINITY;
  try {
    const res = local
      ? { claims: [{ claim: local.claim, extraQueries: local.searchTerms, mustHave: [local.place], parts: [] }], inputMode: "question_yesno" as const,
          claimLimit: 1, rejected: [], usage: undefined, question: undefined }
      : videoClaims
      ? { claims: videoClaims, inputMode: "claim" as const, claimLimit: MAX_CLAIMS_LONG, rejected: [], usage: undefined, question: undefined }
      : await extractClaims(llm, senderClaim || (articleReview && normalized.attachmentText) || normalized.textResolvedDates, signal, subtitleFocus, articleReview,
        normalized.pagePublishedAt ?? normalized.pageDisplayedDate, normalized.userNote);
    if (res.usage) run.models.push(res.usage);
    extracted = run.videoAnalysis && hasOnlyText(run.videoAnalysis) ? anchorSubtitleClaims(res.claims, run.videoAnalysis) : res.claims;
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
      return run.stop("DOPRECYZUJ", run.videoAnalysis?.status === "analyzed" ? videoWithoutClaims(run.videoAnalysis) : STATUS_PL.noClaims);
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
  const semanticBranch = noLive.filter(b => b.id === "vector");
  const [raw, ...rest] = await Promise.all([
    rawRetrieval,
    ...factClaims.map((e, i) =>
      localOutcome ? Promise.resolve(localOutcome) : run.search(liveUnits.has(e.claim.id) ? branches : noLive, {
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
    ...factClaims.map((e, i) =>
      !localOutcome && semanticBranch.length && !roleQueries[i] && e.claim.temporal.kind === "stan" && !e.claim.temporal.asOf
        ? run.search(semanticBranch, { claim: e.claim, recentPrimaryOnly: true, limit: 2, signal }) : Promise.resolve(noRole),
    ),
  ]);
  const perClaim = rest.slice(0, factClaims.length);
  const rolePools = rest.slice(factClaims.length, 2 * factClaims.length);
  const recentPools = rest.slice(2 * factClaims.length);
  run.timings.retrieval = Math.round(performance.now() - tRet);
  const outcomes = [raw!, ...perClaim];
  if (outcomes.some((o) => o.requiredFailed)) return run.stop("NIEPELNE", STATUS_PL.corpusDown);

  // Candidate pool per claim (per-claim ranking first, then raw-text hits) → lexical rerank.
  const poolByClaim = new Map<string, EvidenceCandidate[]>();
  factClaims.forEach((e, i) => poolByClaim.set(e.claim.id, mergeCandidates(perClaim[i]?.candidates ?? [], raw!.candidates)));
  const subjectPools = factClaims.map(e => {
    const day = requestedEventDay(e.claim);
    const countries = day ? e.mustHave.map(term => term.split("|")[0]!.trim()).filter(registeredCountryName) : [];
    const subject = e.requiredSubjects?.length === 1 ? e.requiredSubjects[0]
      : countries.length === 1 ? subjectAliases(countries[0]!) : undefined;
    if (!subject || typeof deps.db.prepare !== "function") return [];
    try {
      const neutral = primarySubjectIds(deps.db, subject);
      const ids = day ? [...new Set([...neutral, ...primarySubjectIds(deps.db, subject, day.slice(0, 4))])] : neutral;
      run.recordLookup("subject_profiles", "completed", ids);
      return ids.map(recordId => ({ recordId, score: 1, via: "bm25" as const }));
    } catch {
      run.recordLookup("subject_profiles", "unavailable", []);
      return [];
    }
  });
  const ratePools = factClaims.map(e => {
    try {
      const ids = rateSeriesIds(deps.db, e.claim);
      if (ids) run.recordLookup("official_rate_series", "completed", ids);
      return ids ?? [];
    } catch {
      run.recordLookup("official_rate_series", "unavailable", []);
      return [];
    }
  });
  const officeHistory = roleQueries.map(query => {
    if (!query || typeof deps.db.prepare !== "function") return [];
    try {
      const ids = officeHistoryIds(deps.db, query.names);
      run.recordLookup("office_history", "completed", ids);
      return ids;
    } catch {
      run.recordLookup("office_history", "unavailable", []);
      return [];
    }
  });
  const allIds = [...new Set([
    ...[...poolByClaim.values(), ...subjectPools, ...[...rolePools, ...recentPools].map(o => o.candidates)].flat().map(c => c.recordId),
    ...ratePools.flat(), ...officeHistory.flat(),
  ])];
  const records = loadRecords(deps.store, allIds, normalized.submittedUrl, run.req.url);
  if (!records) return run.stop("NIEPELNE", STATUS_PL.corpusDown);
  // A citizen can cite an official table in support of their own claim. Its pre-qualified records may
  // contradict them. Reviewing an article itself continues to require evidence from elsewhere.
  let citedRecords: CorpusRecord[] = [];
  if (senderClaim && normalized.submittedUrl && !normalized.detectorHits.length) {
    try {
      citedRecords = (deps.store.catalogPage?.(normalized.submittedUrl) ?? [])
        .filter(r => r.origin === "corpus" && r.type === "pierwotne" && r.role === "tresc" && r.level === 1);
      for (const record of citedRecords) records.set(record.id, record);
      run.recordLookup("cited_catalog_page", "completed", citedRecords.map(r => r.id));
    } catch {
      return run.stop("NIEPELNE", STATUS_PL.corpusDown);
    }
  }
  const recordIdsByClaim = new Map<string, string[]>();
  factClaims.forEach((e, i) => {
    const available = (id: string) => publicationAvailable(records.get(id), receivedAt, e.claim.temporal.publishedBy);
    const pool = (poolByClaim.get(e.claim.id) ?? []).filter((c) => available(c.recordId));
    // catalogPage returns chunks in identifier order, with no retrieval score. Treating that
    // position as relevance can outweigh every lexical hit in the actual cited passage.
    const cited = lexicalRerank(citedRecords.map(r => ({ recordId: r.id, via: "bm25" as const, score: 1 })), records,
      { queryTexts: [e.claim.text, ...e.extraQueries], mustHave: e.mustHave, weights: { rank: 0 }, limit: 2 }).map(c => c.recordId);
    const ranked = lexicalRerank(pool, records, { queryTexts: [e.claim.text, ...e.extraQueries], mustHave: e.mustHave });
    const semanticFactChecks = pool.filter((c) => c.semanticFactCheck).map((c) => c.recordId);
    // Source first: records from the official channel of the institution named in the claim are always assessed.
    const officialPinned = pinOfficialRecords([], pool.map((c) => c.recordId), records);
    const day = requestedEventDay(e.claim);
    const subjectCandidates = subjectPools[i]!.filter(c => available(c.recordId));
    const subjectPinned = lexicalRerank(subjectCandidates, records, {
      queryTexts: [e.claim.text, ...e.extraQueries].map(q => q.replace(/\d+/gu, "")),
      weights: { rank: 0.05 }, limit: 3,
    }).map(c => c.recordId);
    const dated = day ? lexicalRerank([...subjectCandidates, ...pool].filter(c => {
      const r = records.get(c.recordId);
      return r?.type === "pierwotne" && r.level === 1 && r.role === "tresc" && statedDays(r.text).includes(day);
    }), records, { queryTexts: [e.claim.text, ...e.extraQueries], mustHave: e.mustHave, limit: 2 }).map(c => c.recordId) : [];
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
        [...new Set([...ranked.map((c) => c.recordId), ...subjectPinned])].filter(available),
        records,
        { max: MAX_FRAGMENTS_PER_CLAIM, pinned: [...cited, ...ratePools[i]!, ...officeHistory[i]!, ...rolePinned, ...dated, ...subjectPinned, ...officialPinned, ...(recentPools[i]?.candidates ?? []).map(c => c.recordId), ...semanticFactChecks].filter(available) },
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
      if (e.requiredSubjects?.length) {
        const subjects = e.requiredSubjects;
        checked.assessments = checked.assessments.map(a => {
          if (!a.quoteVerified || a.excluded || a.relation === "BEZ_ZWIAZKU") return a;
          const record = records.get(a.recordId);
          const passage = record?.role === "stala_rola" ? record.claimReviewed ?? a.quote : a.quote;
          const scope = record && isProfileField(record, passage) ? record.title + "\n" + passage : passage;
          if (!coversSubjects(scope, subjects)) return { ...a, excluded: "subject_out_of_scope" };
          if (a.relation === "WSPIERA" && isSingleDateClaim(e.claim.text) && quoteCorrectsSlot(e.claim.text, passage, "czas")) {
            return { ...a, excluded: "different_year" };
          }
          return a;
        });
      }
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
    const comparedIds = new Set(opposingReports(e.claim, all, records, true).flatMap(pair => [pair.supporting, pair.refuting]));
    for (const a of all) {
      const r = records.get(a.recordId);
      if (!r || !a.quoteVerified || a.excluded) continue;
      const relevant =
        r.role === "stala_rola"
          ? a.fixedRoleMatch === "ta_sama" || a.fixedRoleMatch === "zaprzeczona"
          : a.relation !== "BEZ_ZWIAZKU";
      if (!relevant) continue;
      let decisive = false;
      try {
        decisive = isDecisive(a, r, all, records, true);
      } catch {
        decisive = true;
      }
      if (decisive || comparedIds.has(a.recordId)) candidates.push({ claim: e.claim, assessment: a, record: r });
    }
  }
  if (candidates.length > 0) {
    try {
      run.stage("checking_quotes");
      const { votes, usage } = await runVerifier(verifier, interleaveByClaim(candidates), signal, receivedAt);
      run.verifierUsed = true;
      run.models.push(usage);
      for (const [c, vote] of votes) {
        const list = assessmentsByClaim.get(c.claim.id) ?? [];
        const idx = list.indexOf(c.assessment);
        if (idx >= 0) list[idx] = applyVote(c.assessment, vote);
      }
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      run.verifierUnavailable = true;
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
  const checkPolarity = run.inputMode === "question_yesno" && needsPolarityCheck(normalized.textResolvedDates);
  if (checkPolarity && run.verifierUnavailable) {
    return run.stop("NIEPELNE", "Nie udało się sprawdzić, czy cytat odpowiada na pytanie z przeczeniem. Spróbuj ponownie za chwilę.");
  }
  if (deps.singleKey && run.verifierUsed) run.warn("single_key_verifier", WARNING_PL.singleKey);

  deps.debug?.("assessments", { claims: factClaims.map((e) => e.claim), byClaim: Object.fromEntries(assessmentsByClaim), extraQueries: factClaims.map((e) => e.extraQueries) });

  // ── 7. verdict per claim ──
  t = performance.now();
  const now = deps.now();
  const decisions = new Map<string, { decision: DecisionLike; strength: StrengthCard }>();
  for (const e of units) {
    let assessments = assessmentsByClaim.get(e.claim.id) ?? [];
    if (checkPolarity) {
      assessments = assessments.map(a => a.quoteVerified && !a.excluded && a.verifier !== "zgoda"
        ? { ...a, excluded: "unconfirmed_polarity" } : a);
    }
    const d = decideVerdict({ claim: e.claim, assessments, records, now, singleKeyVerifier: deps.singleKey });
    let strength = d.strength ?? emptyStrength();
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
      // A model may abstain. A categorical proposal still needs the actual period, source
      // independence and correction checks of the deterministic verdict.
      if (!g.gated && g.verdict === "BRAK_DOWODOW" && d.verdict !== "BRAK_DOWODOW") {
        decision = { verdict: "BRAK_DOWODOW", ruleApplied: 2, decisiveRecordIds: [], archival: false };
        strength = { ...emptyStrength(), score: null, factors: [], notes: ["Ocena materiałów pozostawiła wątpliwości co do tego twierdzenia."] };
      }
    }
    assessmentsByClaim.set(
      e.claim.id,
      assessments.map((a) => d.priorEventRecordIds?.includes(a.recordId)
        ? { ...a, relation: "CZESCIOWO", partialMeaning: "coverage", decisive: false }
        : { ...a, decisive: decision.decisiveRecordIds.includes(a.recordId) && !a.excluded }),
    );
    decisions.set(e.claim.id, { decision, strength });
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
    const ranked = assessments
      .filter((a) => a.quoteVerified && !a.excluded && a.relation !== "BEZ_ZWIAZKU" && records.has(a.recordId))
      .sort((x, y) => Number(y.decisive) - Number(x.decisive) || records.get(x.recordId)!.level - records.get(y.recordId)!.level);
    const evidence = prioritizeConflictEvidence(ranked, decision.conflicting)
      .slice(0, 8)
      .map(a => ({ ...toEvidenceItem(a, records.get(a.recordId)!), usedForVerdict: decision.decisiveRecordIds.includes(a.recordId) }));
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
    const unclear = partVerdicts.find(v => v.verdict === "BRAK_DOWODOW" && v.conflicting)
      ?? partVerdicts.find(v => v.verdict === "BRAK_DOWODOW");
    for (let i = 0; i < 8; i++) {
      for (const v of partVerdicts) {
        const ev = v.evidence[i];
        if (ev && !seenRecords.has(ev.recordId)) {
          seenRecords.add(ev.recordId);
          evidence.push(ev);
        }
      }
    }
    const conflict = agg.verdict === "BRAK_DOWODOW" ? unclear?.conflicting : undefined;
    verdicts.push({
      claimId: e.claim.id,
      verdict: agg.verdict,
      ruleApplied: conflict ? 5 : agg.ruleApplied,
      parts: partVerdicts.map((part, i) => ({
        text: e.parts[i]!.claim.text, verdict: part.verdict, ruleApplied: part.ruleApplied,
        reasonPl: part.reasonPl, evidence: part.evidence,
      })),
      strength: agg.strength,
      reasonPl: buildCompoundReasonPl(agg.verdict, outcomes),
      ...(agg.verdict === "BRAK_DOWODOW" && unclear?.triedPl ? { triedPl: unclear.triedPl } : {}),
      ...(conflict ? { conflicting: conflict } : {}),
      evidence: prioritizeConflictEvidence(evidence, conflict).slice(0, 8),
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
  const mainClaim = extracted.find((e) => e.claim.isMain) ?? extracted[0]!;
  const mainVerdict = verdicts.find((v) => v.claimId === mainClaim.claim.id);
  let summaryPl = buildSummaryPl(mainVerdict, verdicts.length - 1, {
    allVerdicts: verdicts.map((v) => v.verdict),
    selectedFromLong: isLongInput(normalized.textResolvedDates) && extracted.length >= claimLimit,
  });
  if (run.inputMode === "question_yesno" && mainVerdict) {
    const lead = mainVerdict.verdict === "POTWIERDZONE" ? "Tak. " : mainVerdict.verdict === "FALSZYWE" ? "Nie. " : "";
    if (neededEvidencePl && mainVerdict.verdict === "BRAK_DOWODOW" && !mainVerdict.conflicting) {
      mainVerdict.missingContext ??= neededEvidencePl;
      summaryPl = unresolvedQuestion(mainClaim.claim, [], neededEvidencePl).summaryPl;
    } else {
      summaryPl = lead + mainVerdict.reasonPl;
    }
  }
  if (normalized.warnings.includes("truncated")) summaryPl += ` ${WARNING_PL.truncated}`;
  return run.report({ status: "OK", verdicts, mainVerdict: mainVerdict?.verdict ?? null, summaryPl });
}
