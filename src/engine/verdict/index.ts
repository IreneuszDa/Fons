/**
 * Reguły werdyktu (PLAN §4): czysta funkcja reguł 1–9, rozstrzygalność dowodu, karta siły.
 * Opis dla jury: docs/VERDICT-RULES.md.
 */
export type { VerdictInput, VerdictDecision, Polarity, EvidenceKind } from "./types";
export { decideVerdict } from "./rules";
export {
  isDecisive,
  isCounted,
  isQualifiedFixedRole,
  effectiveFixedVerdict,
  polarityOf,
  annotateDecisive,
} from "./decisive";
export { ARCHIVAL_MONTHS } from "./strength";
export { ASPECT_PL } from "./texts";
export { parsePeriod, overlaps, strictlyAfter, type Range } from "./periods";
