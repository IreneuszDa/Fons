import type { Claim, CorpusRecord, EvidenceAssessment } from "../../shared/contracts";
import { copiedPassageKey, isCounted } from "./decisive";
import { overlaps, parsePeriod } from "./periods";

export function independentPublications(a: CorpusRecord, b: CorpusRecord): boolean {
  if (a.id === b.id || a.independenceGroup === b.independenceGroup || a.url.split("#")[0] === b.url.split("#")[0]) return false;
  const key = copiedPassageKey(a);
  return !key || key !== copiedPassageKey(b);
}

/** A single secondary report cannot establish a verdict. Two independent, opposite
 * readings can establish disagreement when they explicitly cover the same data window.
 * This stricter comparison never uses year of publication as a proxy for data period. */
export function opposingReports(claim: Claim, assessments: EvidenceAssessment[], records: Map<string, CorpusRecord>, beforeVote = false) {
  const eligible = assessments.flatMap(a => {
    const r = records.get(a.recordId);
    if (a.claimId !== claim.id || !isCounted(a, r) || r.role !== "tresc" || a.historicalSupport ||
        (!beforeVote && a.verifier !== "zgoda") || a.verifier === "sprzeciw") return [];
    if (a.relation !== "WSPIERA" && a.relation !== "OBALA") return [];
    const period = parsePeriod(a.period) ?? parsePeriod(r.period);
    if (!period || !overlaps(period, parsePeriod(claim.temporal.asOf))) return [];
    return [{ a, r, period }];
  });
  const pairs: { supporting: string; refuting: string }[] = [];
  for (const s of eligible) {
    if (s.a.relation !== "WSPIERA") continue;
    for (const f of eligible) {
      if (f.a.relation !== "OBALA" || (s.r.level === 1 && f.r.level === 1)) continue;
      if (s.a.aspect !== f.a.aspect && !(claim.assertedAspect === "liczba" &&
          [s.a.aspect, f.a.aspect].every(aspect => aspect === "sedno" || aspect === "liczba"))) continue;
      if (s.period.start !== f.period.start || s.period.end !== f.period.end || !independentPublications(s.r, f.r)) continue;
      pairs.push({ supporting: s.r.id, refuting: f.r.id });
    }
  }
  return pairs;
}
