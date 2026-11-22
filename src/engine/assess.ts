/**
 * Step 5 — evidence assessment (main tier): ONE call per claim with up to 8 fenced fragments.
 * Step 6 (part i–ii) — quote check of the model's output against the stored record text.
 *
 * Before sending, the detector runs on every record; flagged sentences are stripped from what the
 * model sees. A quote that only exists in the stripped (flagged) part → excluded "detector_hit".
 * Records with role "stala_rola" are asked ONLY for fixedRoleMatch; their verdict comes from
 * rating.mapped in the rules module, and their quote is chosen by code from the record.
 */
import type {
  Claim,
  CorpusRecord,
  DetectorHit,
  EvidenceAssessment,
  FixedRoleMatch,
  LlmProvider,
  ModelUsage,
  Verdict,
} from "../shared/contracts";
import { publicationLinks } from "../corpus/publication-links";
import { asksForElectionWinner, electionResultStage } from "./election-result";
import { preciseDateAssessment, requestedEventDay } from "./event-day";
import { fixedRoleRelation, reviewExplanation } from "./reviewed-verdict";
import { onlyAnnouncesFutureAction } from "./verdict/periods";

import { fence } from "./llm/fence";
import { ASSESS_PROPOSAL_ADDENDUM, ASSESS_SYSTEM, AssessOut, AssessProposalOut } from "./prompts";
import { QUOTE_MAX_CHARS, findQuote, type QuoteMatch } from "./quotes";
import { formatDatePl, truncateWords } from "./text";

export { fixedRoleRelation, isCompoundClaim } from "./reviewed-verdict";

export const MAX_FRAGMENTS_PER_CLAIM = 8;
const FRAGMENT_MAX_CHARS = 1800;

export type DetectFn = (text: string, location: DetectorHit["location"], recordId?: string) => DetectorHit[];
export type StripFn = (text: string, hits: DetectorHit[]) => string;

export interface PreparedRecord {
  ref: string;
  record: CorpusRecord;
  /** Record text with flagged sentences removed (what the model sees). */
  safeText: string;
  safeClaimReviewed?: string;
  hits: DetectorHit[];
  /** Nothing usable left after stripping flagged content. */
  unusable: boolean;
}

/** Body text can be cleaned. A flagged publisher, title or rated claim makes attribution unreliable. */
export function prepareEvidence(records: CorpusRecord[], detect: DetectFn, strip: StripFn): PreparedRecord[] {
  return records.slice(0, MAX_FRAGMENTS_PER_CLAIM).map((record, i) => {
    const metadata = [record.title, record.publisher, record.publishedAt, record.period, record.rating?.raw, ...record.topics];
    const metaHits = detect(metadata.filter(Boolean).join("\n"), "evidence", record.id);
    const textHits = detect(record.text, "evidence", record.id);
    const crHits = record.claimReviewed ? detect(record.claimReviewed, "evidence", record.id) : [];
    const safeText = textHits.length > 0 ? strip(record.text, textHits) : record.text;
    const safeClaimReviewed =
      record.claimReviewed && crHits.length > 0 ? strip(record.claimReviewed, crHits) : record.claimReviewed;
    const unusable = metaHits.length > 0 || crHits.length > 0 || (textHits.length > 0 && safeText.trim().length < 15);
    return { ref: `F${i + 1}`, record, safeText, safeClaimReviewed, hits: [...metaHits, ...textHits, ...crHits], unusable };
  });
}

export function buildAssessPrompt(claim: Claim, prepared: PreparedRecord[]): string {
  const parts: string[] = [];
  parts.push("Twierdzenie do oceny:");
  parts.push(fence("TWIERDZENIE", claim.text).text);
  const content = prepared.filter((p) => !p.unusable && p.record.role === "tresc");
  const fixed = prepared.filter((p) => !p.unusable && p.record.role === "stala_rola");
  if (content.length > 0) {
    parts.push("\nFragmenty źródeł (lista 'content'):");
    for (const p of content) {
      parts.push(
        `[${p.ref}] typ źródła: ${p.record.type}; data publikacji: ${formatDatePl(p.record.publishedAt)}` +
          (p.record.period ? `; okres danych: ${p.record.period}` : ""),
      );
      parts.push(fence(`FRAGMENT_${p.ref}`, `${p.record.title}\n\n${truncateWords(p.safeText, FRAGMENT_MAX_CHARS)}`).text);
    }
  } else {
    parts.push("\nLista 'content' ma być pusta.");
  }
  if (fixed.length > 0) {
    parts.push("\nTezy sprawdzone przez fact-checkerów (lista 'fixedRole'):");
    for (const p of fixed) {
      parts.push(`[${p.ref}] data publikacji: ${formatDatePl(p.record.publishedAt)}`);
      parts.push(fence(`TEZA_${p.ref}`, p.safeClaimReviewed ?? truncateWords(p.safeText, 400)).text);
      const explanation = reviewExplanation(p.record, p.safeText, p.safeClaimReviewed);
      if (explanation) parts.push(fence(`UZASADNIENIE_${p.ref}`, explanation).text);
    }
  } else {
    parts.push("\nLista 'fixedRole' ma być pusta.");
  }
  return parts.join("\n");
}

export interface RawAssessment {
  out: AssessOut;
  proposedVerdict?: Verdict;
  usage: ModelUsage;
}

export async function runAssessment(
  llm: LlmProvider,
  claim: Claim,
  prepared: PreparedRecord[],
  opts: { propose: boolean; signal?: AbortSignal },
): Promise<RawAssessment> {
  const user = buildAssessPrompt(claim, prepared);
  if (opts.propose) {
    const res = await llm.complete({
      purpose: "assess",
      system: ASSESS_SYSTEM + ASSESS_PROPOSAL_ADDENDUM,
      user,
      schema: AssessProposalOut,
      schemaName: "assessment_proposal",
      tier: "main",
      signal: opts.signal,
    });
    const { proposedVerdict, ...out } = res.data;
    return { out, proposedVerdict, usage: res.usage };
  }
  const res = await llm.complete({
    purpose: "assess",
    system: ASSESS_SYSTEM,
    user,
    schema: AssessOut,
    schemaName: "assessment",
    tier: "main",
    signal: opts.signal,
  });
  return { out: res.data, usage: res.usage };
}

function blank(claimId: string, recordId: string): EvidenceAssessment {
  return {
    claimId,
    recordId,
    relation: "BEZ_ZWIAZKU",
    aspect: "sedno",
    quote: "",
    quoteVerified: false,
    quoteMatchScore: 0,
    verifier: "brak",
    decisive: false,
  };
}

/**
 * Turns the model's raw output into EvidenceAssessments with code-side quote checks.
 * Returns new detector events (hits on the quotes themselves).
 */
export function toAssessments(
  claim: Claim,
  prepared: PreparedRecord[],
  raw: AssessOut | undefined,
  detect: DetectFn,
): { assessments: EvidenceAssessment[]; events: DetectorHit[] } {
  const events: DetectorHit[] = [];
  const assessments: EvidenceAssessment[] = [];
  const byRef = new Map(prepared.map((p) => [p.ref, p]));
  const done = new Set<string>();

  for (const p of prepared) {
    if (p.unusable) {
      assessments.push({ ...blank(claim.id, p.record.id), excluded: "detector_hit" });
      done.add(p.ref);
    }
  }

  for (const item of raw?.content ?? []) {
    const p = byRef.get(item.ref.trim());
    if (!p || done.has(p.ref) || p.record.role !== "tresc") continue;
    done.add(p.ref);
    const a: EvidenceAssessment = {
      ...blank(claim.id, p.record.id),
      relation: item.relation === "KORYGUJE_CZESC" ? "CZESCIOWO"
        : item.relation === "POTWIERDZA_DAWNY_STAN" ? "INNY_KONTEKST" : item.relation,
      ...(item.relation === "POTWIERDZA_DAWNY_STAN" && { historicalSupport: true as const }),
      ...(item.relation === "KORYGUJE_CZESC" ? { partialMeaning: "correction" as const }
        : item.relation === "CZESCIOWO" ? { partialMeaning: "coverage" as const } : {}),
      aspect: item.aspect,
      ...(item.period ? { period: item.period } : {}),
    };
    if (item.relation === "BEZ_ZWIAZKU") {
      assessments.push({ ...a, quote: truncateWords(item.quote.trim(), QUOTE_MAX_CHARS), excluded: "bez_zwiazku" });
      continue;
    }
    const quote = truncateWords(item.quote.trim(), QUOTE_MAX_CHARS);
    const m = findQuoteInRecord(quote, p.record);
    if (!m.found || !m.matched) {
      assessments.push({
        ...a,
        quote,
        quoteMatchScore: round(m.score),
        excluded: m.tooShort ? "quote_too_short" : "quote_not_found",
      });
      continue;
    }
    // Quote taken from the original record text (never the model's spelling).
    const recordQuote = truncateWords(m.matched, QUOTE_MAX_CHARS);
    const verified: EvidenceAssessment = { ...a, quote: recordQuote, quoteVerified: true, quoteMatchScore: round(m.score) };
    if (p.hits.length > 0 && !findQuote(quote, p.safeText).found) {
      assessments.push({ ...verified, excluded: "detector_hit" });
      continue;
    }
    const qHits = detect(recordQuote, "quote", p.record.id);
    if (qHits.length > 0) {
      events.push(...qHits);
      assessments.push({ ...verified, excluded: "detector_hit" });
      continue;
    }
    if (claim.temporal.kind === "stan" && onlyAnnouncesFutureAction(claim.text, recordQuote)) {
      assessments.push({ ...verified, excluded: "future_announcement_only" });
      continue;
    }
    if (verified.relation === "INNY_KONTEKST" && asksForElectionWinner(claim.text)
        && electionResultStage(p.record) === "runoff_pending") {
      // A bulletin announcing another vote cannot show who ultimately won it.
      assessments.push({ ...verified, relation: "CZESCIOWO", partialMeaning: "coverage" });
    } else {
      assessments.push(verified);
    }
  }

  const fixedByRef = new Map((raw?.fixedRole ?? []).map((f) => [f.ref.trim(), f.match]));
  for (const p of prepared) {
    if (done.has(p.ref) || p.record.role !== "stala_rola") continue;
    done.add(p.ref);
    const match: FixedRoleMatch = fixedByRef.get(p.ref) ?? "niepewne";
    const r = p.record;
    // A verbatim published finding is more informative than repeating the words under review.
    const cr = p.safeClaimReviewed?.trim();
    const crInText = cr ? findQuote(cr, p.safeText) : undefined;
    const finding = match === "ta_sama" && (reviewExplanation(r, p.safeText, cr) ?? publicationLinks()
      .find(link => link.publicationId === r.id && link.url === r.url)?.excerpts
      ?.find(text => p.safeText.includes(text) && !cr?.includes(text)));
    const quote = truncateWords(finding || crInText?.matched || p.safeText.trim(), QUOTE_MAX_CHARS);
    const quoteHits = detect(quote, "quote", r.id);
    if (!quote || !r.text.includes(quote) || quoteHits.length) {
      events.push(...quoteHits);
      assessments.push({ ...blank(claim.id, r.id), excluded: quoteHits.length ? "detector_hit" : "quote_not_found" });
      continue;
    }
    assessments.push({
      ...blank(claim.id, r.id),
      relation: fixedRoleRelation(match, r.rating, cr),
      aspect: "sedno",
      ...(r.period ? { period: r.period } : {}),
      quote,
      quoteVerified: quote.length > 0,
      quoteMatchScore: quote.length > 0 ? 1 : 0,
      fixedRoleMatch: match,
    });
  }

  // Content records the model skipped: listed as unrelated, never as evidence.
  for (const p of prepared) {
    if (!done.has(p.ref)) assessments.push({ ...blank(claim.id, p.record.id), excluded: "not_assessed" });
  }
  const day = requestedEventDay(claim);
  const records = new Map(prepared.map(p => [p.record.id, p.record]));
  return { assessments: assessments.map(a => preciseDateAssessment(day, a, records.get(a.recordId))), events };
}

/**
 * Quote check against the stored record text. The model sees the title above the fragment and
 * sometimes starts its quote there: then the quote is matched against „title + text” and only the part
 * that lies in the record TEXT is kept (it must itself pass the length rules). The shown quote is
 * therefore always a span of the stored record text, never model output and never the title alone.
 */
export function findQuoteInRecord(quote: string, r: CorpusRecord): QuoteMatch {
  const m = findQuote(quote, r.text);
  if (m.found || !r.title) return m;
  const prefix = `${r.title}\n\n`;
  const withTitle = findQuote(quote, prefix + r.text);
  if (!withTitle.found || withTitle.end === undefined || withTitle.end <= prefix.length) return m;
  const textPart = (prefix + r.text).slice(Math.max(prefix.length, withTitle.start ?? 0), withTitle.end).trim();
  const again = textPart ? findQuote(textPart, r.text) : m;
  return again.found ? again : m;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
