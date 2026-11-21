/**
 * Twierdzenia złożone — ten sam fakt przypisany kilku podmiotom („Polska i Litwa wstąpiły do NATO w 1999”).
 *
 * Ekstrakcja (claims.ts) rozbija takie twierdzenie na części — po jednej na podmiot, tymi samymi słowami.
 * Każda część przechodzi zwykły potok (wyszukiwanie, ocena, weryfikator, reguły 1–9). Ten moduł łączy
 * werdykty części w werdykt całości — deterministycznie, w kodzie:
 *
 *  - każda część POTWIERDZONE                            → POTWIERDZONE;
 *  - choć jedna FAŁSZYWE i choć jedna POTWIERDZONE
 *    albo WPROWADZAJĄCE                                  → WPROWADZAJĄCE (z nazwaniem błędnej części);
 *  - choć jedna FAŁSZYWE, żadna prawdziwa               → FAŁSZYWE (zdanie z fałszywą częścią jest fałszywe);
 *  - choć jedna WPROWADZAJĄCE, żadna FAŁSZYWE           → WPROWADZAJĄCE;
 *  - pozostałe (BRAK DOWODÓW bez FAŁSZYWE)               → BRAK DOWODÓW;
 *  - części NIE PODLEGA są pomijane; same NIE PODLEGA   → NIE PODLEGA.
 *
 * Siła całości = siła najsłabiej udokumentowanej części, która ustala werdykt (punktacja to minimum) —
 * całość nie może być pewniejsza niż jej najsłabszy element.
 */
import type { Claim, StrengthCard, Verdict } from "../../shared/contracts";

export interface PartOutcome {
  claim: Claim;
  verdict: Verdict;
  ruleApplied: number;
  strength: StrengthCard;
  reasonPl: string;
}

export interface CompoundOutcome {
  verdict: Verdict;
  ruleApplied: number;
  strength: StrengthCard;
}

/** Numer reguły PLAN §4 dla werdyktu całości, gdy żadna część nie ma tego werdyktu (np. mieszanka → 9). */
const RULE_FOR_VERDICT: Record<Verdict, number> = {
  NIE_PODLEGA: 1,
  BRAK_DOWODOW: 2,
  POTWIERDZONE: 7,
  FALSZYWE: 8,
  WPROWADZAJACE: 9,
};

const MERIT: ReadonlySet<Verdict> = new Set(["POTWIERDZONE", "FALSZYWE", "WPROWADZAJACE"]);

export function aggregateVerdict(verdicts: Verdict[]): Verdict {
  const v: Verdict[] = verdicts.filter((x) => x !== "NIE_PODLEGA");
  if (v.length === 0) return "NIE_PODLEGA";
  const has = (x: Verdict) => v.includes(x);
  if (has("FALSZYWE")) return has("POTWIERDZONE") || has("WPROWADZAJACE") ? "WPROWADZAJACE" : "FALSZYWE";
  if (has("WPROWADZAJACE")) return "WPROWADZAJACE";
  if (v.every((x) => x === "POTWIERDZONE")) return "POTWIERDZONE";
  return "BRAK_DOWODOW";
}

export const COMPOUND_FACTOR_PL = (n: number) =>
  `Twierdzenie dotyczy ${n} podmiotów — każdy sprawdziliśmy osobno; punktacja to wynik najsłabiej udokumentowanej części.`;

export function aggregateCompound(parts: PartOutcome[]): CompoundOutcome {
  const verdict = aggregateVerdict(parts.map((p) => p.verdict));
  const same = parts.find((p) => p.verdict === verdict);
  const ruleApplied = same && verdict !== "WPROWADZAJACE" ? same.ruleApplied : RULE_FOR_VERDICT[verdict];

  if (!MERIT.has(verdict)) {
    const base = (same ?? parts[0])!.strength;
    return { verdict, ruleApplied, strength: { ...base, level: "slaba", score: null, factors: [] } };
  }
  // Części, które ustalają werdykt merytoryczny (bez BRAK/NIE PODLEGA przy FAŁSZYWE z luką).
  const deciding = parts.filter((p) => MERIT.has(p.verdict));
  const weakest = deciding.reduce((a, b) => ((b.strength.score ?? 0) < (a.strength.score ?? 0) ? b : a));
  const factors = [{ effect: "plus" as const, textPl: COMPOUND_FACTOR_PL(parts.length) }, ...(weakest.strength.factors ?? [])];
  return { verdict, ruleApplied, strength: { ...weakest.strength, factors } };
}
