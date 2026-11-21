import type { Claim, CorpusRecord, EvidenceAssessment, StrengthCard, Verdict } from "../../shared/contracts";

/**
 * Twierdzenie z opcjonalnym `assertedAspect` — pole jest już w kontrakcie (contracts.ts → Claim), więc to alias
 * zachowany dla zgodności importów. Znaczenie pola: który aspekt niesie JEDYNĄ sprawdzalną treść twierdzenia poza
 * oczywistym, niespornym podmiotem.
 *  - „Polska wstąpiła do NATO w 2004 roku.” → czas
 *  - „W 2024 roku inflacja w Polsce wyniosła 15 procent.” → liczba
 *  - „Ustawę o obronie podpisał Jakub Siuda.” → autorstwo
 *  - „Wczoraj w Krakowie była powódź.” → sedno (twierdzi, że zdarzenie zaszło)
 * Brak pola = reguły używają zachowawczego przybliżenia (slots.ts). Pole podane = rozstrzyga w obie strony
 * (sedno wyłącza regułę 8b).
 */
export type ClaimWithFocus = Claim;

/** Wejście reguł werdyktu (docs/MODULES.md). */
export interface VerdictInput {
  claim: ClaimWithFocus;
  /** Już po kontroli cytatów i weryfikatorze. Oceny innych twierdzeń są pomijane. */
  assessments: EvidenceAssessment[];
  records: Map<string, CorpusRecord>;
  now: Date;
  /** Weryfikator tej samej rodziny → jawny czynnik obniżający punktację siły (strength.ts; bez twardego limitu). */
  singleKeyVerifier: boolean;
}

/** Wynik reguł werdyktu (docs/MODULES.md) + jedno pole opcjonalne (rozszerzenie zgodne wstecz). */
export interface VerdictDecision {
  verdict: Verdict;
  /** Numer reguły z PLAN §4 (1–9) — zawsze ustawiony. */
  ruleApplied: number;
  strength: StrengthCard;
  /** Rekordy, na których oparto werdykt (podstawa). Dla reguł 1 i 2 — pusta lista. */
  decisiveRecordIds: string[];
  /** Nazwany brakujący kontekst (reguły 4 i 9). Prosty polski. */
  missingContext?: string;
  /** Tylko reguła 5: obie strony sprzeczności, bez wskazywania zwycięzcy. */
  conflicting?: { supporting: string[]; refuting: string[] };
  /** Reguła 4: werdykt wynika z nieaktualności materiału (ostrzeżenie o materiale archiwalnym). */
  archival: boolean;
  /**
   * ROZSZERZENIE (nie ma go w MODULES.md, pole opcjonalne): rekordy policzone, ale poniżej progu
   * rozstrzygalności (pojedyncze źródło wtórne, weto weryfikatora, ocena nieznana tabeli…).
   * Przydaje się do „co znaleziono poniżej progu” w BRAK_DOWODOW (PLAN §4, reguła 2).
   */
  belowThresholdRecordIds?: string[];
}

/** Kierunek dowodu po sprowadzeniu relacji / oceny z tabeli do jednej osi. */
export type Polarity = "support" | "refute" | "partial" | "none";

/**
 * Rodzaj dowodu w sensie definicji rozstrzygalności:
 *  primary         — rekord treści poziomu 1 (pierwotne / urzędowe),
 *  fixed           — rekord o stałej roli od sygnatariusza IFCN/EFCSN (poziom ≤ 2) lub z bazy organizatora,
 *  fixed_unqualified — rekord o stałej roli spoza tej grupy (nie rozstrzyga),
 *  secondary       — rekord treści poziomu 2–3 (rozstrzyga tylko w parze z niezależnym).
 */
export type EvidenceKind = "primary" | "fixed" | "fixed_unqualified" | "secondary";
