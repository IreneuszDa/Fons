/**
 * Widok jednego policzonego dowodu na potrzeby reguł: ocena + rekord + wyliczone cechy.
 */
import type { Aspect, CorpusRecord, EvidenceAssessment, Verdict } from "../../shared/contracts";
import { effectiveFixedVerdict, evidenceKind, polarityOf } from "./decisive";
import { parsePeriod, yearRangeOf, type Range } from "./periods";
import type { EvidenceKind, Polarity } from "./types";

export interface Ev {
  a: EvidenceAssessment;
  r: CorpusRecord;
  decisive: boolean;
  kind: EvidenceKind;
  polarity: Polarity;
  aspect: Aspect;
  /** Okres, którego dotyczy dowód: assessment.period → record.period → rok publikacji. */
  period: Range | undefined;
  /** Dzień publikacji (gdy znany). */
  published: Range | undefined;
  /** Werdykt z tabeli mapowania (tylko stała rola). */
  fixedVerdict: Verdict | null;
}

export function buildEv(a: EvidenceAssessment, r: CorpusRecord, decisive: boolean): Ev {
  return {
    a,
    r,
    decisive,
    kind: evidenceKind(r),
    polarity: polarityOf(a, r),
    aspect: a.aspect,
    period: parsePeriod(a.period) ?? parsePeriod(r.period) ?? yearRangeOf(r.publishedAt),
    published: parsePeriod(r.publishedAt),
    fixedVerdict: r.role === "stala_rola" ? effectiveFixedVerdict(a, r) : null,
  };
}

/**
 * Najpóźniejsza chwila, w której rekord MÓGŁ zostać opublikowany: data publikacji,
 * a gdy jej brak — data pobrania (rekord na pewno istniał, zanim go pobraliśmy).
 */
export function publicationUpperBound(e: Ev): number | undefined {
  return e.published?.end ?? parsePeriod(e.r.fetchedAt)?.end;
}

/** Data „świeżości” dowodu do ostrzeżenia archiwalnego: publikacja, a w razie braku — koniec okresu. */
export function freshnessDate(e: Ev): number | undefined {
  return e.published?.end ?? e.period?.end;
}

export function uniqueIds(evs: Ev[]): string[] {
  return [...new Set(evs.map((e) => e.r.id))];
}
