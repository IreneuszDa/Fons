/**
 * Test-only stand-ins for the modules behind src/engine/ports.ts (security, corpus, retrieval,
 * verdict). They implement the MODULES.md signatures with small, deterministic logic so engine
 * tests do not depend on other agents' work in progress. Not used in production code.
 */
import type {
  Claim,
  CorpusRecord,
  CorpusStore,
  DetectorHit,
  EvidenceAssessment,
  EvidenceCandidate,
  RetrievalBranch,
  RetrievalQuery,
  StrengthCard,
  Verdict,
} from "../../shared/contracts";
import { ngramContainment, splitSentences } from "../text";

// ───────────── security ─────────────

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  rawHtml?: string;
  rawText: string;
  cleanText: string;
  title?: string;
  publishedAt?: string;
  hiddenSegments: string[];
}

export class FetchBlockedError extends Error {
  constructor(public reason: "scheme" | "port" | "private_ip" | "too_large" | "redirects" | "timeout" | "content_type" | "http_error") {
    super(reason);
  }
}

export async function fetchPage(_url: string): Promise<FetchedPage> {
  throw new FetchBlockedError("http_error");
}

const INJECTION =
  /(zignoruj|ignoruj)\s+(wszystkie\s+)?(poprzednie|wcześniejsze|powyższe)\s+(instrukcje|polecenia)|ignore\s+(all\s+)?(previous|prior)\s+instructions/i;

export function detectInjection(text: string, location: DetectorHit["location"], recordId?: string, opts?: { hiddenSegments?: string[] }): DetectorHit[] {
  const out: DetectorHit[] = [];
  const all = [text, ...(opts?.hiddenSegments ?? [])].join("\n");
  for (const s of splitSentences(all.replace(/<[^>]+>/g, " "))) {
    if (INJECTION.test(s)) {
      out.push({ location, ...(recordId ? { recordId } : {}), pattern: "ignore_previous", excerpt: s.slice(0, 120), severity: "high" });
    }
  }
  return out;
}

export function stripFlaggedSentences(text: string, hits: DetectorHit[]): string {
  if (hits.length === 0) return text;
  return splitSentences(text)
    .filter((s) => !INJECTION.test(s))
    .join(" ");
}

export function maskPii(text: string): { text: string; masked: boolean; kinds: string[] } {
  const kinds: string[] = [];
  let out = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => {
    kinds.push("email");
    return "[email]";
  });
  out = out.replace(/\b\d{11}\b/g, () => {
    kinds.push("pesel");
    return "[pesel]";
  });
  out = out.replace(/(\+48\s?)?\b\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g, () => {
    kinds.push("telefon");
    return "[telefon]";
  });
  return { text: out, masked: kinds.length > 0, kinds };
}

export function resolveRelativeDates(text: string, receivedAt: Date): string {
  const y = new Date(receivedAt.getTime() - 86_400_000);
  const iso = y.toISOString().slice(0, 10);
  return text.replace(/\bwczoraj\b/gi, iso);
}

// ───────────── corpus ─────────────

export function memoryStore(records: CorpusRecord[], snapshot = "snap-test"): CorpusStore {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    get: (id) => map.get(id),
    getMany: (ids) => ids.map((id) => map.get(id)).filter((r): r is CorpusRecord => !!r),
    snapshotId: () => snapshot,
    count: () => map.size,
  };
}

export function createCorpusStore(): CorpusStore {
  throw new Error("createCorpusStore stub: use memoryStore() in tests");
}

// ───────────── retrieval ─────────────

/** Keyword branch over an in-memory corpus. */
export function memoryBranch(id: string, records: CorpusRecord[], required: boolean): RetrievalBranch {
  return {
    id,
    required,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      const queries = [q.claim.text, ...(q.extraQueries ?? [])];
      return records
        .map((r) => ({
          recordId: r.id,
          score: Math.max(...queries.map((t) => ngramContainment(t, `${r.title} ${r.text} ${r.claimReviewed ?? ""}`))),
          via: "bm25" as const,
        }))
        .filter((c) => c.score >= 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit ?? 10);
    },
  };
}

export function failingBranch(id: string, required: boolean): RetrievalBranch {
  return {
    id,
    required,
    search: async () => {
      throw new Error("down");
    },
  };
}

export function createRetrievalBranches(): RetrievalBranch[] {
  throw new Error("createRetrievalBranches stub: build branches in tests");
}

export async function warmUp(): Promise<Record<string, { available: boolean }>> {
  return {};
}

export async function retrieve(
  branches: RetrievalBranch[],
  q: RetrievalQuery,
  opts: import("../retrieval").RetrieveOptions = {},
): Promise<{ candidates: EvidenceCandidate[]; unavailable: string[]; requiredFailed: boolean }> {
  const unavailable: string[] = [];
  let requiredFailed = false;
  const best = new Map<string, EvidenceCandidate>();
  await Promise.all(
    branches.map(async (b) => {
      try {
        let status: "completed" | "partial" | "skipped" = "completed";
        const candidates = await b.search({ ...q, onCoverage: coverage => { status = coverage; } });
        opts.onBranchResult?.(b.id, status, candidates);
        for (const c of candidates) {
          const prev = best.get(c.recordId);
          if (!prev || prev.score < c.score) best.set(c.recordId, c);
        }
      } catch {
        unavailable.push(b.id);
        opts.onBranchResult?.(b.id, "unavailable", []);
        if (b.required) requiredFailed = true;
      }
    }),
  );
  if (branches.length > 0 && unavailable.length === branches.length) requiredFailed = true;
  return { candidates: [...best.values()].sort((a, b) => b.score - a.score), unavailable, requiredFailed };
}

/** Stub: no official-channel records in engine tests — the ranked list is returned unchanged. */
export function pinOfficialRecords(ranked: string[]): string[] {
  return ranked;
}

export function matchIncidentDomains(urlOrText: string, db: unknown): { incidentId: string; title: string; url: string }[] {
  const incidents = (db as { incidents?: { id: string; title: string; url: string; domain: string }[] })?.incidents ?? [];
  return incidents
    .filter((i) => urlOrText.includes(i.domain))
    .map((i) => ({ incidentId: i.id, title: i.title, url: i.url }));
}

// ───────────── verdict (simplified rules) ─────────────

export interface VerdictInput {
  claim: Claim;
  assessments: EvidenceAssessment[];
  records: Map<string, CorpusRecord>;
  now: Date;
  singleKeyVerifier: boolean;
}

export interface VerdictDecision {
  verdict: Verdict;
  ruleApplied: number;
  strength: StrengthCard;
  decisiveRecordIds: string[];
  missingContext?: string;
  conflicting?: { supporting: string[]; refuting: string[] };
  archival: boolean;
}

export function isDecisive(a: EvidenceAssessment, r: CorpusRecord): boolean {
  if (!a.quoteVerified || a.excluded) return false;
  if (r.role === "stala_rola") return a.fixedRoleMatch === "ta_sama" && r.rating?.mapped != null;
  return r.level === 1 && (a.relation === "WSPIERA" || a.relation === "OBALA");
}

function strength(singleKey: boolean, n: number): StrengthCard {
  return {
    level: n === 0 ? "slaba" : singleKey ? "srednia" : "mocna",
    primarySources: n,
    independentPublishers: n,
    newestEvidenceAt: null,
    archivalWarning: false,
    verifierAgreement: "brak",
    notes: singleKey ? ["weryfikator tej samej rodziny"] : [],
  };
}

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const { claim, assessments, records, singleKeyVerifier } = input;
  if (claim.type !== "fakt") {
    return { verdict: "NIE_PODLEGA", ruleApplied: 1, strength: strength(singleKeyVerifier, 0), decisiveRecordIds: [], archival: false };
  }
  const decisive = assessments.filter((a) => {
    const r = records.get(a.recordId);
    return r ? isDecisive(a, r) : false;
  });
  const fixed = decisive.find((a) => records.get(a.recordId)?.role === "stala_rola");
  if (fixed) {
    const mapped = records.get(fixed.recordId)!.rating!.mapped!;
    return { verdict: mapped, ruleApplied: 6, strength: strength(singleKeyVerifier, 1), decisiveRecordIds: [fixed.recordId], archival: false };
  }
  const sup = decisive.filter((a) => a.relation === "WSPIERA");
  const ref = decisive.filter((a) => a.relation === "OBALA");
  if (sup.length > 0 && ref.length > 0) {
    return {
      verdict: "BRAK_DOWODOW",
      ruleApplied: 5,
      strength: strength(singleKeyVerifier, 0),
      decisiveRecordIds: [],
      conflicting: { supporting: sup.map((a) => a.recordId), refuting: ref.map((a) => a.recordId) },
      archival: false,
    };
  }
  if (sup.length > 0) {
    return { verdict: "POTWIERDZONE", ruleApplied: 7, strength: strength(singleKeyVerifier, sup.length), decisiveRecordIds: sup.map((a) => a.recordId), archival: false };
  }
  if (ref.length > 0) {
    return { verdict: "FALSZYWE", ruleApplied: 8, strength: strength(singleKeyVerifier, ref.length), decisiveRecordIds: ref.map((a) => a.recordId), archival: false };
  }
  return { verdict: "BRAK_DOWODOW", ruleApplied: 2, strength: strength(singleKeyVerifier, 0), decisiveRecordIds: [], archival: false };
}
