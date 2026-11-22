import { z } from "zod";
import type { LlmProvider, VerifierVote } from "../shared/contracts";
import type { VerifierCandidate } from "./verifier";
import { fence, UNTRUSTED_DATA_RULES } from "./llm/fence";
import { FONS_PERSONA } from "./prompts";
import { currentRateMeasure, percentageValues } from "./retrieval/rate-series";

const RateReadings = z.object({
  readings: z.array(z.object({ ref: z.string(), valuePercent: z.number().nullable(),
    relation: z.enum(["WSPIERA", "OBALA", "NIEUSTALONE"]) })),
});

export function canReadRate(c: VerifierCandidate) {
  const measure = currentRateMeasure(c.claim);
  return measure?.sourceId === c.record.sourceId && c.record.origin === "corpus" && c.record.type === "pierwotne" &&
    (c.record.topics.includes("series-latest") || c.record.topics.includes("series-history")) &&
    (c.assessment.historicalSupport || ["WSPIERA", "OBALA"].includes(c.assessment.relation)) && !!c.assessment.quoteVerified;
}

/** Independent blind reading. The verifier sees the quoted data, not the first model's
 * interpretation. Agreement requires a literal numeric readback and matching direction. */
export async function readRateEvidence(verifier: LlmProvider, candidates: VerifierCandidate[], checkedAt: Date, signal?: AbortSignal) {
  const day = checkedAt.toISOString().slice(0, 10);
  const blocks = candidates.map((c, i) => {
    const context = c.assessment.historicalSupport ? "historyczny okres wskazany w cytacie: " + c.assessment.period
      : "stan opublikowany na dzień sprawdzenia: " + day;
    return fence("POZYCJA_V" + (i + 1), [
      "Ref: V" + (i + 1), "Twierdzenie: " + c.claim.text, "Zakres oceny: " + context, "Wydawca: " + c.record.publisher,
      "Data pobrania tabeli: " + c.record.fetchedAt.slice(0, 10), "Okres tabeli: " + c.record.period,
      "Fragment odczytu: " + c.assessment.quote,
    ].join("\n")).text;
  });
  const res = await verifier.complete({
    purpose: "verifier", tier: "fast", schema: RateReadings, schemaName: "rate_readings", signal,
    system: FONS_PERSONA + "W każdej pozycji odczytaj z fragmentu wartość procentową miernika dla wskazanego zakresu. " +
      "Dla okresu historycznego oceniaj tę samą tezę liczbową w tamtym okresie. Dla stanu bieżącego wymagaj dowodu, że to ostatni dostępny odczyt lub obowiązująca stawka. " +
      "Sprawdź podmiot, miarę, jednostkę i okres. Zapisz wartość liczbową w procentach, bez przeliczania na ułamek. " +
      "Porównaj ją z liczbą lub progiem w twierdzeniu. Jeśli odczyt potwierdza podaną wartość lub nierówność, wybierz WSPIERA. " +
      "Jeżeli odczyt jej przeczy, wybierz OBALA. Bez zgodności zakresu albo jednoznacznego odczytu wybierz NIEUSTALONE i null. " +
      UNTRUSTED_DATA_RULES,
    user: `Dzień sprawdzenia: ${day}.\n` + blocks.join("\n"),
  });
  const votes = new Map<VerifierCandidate, Exclude<VerifierVote, "brak">>();
  candidates.forEach((c, i) => {
    const readings = res.data.readings.filter(x => x.ref.trim().replace(/^POZYCJA_/u, "") === "V" + (i + 1));
    const read = readings[0];
    let vote: Exclude<VerifierVote, "brak"> = "niepewne";
    if (readings.length === 1 && read && read.valuePercent !== null && read.relation !== "NIEUSTALONE") {
      const supported = currentRateMeasure(c.claim)!.matches(read.valuePercent);
      const relation = supported ? "WSPIERA" : "OBALA";
      const expected = c.assessment.historicalSupport ? "WSPIERA" : c.assessment.relation;
      const inScope = c.assessment.historicalSupport ? !!c.assessment.period :
        c.record.topics.includes("series-latest") && c.record.fetchedAt.slice(0, 10) === day;
      vote = inScope && percentageValues(c.assessment.quote).includes(read.valuePercent) &&
        read.relation === relation && relation === expected ? "zgoda" : "sprzeciw";
    }
    votes.set(c, vote);
  });
  return { votes, usage: res.usage };
}
