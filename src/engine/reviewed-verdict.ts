import type { CorpusRecord, FixedRating, FixedRoleMatch, Relation, Verdict } from "../shared/contracts";
import { QUOTE_MAX_CHARS } from "./quotes";

/** The ClaimReview feed stores the publisher's ratingExplanation after the exact
 * claim and a newline. Metadata-only reviews have no explanation to quote. */
export function reviewExplanation(record: CorpusRecord, safeText: string, reviewed?: string): string | undefined {
  if (record.origin !== "corpus" || record.role !== "stala_rola" || !record.topics.includes("claimreview")
    || !reviewed || reviewed !== record.claimReviewed) return;
  const prefix = reviewed + "\n";
  if (!safeText.startsWith(prefix)) return;
  const explanation = safeText.slice(prefix.length).trim();
  return explanation && explanation.length <= QUOTE_MAX_CHARS && record.text.includes(explanation) && !reviewed.includes(explanation)
    ? explanation : undefined;
}

/** Conservatively detect independent sentences or coordinated clauses before inverting a false rating. */
export function isCompoundClaim(text: string | undefined): boolean {
  if (!text) return false;
  const clauses = text.split(/(?:[.!?…]+(?:\s+|$)|;\s*|,\s*(?:a|ale|lecz|natomiast)\s+|\s+(?:i|oraz|lub|albo|and|or|but)\s+)/iu);
  return clauses.filter(clause => (clause.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2).length >= 2;
}

/** An assessment of the whole statement cannot establish which conjunct of a false claim failed. */
export function reviewedVerdict(match: FixedRoleMatch | undefined, rating: FixedRating | undefined, claimReviewed?: string): Verdict | null {
  if (!rating?.mapped) return null;
  if (match === "ta_sama") return rating.mapped;
  if (match !== "zaprzeczona" || !rating.binary) return null;
  if (rating.mapped === "POTWIERDZONE") return "FALSZYWE";
  if (rating.mapped === "FALSZYWE" && !isCompoundClaim(claimReviewed)) return "POTWIERDZONE";
  return null;
}

export function fixedRoleRelation(match: FixedRoleMatch, rating: FixedRating | undefined, claimReviewed?: string): Relation {
  if (match === "inna") return "BEZ_ZWIAZKU";
  switch (reviewedVerdict(match, rating, claimReviewed)) {
    case "POTWIERDZONE": return "WSPIERA";
    case "FALSZYWE": return "OBALA";
    case "WPROWADZAJACE": return "CZESCIOWO";
    default: return "INNY_KONTEKST";
  }
}
