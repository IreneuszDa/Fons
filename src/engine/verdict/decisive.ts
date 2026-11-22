/**
 * Rozstrzygalność dowodu (PLAN §4, „Dowód rozstrzygający”).
 *
 * Dowód rozstrzygający = zweryfikowany cytat z:
 *   (a) ≥ 1 źródła pierwotnego/urzędowego (rekord treści, poziom 1), ALBO
 *   (b) ≥ 1 rekordu o stałej roli od organizacji IFCN/EFCSN lub z bazy organizatora, dopasowanego
 *       do twierdzenia (fixedRoleMatch = ta_sama, albo zaprzeczona przy ocenie binarnej), ALBO
 *   (c) ≥ 2 niezależnych źródeł wtórnych (różne grupy niezależności).
 *
 * Decyzje interpretacyjne (zachowawcze):
 *  - Dowód w ogóle się nie liczy, gdy: ma `excluded`, `quoteVerified === false`, relację BEZ_ZWIAZKU,
 *    brak rekordu w mapie albo recordId nie zgadza się z rekordem.
 *  - Głos weryfikatora „sprzeciw” odbiera rozstrzygalność (dowód zostaje poniżej progu).
 *    „niepewne” NIE odbiera rozstrzygalności — tylko obniża siłę (strength.ts).
 *  - Rekord o stałej roli: „sygnatariusz IFCN/EFCSN” rozpoznajemy po poziomie rekordu ≤ 2
 *    (CorpusRecord nie ma pola ifcnEfcsn; katalog przypisuje poziom 2 właśnie fact-checkom sygnatariuszy
 *    — contracts.ts, SourceLevel), a „baza organizatora” po `origin === "organizer"`.
 *    Rekord o stałej roli spoza tej grupy nigdy nie rozstrzyga i nie jest liczony jako źródło wtórne
 *    (jego relacja z czytelnika nie ma znaczenia — werdykt bierzemy tylko z oceny).
 *  - Rekord o stałej roli rozstrzyga tylko, gdy ocena z tabeli istnieje (`rating.mapped !== null`).
 *    `zaprzeczona` odwraca wyłącznie oceny binarne FALSZYWE ↔ POTWIERDZONE (flaga `binary` i jedna
 *    z tych dwóch wartości); każda inna kombinacja nie rozstrzyga. `inna` i `niepewne` nie rozstrzygają.
 *  - Źródło wtórne (rekord treści poziomu 2 lub 3) jest rozstrzygające, gdy dla tego samego twierdzenia
 *    istnieje inny policzony, niezawetowany rekord wtórny z INNEJ grupy niezależności, o tym samym
 *    aspekcie i tym samym kierunku (oba wspierają / oba obalają / oba częściowo). Dwa źródła wtórne,
 *    które się nie zgadzają, nie tworzą razem dowodu rozstrzygającego.
 *  - Poziom 2 dla rekordu TREŚCI (np. analiza instytucji UE/NATO) to wciąż źródło wtórne w sensie (c):
 *    definicja (a) obejmuje tylko pierwotne/urzędowe (poziom 1).
 */
import type { CorpusRecord, EvidenceAssessment, Verdict } from "../../shared/contracts";
import type { EvidenceKind, Polarity } from "./types";

/** Czy ocena w ogóle wchodzi do rachunku (niezależnie od progu rozstrzygalności). */
export function isCounted(a: EvidenceAssessment, r: CorpusRecord | undefined): r is CorpusRecord {
  if (!r) return false;
  if (a.recordId !== r.id) return false;
  if (a.excluded) return false;
  if (a.quoteVerified !== true) return false;
  if (a.relation === "BEZ_ZWIAZKU") return false;
  return true;
}

/** Rekord o stałej roli od sygnatariusza IFCN/EFCSN (poziom ≤ 2) lub z bazy organizatora. */
export function isQualifiedFixedRole(r: CorpusRecord): boolean {
  return r.role === "stala_rola" && (r.level <= 2 || r.origin === "organizer");
}

export function evidenceKind(r: CorpusRecord): EvidenceKind {
  if (r.role === "stala_rola") return isQualifiedFixedRole(r) ? "fixed" : "fixed_unqualified";
  return r.level === 1 ? "primary" : "secondary";
}

/** Copies of a substantial passage can circulate under different publisher names.
 * A shared short name, date, or the text of a claim rated by two fact-checkers is insufficient. */
export function copiedPassageKey(record: CorpusRecord): string | undefined {
  if (record.role !== "tresc") return;
  const words = record.text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words && words.length >= 24 ? words.join(" ") : undefined;
}

/**
 * Werdykt wynikający z rekordu o stałej roli — WYŁĄCZNIE z oceny przez tabelę mapowania.
 * null = rekord nie rozstrzyga (brak oceny, ocena nieznana, `inna`, `niepewne`, negacja oceny niebinarnej).
 */
export function effectiveFixedVerdict(a: EvidenceAssessment, r: CorpusRecord): Verdict | null {
  if (r.role !== "stala_rola" || !r.rating) return null;
  const mapped = r.rating.mapped;
  if (mapped == null) return null;
  switch (a.fixedRoleMatch) {
    case "ta_sama":
      return mapped;
    case "zaprzeczona":
      if (!r.rating.binary) return null;
      if (mapped === "FALSZYWE") return "POTWIERDZONE";
      if (mapped === "POTWIERDZONE") return "FALSZYWE";
      return null; // „binarna”, ale nie fałsz/prawda — nie zgadujemy
    default:
      return null; // inna, niepewne, brak dopasowania
  }
}

/** Kierunek dowodu względem twierdzenia. */
export function polarityOf(a: EvidenceAssessment, r: CorpusRecord): Polarity {
  if (r.role === "stala_rola") {
    switch (effectiveFixedVerdict(a, r)) {
      case "POTWIERDZONE":
        return "support";
      case "FALSZYWE":
        return "refute";
      case "WPROWADZAJACE":
        return "partial";
      default:
        return "none";
    }
  }
  switch (a.relation) {
    case "WSPIERA":
      return "support";
    case "OBALA":
      return "refute";
    case "CZESCIOWO":
      return a.partialMeaning === "correction" ? "partial" : "none";
    case "INNY_KONTEKST":
      return "partial";
    default:
      return "none";
  }
}

/**
 * Czy dowód `a` (z rekordu `r`) jest rozstrzygający wg PLAN §4.
 * `all` — wszystkie oceny (do sprawdzenia drugiego, niezależnego źródła wtórnego), `records` — mapa rekordów.
 */
export function isDecisive(
  a: EvidenceAssessment,
  r: CorpusRecord,
  all: EvidenceAssessment[],
  records: Map<string, CorpusRecord>,
): boolean {
  if (!isCounted(a, r)) return false;
  if (a.verifier === "sprzeciw") return false;

  const kind = evidenceKind(r);
  if (kind !== "fixed" && polarityOf(a, r) === "none") return false;
  if (kind === "primary") return true;
  if (kind === "fixed") return effectiveFixedVerdict(a, r) !== null;
  if (kind === "fixed_unqualified") return false;

  // Źródło wtórne: potrzebny niezależny drugi rekord wtórny, ten sam aspekt i kierunek.
  const pol = polarityOf(a, r);
  if (pol === "none") return false;
  return all.some((b) => {
    if (b === a || b.claimId !== a.claimId || b.recordId === a.recordId) return false;
    if (b.aspect !== a.aspect || b.verifier === "sprzeciw") return false;
    const rb = records.get(b.recordId);
    if (!isCounted(b, rb)) return false;
    if (evidenceKind(rb) !== "secondary") return false;
    if (rb.independenceGroup === r.independenceGroup) return false;
    const passage = copiedPassageKey(r);
    if (passage && passage === copiedPassageKey(rb)) return false;
    return polarityOf(b, rb) === pol;
  });
}

/** Wygodne: kopie ocen z polem `decisive` wyliczonym przez kod (do zapisu w raporcie/przebiegu). */
export function annotateDecisive(
  assessments: EvidenceAssessment[],
  records: Map<string, CorpusRecord>,
): EvidenceAssessment[] {
  return assessments.map((a) => {
    const r = records.get(a.recordId);
    return { ...a, decisive: r ? isDecisive(a, r, assessments, records) : false };
  });
}
