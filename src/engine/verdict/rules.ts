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
 * Reguła 5 może udokumentować rozbieżność dwóch zweryfikowanych relacji o tej samej wielkości.
 * Pozostałe reguły od 3 w górę wymagają dowodów rozstrzygających (isDecisive).
 * Dowody poniżej progu wpływają tylko na siłę (strength.ts) i listę belowThresholdRecordIds.
 */
import { supportsMeasurement } from "./measurement-support";
import type { Aspect, Verdict } from "../../shared/contracts";
import { publicationAvailable } from "../publication-window";
import { preciseDateAssessment, refutesPriorMembership, requestedEventDay } from "../event-day";
import { asksForElectionRoundDate, publishedRoundDay } from "../election-result";
import { independentPublications, opposingReports } from "./conflict";
import { isCounted, isDecisive } from "./decisive";
import { buildEv, publicationUpperBound, uniqueIds, type Ev } from "./evidence";
import { enactedPeriodCovers, monthsBefore, overlaps, parsePeriod, strictlyAfter } from "./periods";
import { institutionalMeasure, isNumericAspect, isSingleDateClaim, quoteCorrectsSlot, sourceMeasureValues } from "./slots";
import { ARCHIVAL_MONTHS, computeStrength } from "./strength";
import { directlyStatesIntention, mentionsIntention } from "./intention";
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

const PRIOR_ACCOUNT = /(?<!\p{L})(?:wcześniejsz[\p{L}]*|ówczesn[\p{L}]*|dawniejsz[\p{L}]*|przed\s+laty|wówczas|at the time|at that time|years ago|previously)(?!\p{L})/iu;
const REPORTED_STATEMENT = /(?<!\p{L})(?:zdementowa[łl][\p{L}]*|zaprzecz[\p{L}]*|oświadcz[\p{L}]*|denied|refuted|announced)(?!\p{L})/iu;

function describesEarlierStatement(quote: string, cutoff: number): boolean {
  if (PRIOR_ACCOUNT.test(quote)) return true;
  if (!REPORTED_STATEMENT.test(quote)) return false;
  const years = quote.match(/\b(?:19|20)\d{2}\b/gu) ?? [];
  return years.length > 0 && years.every(year => Date.UTC(Number(year) + 1, 0, 1) <= cutoff);
}

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const { claim, records } = input;
  const day = requestedEventDay(claim);
  const mine = input.assessments.filter((a) => a.claimId === claim.id && publicationAvailable(records.get(a.recordId), input.now, claim.temporal.publishedBy)).map((a) => {
    a = preciseDateAssessment(day, a, records.get(a.recordId));
    if (refutesPriorMembership(claim, a, records.get(a.recordId))) return { ...a, aspect: "sedno" as const };
    if (day && !a.excluded && a.relation === "WSPIERA" && a.verifier !== "zgoda") return { ...a, excluded: "unconfirmed_event_day" };
    if (a.relation !== "CZESCIOWO" || records.get(a.recordId)?.role !== "tresc") return a;
    // Older readers overloaded this relation. A different value in the same numeric slot is
    // recoverable from their quote. A source covering fewer subjects is never a correction.
    const correction = a.partialMeaning === "correction" || (!a.partialMeaning && isNumericAspect(a.aspect)
      && !!quoteCorrectsSlot(claim.text, a.quote, a.aspect));
    return { ...a, partialMeaning: correction && a.verifier === "zgoda" ? "correction" as const : "coverage" as const };
  });

  const counted: Ev[] = [];
  const priorEventRecords = new Set<string>();
  const referencePeriod = claim.temporal.asOf ?? claim.temporal.date;
  const current = claim.type === "fakt" && claim.temporal.kind !== "jednorazowe"
    && (!referencePeriod || overlaps(parsePeriod(referencePeriod), parsePeriod(input.now.toISOString())));
  const currentIntention = current && mentionsIntention(claim.text);
  const needsCurrentReview = current && (claim.temporal.kind === "stan" || currentIntention);
  const reviewCutoff = monthsBefore(input.now, ARCHIVAL_MONTHS);
  for (const a of mine) {
    const r = records.get(a.recordId);
    if (!isCounted(a, r)) continue;
    const evidence = buildEv(a, r, isDecisive(a, r, mine, records));
    if (claim.temporal.asOf && (!evidence.period || !overlaps(parsePeriod(claim.temporal.asOf), evidence.period))) evidence.decisive = false;
    // A newly fetched copy preserves the historical rating but adds no observation of the current state.
    const undatedOrOld = !evidence.published || evidence.published.end < reviewCutoff || evidence.published.start > input.now.getTime();
    const outdatedRating = needsCurrentReview && evidence.kind === "fixed" && evidence.fixedVerdict !== null && undatedOrOld;
    const observedPeriod = parsePeriod(a.period ?? r.period);
    const historicalAccount = currentIntention && r.role === "tresc" && (undatedOrOld ||
      (observedPeriod && observedPeriod.end < reviewCutoff) || describesEarlierStatement(a.quote.normalize("NFC"), reviewCutoff));
    const indirectIntention = currentIntention && (r.role !== "tresc" || a.verifier !== "zgoda"
      || !directlyStatesIntention(claim.text, a.quote, a.relation));
    if (outdatedRating || historicalAccount || indirectIntention) {
      evidence.decisive = false;
      priorEventRecords.add(r.id);
    }
    counted.push(evidence);
  }
  const hasContextOnlyEvidence = priorEventRecords.size > 0;
  if (currentIntention && hasContextOnlyEvidence) {
    // A retrospective account must not act as the second publisher for one current secondary source.
    const timely = mine.filter(a => !priorEventRecords.has(a.recordId));
    for (const e of counted) if (e.decisive) e.decisive = isDecisive(e.a, e.r, timely, records);
  }
  const vetoedCount = mine.filter(a => a.verifier === "sprzeciw" && (a.excluded === "verifier_dissent" || isCounted(a, records.get(a.recordId)))).length;
  let decisive = counted.filter((e) => e.decisive);

  const finish = (o: Outcome): VerdictDecision => {
    const basisIds = uniqueIds(o.basis);
    const below = uniqueIds(counted.filter((e) => !e.decisive && !basisIds.includes(e.r.id)));
    const notes = [...(o.notes ?? [])];
    if (hasContextOnlyEvidence) notes.push(currentIntention ? NOTE.intentionEvidence : NOTE.historicalReview);
    if (o.rule === 2 && below.length > 0) notes.push(NOTE.belowThreshold(below.length));
    const strength = computeStrength({
      claim,
      now: input.now,
      rule: o.rule,
      verdict: o.verdict,
      basis: o.basis,
      counted: counted.filter(e => !priorEventRecords.has(e.r.id)),
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
    if (priorEventRecords.size) d.priorEventRecordIds = [...priorEventRecords];
    return d;
  };

  // ── Reguła 1: opinia / prognoza ──
  if (claim.type === "opinia" || claim.type === "prognoza") {
    return finish({ verdict: "NIE_PODLEGA", rule: 1, basis: [], notes: [NOTE.opinion] });
  }

  // ── Reguła 2: brak dowodu rozstrzygającego ──
  const comparisons = opposingReports(claim, mine, records);
  if (decisive.length === 0 && !comparisons.length) {
    return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [NOTE.noEvidence] });
  }

  // ── Reguła 3: jednorazowe zdarzenie z datą nowsze niż najnowszy dowód ──
  // „Nowsze” = najwcześniejszy możliwy dzień zdarzenia jest po najpóźniejszym możliwym dniu publikacji
  // KAŻDEGO dowodu rozstrzygającego (publikacja, a bez niej data pobrania). Brak dat → nie stosujemy.
  // Wcześniejsza zapowiedź nie relacjonuje przebiegu zdarzenia, nawet gdy podaje dokładną datę.
  // Wyjątek dotyczy opublikowanej decyzji określającej okres obowiązywania.
  if (claim.temporal.kind === "jednorazowe" && claim.temporal.date) {
    const event = parsePeriod(claim.temporal.date);
    if (event) {
      const eligible = counted.filter(e => {
        const bound = publicationUpperBound(e);
        if (bound === undefined || bound >= event.start) return true;
        if (e.kind !== "primary" || e.a.verifier !== "zgoda") return false;
        // Restrict the date check to the stated end of an enacted period. A later date
        // elsewhere in the paragraph, an announced vote, or a plan is insufficient.
        return enactedPeriodCovers(e.a.quote, event);
      });
      if (eligible.length < counted.length) {
        const timely = eligible.map(e => e.a);
        for (const e of counted) {
          if (!timely.includes(e.a)) priorEventRecords.add(e.r.id);
          e.decisive = e.decisive && !priorEventRecords.has(e.r.id) && isDecisive(e.a, e.r, timely, records);
        }
        decisive = counted.filter(e => e.decisive);
        if (!decisive.length && !comparisons.some(pair => !priorEventRecords.has(pair.supporting) && !priorEventRecords.has(pair.refuting))) return finish({ verdict: "BRAK_DOWODOW", rule: 3, basis: [], notes: [NOTE.eventNewer] });
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
  const active = decisive.filter((e) => !supersededBy.has(e) && !e.a.historicalSupport);

  // ── Reguła 4: stan „teraz”, starsze WSPIERA, nowsze urzędowe OBALA ten sam aspekt ──
  if (claim.temporal.kind === "stan") {
    const r4Aspects = new Set<Aspect>();
    const r4Basis = new Set<Ev>();
    // A retrospective entry documents a prior value. It cannot confirm the present by itself.
    for (const old of counted) {
      const historicalRating = !currentIntention && priorEventRecords.has(old.r.id) && old.kind === "fixed" && old.polarity === "support"
        && !!old.published && old.published.end < reviewCutoff;
      const historicalPrimary = old.decisive && old.kind === "primary" && old.a.historicalSupport;
      if (claim.temporal.asOf || old.a.verifier !== "zgoda" || (!historicalPrimary && !historicalRating)) continue;
      const prior = historicalRating ? old.period : parsePeriod(old.a.period);
      if (!prior || prior.end >= input.now.getTime()) continue;
      if (active.some(e => e.aspect === old.aspect && e.polarity === "support")) continue;
      const current = active.find(e => e !== old && e.kind === "primary" && e.aspect === old.aspect
        && e.polarity === "refute" && e.a.verifier === "zgoda" && strictlyAfter(e.period, prior)
        && (!historicalRating || (e.period && e.period.start <= input.now.getTime() && e.period.end >= reviewCutoff)));
      if (current) {
        r4Aspects.add(old.aspect);
        r4Basis.add(old).add(current);
      }
    }
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
        missingContext: `Informacja jest nieaktualna. Kiedyś była prawdziwa, ale nowsze dane źródłowe mówią co innego (dotyczy: ${what}).`,
        notes: [NOTE.archivalRule4],
      });
    }
  }
  const supersedeNotes = supersededBy.size > 0 ? [NOTE.superseded] : [];

  // ── Reguła 5: WSPIERA i OBALA ten sam aspekt ──
  // Pary rekord-o-stałej-roli ↔ źródło wtórne NIE tworzą sprzeczności: reguła 6 daje pierwszeństwo
  // rekordowi o stałej roli przed oceną czytelnika dla źródeł wtórnych.
  const supportersInConflict = new Set<Ev>();
  const refutersInConflict = new Set<Ev>();
  let incomparable = false;
  const byId = new Map(counted.map(e => [e.r.id, e]));
  for (const pair of comparisons) {
    const s = byId.get(pair.supporting)!;
    const r = byId.get(pair.refuting)!;
    if ([s, r].some(e => priorEventRecords.has(e.r.id) || supersededBy.has(e))) continue;
    supportersInConflict.add(s);
    refutersInConflict.add(r);
  }
  for (const s of active) {
    if (s.polarity !== "support") continue;
    for (const r of active) {
      if (r.polarity !== "refute" || r.aspect !== s.aspect) continue;
      if (fixedVsSecondary(s, r)) continue;
      // Publication dates can differ even when both sources describe the same event.
      // Compare the periods attached to the data, as distinct from the fallback used for freshness.
      const supportPeriod = parsePeriod(s.a.period ?? s.r.period);
      const refutePeriod = parsePeriod(r.a.period ?? r.r.period);
      if (!independentPublications(s.r, r.r) || !overlaps(supportPeriod, refutePeriod)) {
        incomparable = true;
        continue;
      }
      supportersInConflict.add(s);
      refutersInConflict.add(r);
    }
  }
  if (supportersInConflict.size > 0) {
    // The live index and the local corpus may return the very same passage.
    const distinctPassages = (side: Set<Ev>) => {
      const seen = new Set<string>();
      return [...side].filter(e => {
        const key = `${e.r.url.split("#")[0]}\n${e.a.quote.trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const supporting = distinctPassages(supportersInConflict);
    const refuting = distinctPassages(refutersInConflict);
    return finish({
      verdict: "BRAK_DOWODOW",
      rule: 5,
      basis: [...supporting, ...refuting],
      conflicting: { supporting: uniqueIds(supporting), refuting: uniqueIds(refuting) },
      notes: [NOTE.conflict, ...supersedeNotes],
    });
  }

  // An uncertain reading cannot establish a conflict. Nor can the more authoritative
  // publisher settle this specific dispute while its own reading remains uncertain.
  const unconfirmedPair = opposingReports(claim, mine, records, true).some(pair => {
    const s = byId.get(pair.supporting);
    const r = byId.get(pair.refuting);
    return s && r && [s, r].every(e => !priorEventRecords.has(e.r.id) && !supersededBy.has(e))
      && [s, r].some(e => e.a.verifier === "niepewne" || e.a.verifier === "brak");
  });
  if (unconfirmedPair) return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [NOTE.unconfirmedPair] });
  if (incomparable) return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [],
    notes: [NOTE.incomparable] });
  if (!active.length) return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [NOTE.noEvidence] });

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

  // A single round has one occurrence date. A passage about the other round
  // can provide context without making an explicitly wrong date partly true.
  if (day && asksForElectionRoundDate(claim.text)) {
    const readings = active.filter(e => e.kind === "primary" && e.a.verifier === "zgoda")
      .map(e => ({ e, date: publishedRoundDay(claim.text, e.a.quote, e.r) }))
      .filter(({ date }) => date?.slice(0, 4) === day.slice(0, 4));
    const dates = new Set(readings.map(r => r.date));
    if (dates.size === 1) {
      const matches = (readings[0]!.date === day) !== /\bnie\b/iu.test(claim.text);
      const basis = readings.filter(({ e }) => e.polarity === (matches ? "support" : "refute")).map(r => r.e);
      const opposed = active.some(e => e.polarity === (matches ? "refute" : "support"));
      if (basis.length && !opposed) return finish({ verdict: matches ? "POTWIERDZONE" : "FALSZYWE",
        rule: matches ? 7 : 8, basis, notes: supersedeNotes });
    }
  }

  // In a single, exact headcount the number is the entire assertion. A matching
  // number for a different unit, an article number, or an unverified reading cannot resolve it.
  const measure = institutionalMeasure(claim.text);
  if (measure?.kind === "count" && !partials.length && active.every(e => e.kind === "primary" || e.kind === "secondary")) {
    const checked = active.filter(e => e.a.verifier === "zgoda" && (e.aspect === "liczba" || e.aspect === "sedno"))
      .flatMap(e => sourceMeasureValues(measure, e.a.quote, e.r.sourceId === "sejm-eli").map(value => ({ e, value })));
    const value = checked[0]?.value;
    if (value !== undefined && checked.every(c => c.value === value)) {
      const supports = (value === measure.value) !== !!measure.negated;
      const direction = supports ? "support" : "refute";
      const basis = checked.map(c => c.e);
      const enough = basis.some(e => e.kind === "primary") || new Set(basis.map(e => e.r.independenceGroup)).size >= 2;
      if (enough && active.every(e => e.polarity === direction)) {
        return finish({ verdict: supports ? "POTWIERDZONE" : "FALSZYWE", rule: supports ? 7 : 8, basis,
          notes: [...supersedeNotes, `Kod porównał liczbę dla tego samego podmiotu i jednostki. Źródło podaje ${value}.`] });
      }
    }
    return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [
      "Brakuje zgodnego odczytu liczby dla tego samego podmiotu i tej samej jednostki.",
    ] });
  }

  // Reguła 7
  const supportsDay = day && claim.assertedAspect === "czas" && active.some(e => e.polarity === "support" && e.aspect === "czas");
  if ((supportsSedno || supportsDay || active.some(e => supportsMeasurement(claim, e, input.now))) && refutes.length === 0 && partials.length === 0) {
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
  if (!anySedno && !partials.length && refutes.length > 0 && refutes.every(e => isNumericAspect(e.aspect))
      && institutionalMeasure(claim.text)) {
    return finish({ verdict: "BRAK_DOWODOW", rule: 2, basis: [], notes: [
      "Nie ustalono sprzecznej wartości dla tego samego podmiotu i tej samej miary.",
    ] });
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
  const measure = institutionalMeasure(claim.text);
  if (measure && isNumericAspect(aspect)) {
    // Readers label a term of office as either a number or a time. Resolve this
    // ambiguity only with a verified, explicit value for that office and measure.
    if (focus && !isNumericAspect(focus)) return null;
    if (active.some(e => e.polarity === "support" && (e.aspect === "sedno" || isNumericAspect(e.aspect)))) return null;
    const sameSlot = refutes.filter(e => e.kind === "primary" && e.a.verifier === "zgoda")
      .map(e => ({ e, values: sourceMeasureValues(measure, e.a.quote, e.r.sourceId === "sejm-eli") }));
    const values = new Set(sameSlot.flatMap(hit => hit.values));
    if (values.size !== 1 || values.has(measure.value) || !sameSlot.every(hit => hit.values.length === 1)) return null;
    return { aspect: "liczba", basis: sameSlot.map(hit => hit.e), claimVals: [String(measure.value)], quoteVals: [...values].map(String) };
  }
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
