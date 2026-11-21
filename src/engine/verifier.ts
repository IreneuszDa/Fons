/**
 * Step 6 (iii) — independent verifier: ONE batched call (verifier provider, fast tier) only for
 * evidence that would be decisive. "sprzeciw" → evidence stops being decisive (excluded
 * "verifier_dissent"); "niepewne" → only lowers strength (handled by the rules module).
 */
import type { Claim, CorpusRecord, EvidenceAssessment, LlmProvider, ModelUsage, VerifierVote } from "../shared/contracts";
import { fence } from "./llm/fence";
import { VERIFIER_SYSTEM, VerifierOut } from "./prompts";

/** One batched call; 18 covers 6 claims with up to 3 decisive items each (items are interleaved per claim). */
export const MAX_VERIFIER_ITEMS = 18;

export interface VerifierCandidate {
  claim: Claim;
  assessment: EvidenceAssessment;
  record: CorpusRecord;
}

export function buildVerifierPrompt(items: { ref: string; c: VerifierCandidate }[]): string {
  const parts = ["Oceń każdą pozycję."];
  for (const { ref, c } of items) {
    const body =
      c.record.role === "stala_rola"
        ? `Rodzaj: dopasowanie\nTwierdzenie: ${c.claim.text}\nTeza sprawdzona przez fact-checkerów: ${c.record.claimReviewed ?? c.assessment.quote}\nZaproponowano: ${c.assessment.fixedRoleMatch ?? "niepewne"}`
        : `Rodzaj: relacja\nTwierdzenie: ${c.claim.text}\nCytat: ${c.assessment.quote}\nZaproponowana relacja: ${c.assessment.relation} (aspekt: ${c.assessment.aspect})`;
    parts.push(fence(`POZYCJA_${ref}`, body).text);
  }
  return parts.join("\n");
}

export async function runVerifier(
  verifier: LlmProvider,
  candidates: VerifierCandidate[],
  signal?: AbortSignal,
): Promise<{ votes: Map<VerifierCandidate, Exclude<VerifierVote, "brak">>; usage: ModelUsage }> {
  const items = candidates.slice(0, MAX_VERIFIER_ITEMS).map((c, i) => ({ ref: `V${i + 1}`, c }));
  const res = await verifier.complete({
    purpose: "verifier",
    system: VERIFIER_SYSTEM,
    user: buildVerifierPrompt(items),
    schema: VerifierOut,
    schemaName: "verifier_votes",
    tier: "fast",
    signal,
  });
  const byRef = new Map(res.data.votes.map((v) => [v.ref.trim(), v.vote]));
  const votes = new Map<VerifierCandidate, Exclude<VerifierVote, "brak">>();
  for (const { ref, c } of items) votes.set(c, byRef.get(ref) ?? "niepewne");
  return { votes, usage: res.usage };
}

/** Applies a vote to an assessment (pure). */
export function applyVote(a: EvidenceAssessment, vote: Exclude<VerifierVote, "brak">): EvidenceAssessment {
  if (vote === "sprzeciw") return { ...a, verifier: "sprzeciw", excluded: a.excluded ?? "verifier_dissent" };
  return { ...a, verifier: vote };
}
