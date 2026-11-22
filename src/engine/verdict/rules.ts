/**
 * Reguły werdyktu 1–9 (PLAN §4) — czysta funkcja, bez I/O i bez modelu.
 * Pełny opis reguł z przykładami: docs/VERDICT-RULES.md.
 *
 * Kolejność stosowania jest ścisła (pierwsza pasująca reguła wygrywa):
 *  1 opinia / prognoza                                   → NIE_PODLEGA
 *  2 brak dowodu rozstrzygającego                        → BRAK_DOWODOW
 *  3 jednorazowe zdarzenie z datą nowsze niż dowody      → BRAK_DOWODOW
 *  4 stan „teraz”: starsze WSPIERA, nowsze urzędowe OBALA → WPROWADZAJACE (archival)
 *  5 WSPIERA i OBALA ten sam aspekt                       → BRAK_DOWODOW + conflicting
 *  6 dopasowany rekord o stałej roli, bez sprzecznego pierwotnego → werdykt z tabeli
 *  7 WSPIERA sedno, nic nie obalone                       → POTWIERDZONE
 *  8 OBALA sedno / twierdzenie = obalona data lub liczba → FALSZYWE (8b: tylko OBALA, nigdy CZESCIOWO)
 *  9 reszta (obalony aspekt, CZESCIOWO, INNY_KONTEKST)   → WPROWADZAJACE + missingContext
 *
 * Wszystkie reguły od 3 w górę patrzą WYŁĄCZNIE na dowody rozstrzygające (isDecisive).
 * Dowody poniżej progu wpływają tylko na siłę (strength.ts) i listę belowThresholdRecordIds.
 */
import type { Aspect, Verdict } from "../../shared/contracts";
import { isCounted, isDecisive } from "./decisive";
import { buildEv, publicationUpperBound, uniqueIds, type Ev } from "./evidence";
import { overlaps, parsePeriod, strictlyAfter, textCoversDate } from "./periods";
import { isNumericAspect, isSingleDateClaim, quoteCorrectsSlot } from "./slots";
import { computeStrength } from "./strength";
import { aspectList, NOTE } from "./texts";
import type { ClaimWithFocus, VerdictDecision, VerdictInput } from "./types";

interface Outcome {
  verdict: Verdict;
  rule: number;
  basis: Ev[];
  missingContext?: string;
  conflicting?: { supporting: string[]; refuting: string[] };
  archival?: boolean;
  notes?: string[];
}

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const { claim, records } = input;
  const mine = input.assessments.filter((a) => a.claimId === claim.id).map((a) => {
    if (a.relation !== "CZESCIOWO" || records.get(a.recordId)?.role !== "tresc") return a;
    // Older readers overloaded this relation. A different value in the same numeric slot is
    // recoverable from their quote. A source covering fewer subjects is never a correction.
    const correction = a.partialMeaning === "correction" || (!a.partialMeaning && isNumericAspect(a.aspect)
      && !!quoteCorrectsSlot(claim.text, a.quote, a.aspect));
    return { ...a, partialMeaning: correction && a.verifier === "zgoda" ? "correction" as const : "coverage" as const };
  });

  const counted: Ev[] = [];
  for (const a of mine) {
    const r = records.get(a.recordId);
    if (!isCounted(a, r)) continue;
    const evidence = buildEv(a, r, isDecisive(a, r, mine, records));
    if (claim.temporal.asOf && (!evidence.period || !overlaps(parsePeriod(claim.temporal.asOf), evidence.period))) evidence.decisive = false;
    counted.push(evidence);
  }
  const vetoedCount = counted.filter((e) => e.a.verifier === "sprzeciw").length;
  const decisive = counted.filter((e) => e.decisive);

  const finish = (o: Outcome): VerdictDecision => {
    const basisIds = uniqueIds(o.basis);
    const below = uniqueIds(counted.filter((e) => !e.decisive));
    const notes = [...(o.notes ?? [])];
    if (o.rule === 2 && below.length > 0) notes.push(NOTE.belowThreshold(below.length));
    const strength = computeStrength({
      claim,
      now: input.now,
      rule: o.rule,
      verdict: o.verdict,
      basis: o.basis,
      counted,
      vetoedCount,
      singleKeyVerifier: input.singleKeyVerifier,
      archival: o.archival ?? false,
      extraNotes: notes,
    });
    const d: VerdictDecision = {
      verdict: o.verdict,
      ruleApplied: o.rule,
      strength,
      decisiveRecordIds: basisIds,
      archival: o.archival ?? false,
    };
    if (o.missingContext) d.missingContext = o.missingContext;
    if (o.conflicting) d.conflicting = o.conflicting;
    if (below.length > 0) d.belowThresholdRecordIds = below;
    return d;
  };

  // ── Reguła 1: opinia / prognoza ──
  if (claim.type === "opinia" || claim.type === "prognoza") {
    return finish({ verdict: "NIE_PODLEGA", rule: 1, basis: [], notes: [NOTE.opinion] });
  }

  // ── Reguła 2: brak dowodu rozstrzygającego ──
  if (decisive.length === 0) {
    return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [NOTE.noEvidence] });
  }

  // ── Reguła 3: jednorazowe zdarzenie z datą nowsze niż najnowszy dowód ──
  // „Nowsze” = najwcześniejszy możliwy dzień zdarzenia jest po najpóźniejszym możliwym dniu publikacji
  // KAŻDEGO dowodu rozstrzygającego (publikacja, a bez niej data pobrania). Brak dat → nie stosujemy.
  // Data zdarzenia to data, którą podaje samo twierdzenie (claims.ts odrzuca datę publikacji strony). Dowód, którego
  // zweryfikowany cytat wprost mówi o czasie zdarzenia lub późniejszym („przedłużone do 30 marca 2027 r.”), nie jest
  // „starszy niż zdarzenie” — wtedy reguła 3 nie działa (periods.ts → textCoversDate).
  if (claim.temporal.kind === "jednorazowe" && claim.temporal.date) {
    const event = parsePeriod(claim.temporal.date);
    const bounds = decisive.map(publicationUpperBound);
    const coveredByQuote = !!event && decisive.some((e) => e.a.quoteVerified && textCoversDate(e.a.quote, event));
    if (event && !coveredByQuote && bounds.every((b): b is number => b !== undefined)) {
      const newest = Math.max(...bounds);
      if (event.start > newest) {
        return finish({ verdict: "BRAK_DOWODOW", rule: 3, basis: decisive, notes: [NOTE.eventNewer] });
      }
    }
  }

  // ── Zastępowanie nieaktualnych dowodów (tylko twierdzenia o stanie „teraz”) ──
  // Dowód jest zastąpiony, gdy na ten sam aspekt istnieje rozstrzygający dowód URZĘDOWY (poziom 1, treść)
  // o innym kierunku (wspiera/obala), którego okres jest w całości PÓŹNIEJSZY, a data publikacji
  // (gdy obie znane) nie jest wcześniejsza. Nieznany okres nigdy nie jest „starszy” → zostaje (konflikt).
  const supersededBy = new Map<Ev, Ev>();
  if (claim.temporal.kind === "stan" && !claim.temporal.asOf) {
    for (const e of decisive) {
      const newer = decisive.find(
        (n) =>
          n !== e &&
          n.kind === "primary" &&
          n.aspect === e.aspect &&
          (n.polarity === "support" || n.polarity === "refute") &&
          n.polarity !== e.polarity &&
          strictlyAfter(n.period, e.period) &&
          !(n.published && e.published && n.published.end < e.published.start),
      );
      if (newer) supersededBy.set(e, newer);
    }
  }
  const active = decisive.filter((e) => !supersededBy.has(e));

  // ── Reguła 4: stan „teraz”, starsze WSPIERA, nowsze urzędowe OBALA ten sam aspekt ──
  if (claim.temporal.kind === "stan") {
    const r4Aspects = new Set<Aspect>();
    const r4Basis = new Set<Ev>();
    for (const [old, by] of supersededBy) {
      if (old.polarity !== "support" || by.polarity !== "refute" || !active.includes(by)) continue;
      // Gdy na ten aspekt zostaje aktualne WSPIERA, to nie jest „nieaktualne”, tylko sprzeczność (reguła 5).
      if (active.some((e) => e.aspect === old.aspect && e.polarity === "support")) continue;
      r4Aspects.add(old.aspect);
      r4Basis.add(old).add(by);
    }
    if (r4Aspects.size > 0) {
      const what = aspectList([...r4Aspects]);
      return finish({
        verdict: "WPROWADZAJACE",
        rule: 4,
        basis: [...r4Basis],
        archival: true,
        missingContext: `Informacja jest nieaktualna. Kiedyś była prawdziwa, ale nowsze dane urzędowe mówią co innego (dotyczy: ${what}).`,
        notes: [NOTE.archivalRule4],
      });
    }
  }
  const supersedeNotes = supersededBy.size > 0 ? [NOTE.superseded] : [];

  // ── Reguła 5: WSPIERA i OBALA ten sam aspekt ──
  // Pary rekord-o-stałej-roli ↔ źródło wtórne NIE tworzą sprzeczności: reguła 6 daje pierwszeństwo
  // rekordowi o stałej roli przed oceną czytelnika dla źródeł wtórnych.
  // Rozszerzenie zachowawcze: także okresy NIEnakładające się tworzą sprzeczność, jeśli reguła 4
  // (nieaktualność) jej nie wyjaśniła — kod nigdy nie wybiera zwycięzcy między źródłami na ten sam aspekt.
  const supportersInConflict = new Set<Ev>();
  const refutersInConflict = new Set<Ev>();
  let differentPeriods = false;
  for (const s of active) {
    if (s.polarity !== "support") continue;
    for (const r of active) {
      if (r.polarity !== "refute" || r.aspect !== s.aspect) continue;
      if (fixedVsSecondary(s, r)) continue;
      supportersInConflict.add(s);
      refutersInConflict.add(r);
      if (!overlaps(s.period, r.period)) differentPeriods = true;
    }
  }
  if (supportersInConflict.size > 0) {
    return finish({
      verdict: "BRAK_DOWODOW",
      rule: 5,
      basis: [...supportersInConflict, ...refutersInConflict],
      conflicting: { supporting: uniqueIds([...supportersInConflict]), refuting: uniqueIds([...refutersInConflict]) },
      notes: [NOTE.conflict, ...(differentPeriods ? [NOTE.conflictDifferentPeriods] : []), ...supersedeNotes],
    });
  }

  // ── Reguła 6: dopasowany rekord o stałej roli ──
  // Blokada: rozstrzygający dowód pierwotny na ten sam aspekt o innym kierunku („nowszy lub sprzeczny”).
  // Dodatkowo (zachowawczo): ocena POTWIERDZONE nie przechodzi, gdy dowód pierwotny obala lub częściowo
  // podważa JAKIKOLWIEK aspekt — tak samo jak reguła 7 nie potwierdza przy obalonym aspekcie.
  const primaries = active.filter((e) => e.kind === "primary");
  const eligibleFixed = active.filter(
    (f) =>
      f.kind === "fixed" &&
      f.fixedVerdict !== null &&
      !primaries.some((p) => p.aspect === f.aspect && p.polarity !== f.polarity),
  );
  if (eligibleFixed.length > 0) {
    const verdict = combineFixedVerdicts(eligibleFixed.map((f) => f.fixedVerdict as Verdict));
    const primaryUndermines = primaries.some((p) => p.polarity === "refute" || p.polarity === "partial");
    if (!(verdict === "POTWIERDZONE" && primaryUndermines)) {
      const o: Outcome = { verdict, rule: 6, basis: eligibleFixed, notes: [NOTE.fixedRole, ...supersedeNotes] };
      if (verdict === "WPROWADZAJACE") o.missingContext = fixedMissingContext(eligibleFixed);
      return finish(o);
    }
  }

  // ── Reguły 7–9 na aktywnych dowodach rozstrzygających ──
  const supportsSedno = active.some((e) => e.aspect === "sedno" && e.polarity === "support");
  const refutes = active.filter((e) => e.polarity === "refute");
  const partials = active.filter((e) => e.polarity === "partial");
  const anySedno = active.some((e) => e.aspect === "sedno" && e.polarity !== "none");

  // Reguła 7
  if (supportsSedno && refutes.length === 0 && partials.length === 0) {
    return finish({
      verdict: "POTWIERDZONE",
      rule: 7,
      basis: active.filter((e) => e.polarity === "support"),
      notes: supersedeNotes,
    });
  }

  // Reguła 8a: OBALA sedno
  if (refutes.some((e) => e.aspect === "sedno")) {
    return finish({ verdict: "FALSZYWE", rule: 8, basis: refutes, notes: supersedeNotes });
  }

  // Reguła 8b: „twierdzenie sprowadza się do obalonego aspektu” — opis w reductionToAspect niżej
  // i w docs/VERDICT-RULES.md („Szczegóły reguły 8”).
  const reduced = reductionToAspect(claim, active, anySedno);
  if (reduced) {
    return finish({
      verdict: "FALSZYWE",
      rule: 8,
      basis: reduced.basis,
      notes: [NOTE.reducesToSlot(reduced.aspect, reduced.claimVals, reduced.quoteVals), ...supersedeNotes],
    });
  }

  // Reguła 9
  if (refutes.length > 0 || partials.length > 0) {
    return finish({
      verdict: "WPROWADZAJACE",
      rule: 9,
      basis: active.filter((e) => e.polarity !== "none"),
      missingContext: rule9MissingContext(supportsSedno, refutes, partials),
      notes: supersedeNotes,
    });
  }

  // Zostały tylko dowody wspierające szczegóły (nie sedno) albo bez kierunku → brak rozstrzygnięcia sedna.
  return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [NOTE.onlyDetails] });
}

interface Reduction {
  aspect: Aspect;
  basis: Ev[];
  claimVals: string[];
  quoteVals: string[];
}

/**
 * Reguła 8b — twierdzenie sprowadza się do aspektu, który dowody rozstrzygające OBALAJĄ.
 *
 * Wspólne warunki (wszystkie muszą zajść):
 *  - są rozstrzygające OBALA i WSZYSTKIE dotyczą jednego aspektu A ≠ sedno (OBALA sedno = reguła 8a),
 *  - nie ma żadnego rozstrzygającego CZESCIOWO ani INNY_KONTEKST (na żaden aspekt). PLAN §4 reguła 9
 *    wprost kieruje je do WPROWADZAJĄCE; dane z ewaluacji to potwierdzają: B06 „pełnoskalowa inwazja
 *    w 2014” (wzorzec WPROWADZAJĄCE, bo w 2014 była aneksja Krymu) dostaje od czytelnika to samo co A03
 *    — CZESCIOWO/czas z innym rokiem — więc kod nie może z CZESCIOWO zrobić FAŁSZYWE,
 *  - nic nie wspiera aspektu A.
 *
 * Gdy ekstrakcja podała `claim.assertedAspect` (rozszerzenie, types.ts), ono rozstrzyga:
 *  - „sedno” → nigdy 8b (twierdzenie mówi, że zdarzenie zaszło; zła data to szczegół → reguła 9);
 *  - A = assertedAspect → 8b, także gdy coś WSPIERA sedno (sedno jest wtedy tylko tłem: „Polska jest
 *    w NATO” przy „Polska wstąpiła do NATO w 2004”); inny aspekt niż A → nie 8b.
 *
 * Bez pola (zachowawczo): A ∈ {czas, liczba}, brak jakiegokolwiek rozstrzygającego dowodu na sedno, oraz
 *  - czas: twierdzenie „jednej daty” (slots.ts: jedno zdanie bez spójników, ≤ 14 słów, ≤ 2 nazwy własne,
 *    dokładnie jeden rok i żadnej innej liczby; data może być względna — „wczoraj” — jeśli ekstrakcja ją
 *    ustaliła w `temporal.date`). Twierdzenie z kilkoma szczegółami i obaloną tylko datą → reguła 9;
 *  - liczba: cyfra w tekście (jak dotąd — twierdzenia liczbowe to zwykle sama liczba lub wyliczenie).
 */
function reductionToAspect(claim: ClaimWithFocus, active: Ev[], anySedno: boolean): Reduction | null {
  const focus = claim.assertedAspect;
  if (focus === "sedno") return null;
  if (active.some((e) => e.polarity === "partial")) return null;
  const refutes = active.filter((e) => e.polarity === "refute");
  if (refutes.length === 0) return null;
  const aspects = new Set(refutes.map((e) => e.aspect));
  if (aspects.size !== 1) return null;
  const aspect = [...aspects][0]!;
  if (aspect === "sedno") return null;
  if (active.some((e) => e.polarity === "support" && e.aspect === aspect)) return null;
  if (focus !== undefined) {
    if (focus !== aspect) return null;
  } else {
    if (!isNumericAspect(aspect) || anySedno) return null;
    if (aspect === "czas" && !isSingleDateClaim(claim.text, { resolvedDate: !!claim.temporal.date })) return null;
    if (aspect === "liczba" && !/\d/.test(claim.text)) return null;
  }
  // Notka: porównanie wartości przez kod (bez modeli), gdy cytat podaje inną datę/liczbę — tylko informacyjnie.
  let claimVals: string[] = [];
  let quoteVals: string[] = [];
  if (isNumericAspect(aspect)) {
    for (const e of refutes) {
      const c = quoteCorrectsSlot(claim.text, e.a.quote, aspect);
      if (c) {
        claimVals = c.claim;
        quoteVals = c.quote.slice(0, 3);
        break;
      }
    }
  }
  return { aspect, basis: refutes, claimVals, quoteVals };
}

function fixedVsSecondary(a: Ev, b: Ev): boolean {
  return (a.kind === "fixed" && b.kind === "secondary") || (a.kind === "secondary" && b.kind === "fixed");
}

/**
 * Kilka zgodnych co do kierunku rekordów o stałej roli (przeciwne kierunki odpadły w regule 5):
 * jedna wartość → ta wartość; oceny „bez werdyktu merytorycznego” (BRAK_DOWODOW, NIE_PODLEGA) ustępują
 * pozostałym; różne merytoryczne (np. FALSZYWE i WPROWADZAJACE, albo POTWIERDZONE na sedno i FALSZYWE
 * na inny aspekt) → WPROWADZAJACE (najostrożniejsze wspólne stwierdzenie).
 */
function combineFixedVerdicts(vs: Verdict[]): Verdict {
  const uniq = [...new Set(vs)];
  if (uniq.length === 1) return uniq[0]!;
  const merit = uniq.filter((v) => v !== "BRAK_DOWODOW" && v !== "NIE_PODLEGA");
  if (merit.length === 1) return merit[0]!;
  if (merit.length === 0) return "BRAK_DOWODOW";
  return "WPROWADZAJACE";
}

function fixedMissingContext(fixed: Ev[]): string {
  const ratings = [...new Set(fixed.map((f) => f.r.rating?.raw).filter(Boolean))];
  const nonSedno = fixed.map((f) => f.aspect).filter((a) => a !== "sedno");
  const where = nonSedno.length > 0 ? ` (dotyczy: ${aspectList(nonSedno)})` : "";
  const rated = ratings.length > 0 ? ` Ocena w bazie: „${ratings.join("”, „")}”.` : "";
  return `Fact-check wskazuje, że informacja jest podana bez ważnego kontekstu albo zniekształcona${where}.${rated}`;
}

function rule9MissingContext(supportsSedno: boolean, refutes: Ev[], partials: Ev[]): string {
  const refuted = [...new Set(refutes.map((e) => e.aspect))];
  const otherContext = partials.filter((e) => e.a.relation === "INNY_KONTEKST" && e.kind !== "fixed");
  const partly = partials.filter((e) => !otherContext.includes(e));
  const parts: string[] = [];
  if (refuted.length > 0) parts.push(`nie zgadza się: ${aspectList(refuted)}`);
  if (otherContext.length > 0) {
    parts.push(
      `materiał pochodzi z innej sytuacji (inny czas, miejsce lub kontekst; dotyczy: ${aspectList(otherContext.map((e) => e.aspect))})`,
    );
  }
  if (partly.length > 0) parts.push(`źródła wskazują błąd w szczególe informacji (dotyczy: ${aspectList(partly.map((e) => e.aspect))})`);
  const body = parts.join("; ");
  if (supportsSedno) return `Główna treść się zgadza, ale ${body}.`;
  if (refuted.length > 0 && partials.length === 0) {
    return `Nie zgadza się: ${aspectList(refuted)}. Źródła nie potwierdzają samej głównej treści.`;
  }
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}
