/**
 * Step 6 (iii) — independent verifier: ONE batched call (verifier provider, fast tier) only for
 * evidence that would be decisive. "sprzeciw" → evidence stops being decisive (excluded
 * "verifier_dissent"); "niepewne" → only lowers strength (handled by the rules module).
 */
import type { Claim, CorpusRecord, EvidenceAssessment, LlmProvider, ModelUsage, VerifierVote } from "../shared/contracts";
import { fence } from "./llm/fence";
import { VERIFIER_SYSTEM, VerifierOut } from "./prompts";
import { canReadRate, readRateEvidence } from "./verifier-rate";
import { isProfileField } from "./retrieval/subject";

/** One batched call; 18 covers 6 claims with up to 3 decisive items each (items are interleaved per claim). */
export const MAX_VERIFIER_ITEMS = 18;

export interface VerifierCandidate {
  claim: Claim;
  assessment: EvidenceAssessment;
  record: CorpusRecord;
}

export function buildVerifierPrompt(items: { ref: string; c: VerifierCandidate }[], checkedAt?: Date): string {
  const parts = ["Oceń każdą pozycję."];
  if (items.some(({c}) => c.record.topics.includes("cpi-yoy") || c.record.topics.includes("nbp-reference"))) {
    parts.push("Głos dotyczy poprawności zaproponowanej relacji. Poprawne obalenie oraz poprawne potwierdzenie otrzymują głos zgoda, błędne przypisanie relacji otrzymuje sprzeciw. Sprawdź, czy to ta sama miara, jednostka, wartość lub próg i właściwy okres. Dla relacji o wartości historycznej oceń wyłącznie podany okres historyczny. Dla twierdzenia o aktualnym wskaźniku publikowanym okresowo ustal, czy cytowany odczyt był ostatnim opublikowanym w dniu sprawdzenia. Data publikacji sama tego nie dowodzi.");
  }
  if (items.some(({ c }) => c.assessment.historicalSupport)) {
    parts.push("W pozycji HISTORYCZNA oceń osobno, czy podana osoba, funkcja lub wartość zgadza się z cytatem WE WSKAZANYM DAWNYM OKRESIE. Wystarczy zgodność dla tego okresu. Bieżący stan jest oceniany w oddzielnej pozycji.");
  }
  for (const { ref, c } of items) {
    const body =
      c.record.role === "stala_rola"
        ? `Rodzaj: dopasowanie\nTwierdzenie: ${c.claim.text}\nTeza sprawdzona przez fact-checkerów: ${c.record.claimReviewed ?? c.assessment.quote}` +
          (c.assessment.quoteVerified && c.record.claimReviewed && !c.record.claimReviewed.includes(c.assessment.quote)
            ? `\nFragment uzasadnienia wydawcy: ${c.assessment.quote}` : "") +
          `\nZaproponowano: ${c.assessment.fixedRoleMatch ?? "niepewne"}`
        : c.assessment.historicalSupport
          ? `Rodzaj: HISTORYCZNA\nSprawdź, czy poniższe zdanie było prawdziwe w okresie ${c.assessment.period ?? "nieustalonym"}.\nZdanie: ${c.claim.text}\nCytat: ${c.assessment.quote}`
          : `Rodzaj: relacja\nTwierdzenie: ${c.claim.text}\nCytat: ${c.assessment.quote}\nZaproponowana relacja: ${c.assessment.partialMeaning === "correction" ? "KORYGUJE_CZESC" : c.assessment.relation} (aspekt: ${c.assessment.aspect})`;
    const heading = isProfileField(c.record, c.assessment.quote)
      ? `\nTytuł profilu, do którego należy cytowane pole: ${c.record.title}`
      : c.record.origin === "corpus" && c.record.role === "tresc" && c.record.period
        ? `\nOkres danych w katalogu: ${c.record.period}. Tytuł dokumentu: ${c.record.title}` : "";
    const rateSeries = c.record.topics.includes("cpi-yoy") || c.record.topics.includes("nbp-reference");
    let observation = "";
    if (rateSeries && checkedAt) {
      observation = `\nData sprawdzenia: ${checkedAt.toISOString().slice(0, 10)}. Wydawca: ${c.record.publisher}. Okres danych w tabeli: ${c.record.period}. Pobrano: ${c.record.fetchedAt.slice(0, 10)}.`;
    }
    parts.push(fence(`POZYCJA_${ref}`, body + heading + observation).text);
  }
  return parts.join("\n");
}

export async function runVerifier(
  verifier: LlmProvider,
  candidates: VerifierCandidate[],
  signal?: AbortSignal,
  checkedAt?: Date,
): Promise<{ votes: Map<VerifierCandidate, Exclude<VerifierVote, "brak">>; usage: ModelUsage }> {
  const items = candidates.slice(0, MAX_VERIFIER_ITEMS).map((c, i) => ({ ref: `V${i + 1}`, c }));
  if (checkedAt && items.length && items.every(({ c }) => canReadRate(c))) {
    return readRateEvidence(verifier, items.map(({ c }) => c), checkedAt, signal);
  }
  const res = await verifier.complete({
    purpose: "verifier",
    system: VERIFIER_SYSTEM,
    user: buildVerifierPrompt(items, checkedAt),
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
