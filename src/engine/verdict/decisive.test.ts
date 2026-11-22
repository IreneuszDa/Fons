import { describe, expect, it } from "vitest";
import type { CorpusRecord, EvidenceAssessment } from "../../shared/contracts";
import { annotateDecisive, effectiveFixedVerdict, isDecisive } from "./decisive";
import { decideVerdict } from "./rules";
import { overlaps, parsePeriod, strictlyAfter } from "./periods";

function rec(id: string, over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id,
    sourceId: "s",
    url: "https://example.org/x",
    title: "t",
    publisher: "p",
    publishedAt: "2026-01-01",
    fetchedAt: "2026-02-01",
    lang: "pl",
    text: "x",
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: id,
    licence: "CC",
    topics: [],
    origin: "corpus",
    ...over,
  };
}

function asm(recordId: string, over: Partial<EvidenceAssessment> = {}): EvidenceAssessment {
  return {
    claimId: "c1",
    recordId,
    relation: "WSPIERA",
    aspect: "sedno",
    quote: "q",
    quoteVerified: true,
    quoteMatchScore: 100,
    verifier: "brak",
    decisive: false,
    ...over,
  };
}

describe("isDecisive", () => {
  it("pierwotne ze zweryfikowanym cytatem rozstrzyga", () => {
    const r = rec("a");
    const a = asm("a");
    expect(isDecisive(a, r, [a], new Map([["a", r]]))).toBe(true);
  });

  it("recordId niezgodny z rekordem → nie rozstrzyga", () => {
    const r = rec("a");
    const a = asm("b");
    expect(isDecisive(a, r, [a], new Map([["a", r]]))).toBe(false);
  });

  it("wtórne: drugi wtórny z innej grupy i tym samym kierunkiem → oba rozstrzygają", () => {
    const r1 = rec("a", { level: 3, independenceGroup: "g1" });
    const r2 = rec("b", { level: 3, independenceGroup: "g2" });
    const a1 = asm("a");
    const a2 = asm("b", { relation: "WSPIERA" });
    const m = new Map([
      ["a", r1],
      ["b", r2],
    ]);
    expect(isDecisive(a1, r1, [a1, a2], m)).toBe(true);
    expect(isDecisive(a2, r2, [a1, a2], m)).toBe(true);
  });

  it("two publishers reproducing one passage do not supply independent corroboration", () => {
    const text = "Raport zawiera dane z badania przeprowadzonego w styczniu. Zastosowano tę samą metodę pomiaru we wszystkich objętych nim gminach, a wyniki opublikowano w roczniku statystycznym za poprzedni rok.";
    const first = rec("first", { text, level: 3 });
    const copy = rec("copy", { text: text.toUpperCase().replaceAll(" ", "  "), level: 3 });
    const records = new Map([[first.id, first], [copy.id, copy]]);
    const assessments = [asm(first.id), asm(copy.id)];
    const decide = () => decideVerdict({
      claim: { id: "c1", text: "Raport uwzględnia wszystkie objęte badaniem gminy.", type: "fakt", isMain: true,
        temporal: { kind: "brak" }, inputOverlap: 1 },
      assessments, records, now: new Date("2026-11-22"), singleKeyVerifier: true,
    });
    expect(decide().verdict).toBe("BRAK_DOWODOW");
    first.level = 1;
    expect(decide()).toMatchObject({ verdict: "POTWIERDZONE", strength: { independentPublishers: 1 } });
  });

  it("wtórne: drugi rekord z innego twierdzenia się nie liczy", () => {
    const r1 = rec("a", { level: 3, independenceGroup: "g1" });
    const r2 = rec("b", { level: 3, independenceGroup: "g2" });
    const a1 = asm("a");
    const a2 = asm("b", { claimId: "c2" });
    const m = new Map([
      ["a", r1],
      ["b", r2],
    ]);
    expect(isDecisive(a1, r1, [a1, a2], m)).toBe(false);
  });

  it("wtórne: korekta szczegółu i inny kontekst mają ten sam kierunek", () => {
    const r1 = rec("a", { level: 3, independenceGroup: "g1" });
    const r2 = rec("b", { level: 3, independenceGroup: "g2" });
    const a1 = asm("a", { relation: "CZESCIOWO", partialMeaning: "correction" });
    const a2 = asm("b", { relation: "INNY_KONTEKST" });
    const m = new Map([
      ["a", r1],
      ["b", r2],
    ]);
    expect(isDecisive(a1, r1, [a1, a2], m)).toBe(true);
  });

  it("wtórne: rekord o stałej roli nie jest drugim źródłem wtórnym", () => {
    const r1 = rec("a", { level: 3, independenceGroup: "g1" });
    const r2 = rec("b", { level: 3, independenceGroup: "g2", role: "stala_rola", rating: { raw: "Prawda", mapped: "POTWIERDZONE", binary: true } });
    const a1 = asm("a");
    const a2 = asm("b", { fixedRoleMatch: "ta_sama" });
    const m = new Map([
      ["a", r1],
      ["b", r2],
    ]);
    expect(isDecisive(a1, r1, [a1, a2], m)).toBe(false);
  });

  it("annotateDecisive ustawia pole decisive i nie mutuje wejścia", () => {
    const r = rec("a");
    const input = [asm("a"), asm("missing")];
    const out = annotateDecisive(input, new Map([["a", r]]));
    expect(out.map((x) => x.decisive)).toEqual([true, false]);
    expect(input.every((x) => x.decisive === false)).toBe(true);
  });
});

describe("effectiveFixedVerdict", () => {
  const fc = (mapped: CorpusRecord["rating"]) => rec("f", { role: "stala_rola", level: 2, type: "factcheck", rating: mapped });
  it("ta_sama → ocena z tabeli", () => {
    expect(effectiveFixedVerdict(asm("f", { fixedRoleMatch: "ta_sama" }), fc({ raw: "Fałsz", mapped: "FALSZYWE", binary: true }))).toBe("FALSZYWE");
  });
  it("zaprzeczona odwraca tylko binarne", () => {
    expect(effectiveFixedVerdict(asm("f", { fixedRoleMatch: "zaprzeczona" }), fc({ raw: "Fałsz", mapped: "FALSZYWE", binary: true }))).toBe("POTWIERDZONE");
    expect(effectiveFixedVerdict(asm("f", { fixedRoleMatch: "zaprzeczona" }), fc({ raw: "Manipulacja", mapped: "WPROWADZAJACE", binary: false }))).toBeNull();
  });
  it("brak dopasowania → null", () => {
    expect(effectiveFixedVerdict(asm("f"), fc({ raw: "Fałsz", mapped: "FALSZYWE", binary: true }))).toBeNull();
  });
  it("rekord treści → null", () => {
    expect(effectiveFixedVerdict(asm("a", { fixedRoleMatch: "ta_sama" }), rec("a"))).toBeNull();
  });
});

describe("parsePeriod / overlaps / strictlyAfter", () => {
  const cases: [string, string, string][] = [
    ["2024", "2024-01-01", "2024-12-31"],
    ["2024-05", "2024-05-01", "2024-05-31"],
    ["2024-02", "2024-02-01", "2024-02-29"],
    ["2024-Q2", "2024-04-01", "2024-06-30"],
    ["Q4 2023", "2023-10-01", "2023-12-31"],
    ["2025-H2", "2025-07-01", "2025-12-31"],
    ["2024-05-12", "2024-05-12", "2024-05-12"],
    ["2024-05-12T10:00:00Z", "2024-05-12", "2024-05-12"],
    ["2023-2024", "2023-01-01", "2024-12-31"],
    ["2023–2025", "2023-01-01", "2025-12-31"],
    ["2024-01-01/2024-06-30", "2024-01-01", "2024-06-30"],
  ];
  it.each(cases)("%s", (raw, start, end) => {
    const r = parsePeriod(raw)!;
    expect(r).toBeDefined();
    expect(new Date(r.start).toISOString().slice(0, 10)).toBe(start);
    expect(new Date(r.end).toISOString().slice(0, 10)).toBe(end);
  });

  it("nieczytelne → undefined", () => {
    for (const s of ["", "wczoraj", "2024-13", "2024-02-30", "2025-2023", undefined, null]) {
      expect(parsePeriod(s as string | undefined)).toBeUndefined();
    }
  });

  it("nieznany okres nakłada się i nigdy nie jest późniejszy", () => {
    const y = parsePeriod("2024");
    expect(overlaps(undefined, y)).toBe(true);
    expect(strictlyAfter(undefined, y)).toBe(false);
    expect(strictlyAfter(y, undefined)).toBe(false);
    expect(overlaps(parsePeriod("2024"), parsePeriod("2024-Q3"))).toBe(true);
    expect(overlaps(parsePeriod("2023"), parsePeriod("2024"))).toBe(false);
    expect(strictlyAfter(parsePeriod("2025"), parsePeriod("2024-12"))).toBe(true);
  });
});
