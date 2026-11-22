import type { EvidenceItem, Verdict } from "../shared/contracts";

/** A public answer supported by passages from the retrieved publications. */
export interface PublishedAnswer {
  answerPl: string;
  evidence: EvidenceItem[];
  claimPl?: string;
  verdict?: Verdict;
}
