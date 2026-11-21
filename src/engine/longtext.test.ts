/**
 * Długie teksty (artykuł, transkrypcja), twierdzenia złożone (kilka podmiotów) i twierdzenia w obcym języku.
 */
import { describe, expect, it } from "vitest";
import type { Claim, StrengthCard } from "../shared/contracts";
import {
  MAX_CHECK_UNITS,
  MAX_CLAIMS,
  MAX_CLAIMS_LONG,
  buildClaimsPrompt,
  checkUnits,
  claimLimitFor,
  postProcessClaims,
  roleQueryFor,
  validParts,
} from "./claims";
import { buildCompoundReasonPl, buildSummaryPl, firstSentencePl, tallyPl } from "./justify";
import { MAX_TEXT_CHARS, cleanTranscript } from "./normalize";
import { aggregateCompound, aggregateVerdict, type PartOutcome } from "./verdict/compound";

type RawClaim = Parameters<typeof postProcessClaims>[0]["claims"][number];
const EMPTY_Q = { searchPl: [], searchEn: "", entities: [], aboutPresent: false };
function raw(text: string, o: Partial<RawClaim> = {}): RawClaim {
  return {
    text,
    type: "fakt",
    isMain: false,
    temporalKind: "jednorazowe",
    date: null,
    keywordsPl: [],
    keywordEn: text,
    lemmasPl: [],
    entities: [],
    sourceText: "",
    parts: [],
    assertedAspect: null,
    ...o,
  };
}
const out = (claims: RawClaim[]) => ({ inputMode: "claim" as const, claims, question: EMPTY_Q });

const SENTENCES = [
  "Polska wstąpiła do NATO 12 marca 1999 roku.",
  "Inflacja w Polsce wyniosła w październiku 25 procent.",
  "Rząd podniósł podatek VAT na żywność do 8 procent.",
  "Minimalne wynagrodzenie wynosi 4806 zł brutto.",
  "Szwecja jest członkiem NATO od marca 2024 roku.",
  "Ukraina otrzymała status kandydata do Unii Europejskiej w czerwcu 2022 roku.",
  "Litwa przystąpiła do Unii Europejskiej w 2004 roku.",
  "Kadencja Sejmu trwa cztery lata.",
];
const ARTICLE = Array.from({ length: 12 }, (_, i) => `${SENTENCES[i % SENTENCES.length]} Akapit ${i + 1} opisuje szczegóły sprawy, opinie komentatorów i reakcje polityków.`).join("\n\n");

describe("limit twierdzeń zależny od długości tekstu", () => {
  it("krótka wiadomość: 3, długi tekst: 6 — i polecenie mówi modelowi o limicie", () => {
    expect(ARTICLE.length).toBeGreaterThan(1500);
    expect(claimLimitFor("Polska wstąpiła do NATO w 1999 roku.")).toBe(MAX_CLAIMS);
    expect(claimLimitFor(ARTICLE)).toBe(MAX_CLAIMS_LONG);
    expect(buildClaimsPrompt(ARTICLE)).toContain("LIMIT: najwyżej 6");
    expect(buildClaimsPrompt(ARTICLE)).toContain("Tekst jest długi");
    expect(buildClaimsPrompt("Polska wstąpiła do NATO w 1999 roku.")).toContain("LIMIT: najwyżej 3");
  });

  it("z długiego tekstu bierze do 6 twierdzeń, z krótkiego do 3", () => {
    const claims = SENTENCES.map((s, i) => raw(s, { isMain: i === 0 }));
    const long = postProcessClaims(out(claims), ARTICLE);
    expect(long.claims).toHaveLength(6);
    expect(long.claimLimit).toBe(6);
    const short = postProcessClaims(out(claims), SENTENCES.join(" "));
    expect(short.claims).toHaveLength(3);
  });

  it("limit znaków dla wklejonego tekstu mieści cały artykuł", () => {
    expect(MAX_TEXT_CHARS).toBeGreaterThanOrEqual(20000);
  });
});

describe("twierdzenie w języku wiadomości (RT-04)", () => {
  const UA = "Україна є членом НАТО.";
  it("przetłumaczone twierdzenie → dosłowny fragment wejścia (po ukraińsku) zamiast odrzucenia", () => {
    const r = postProcessClaims(out([raw("Ukraina jest członkiem NATO.", { isMain: true, sourceText: UA })]), UA);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.claim.text).toBe(UA);
    expect(r.rejected).toHaveLength(0);
  });

  it("fragment, którego nie ma we wejściu, nie ratuje podmienionego twierdzenia", () => {
    const r = postProcessClaims(
      out([raw("Rakiety spadły na stolicę sąsiedniego kraju.", { isMain: true, sourceText: "Rakiety spadły na stolicę." })]),
      UA,
    );
    expect(r.claims).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("części twierdzenia o kilku podmiotach", () => {
  const PARENT = "Polska i Litwa wstąpiły do NATO w 1999 roku.";
  it("części w słowach rodzica są przyjmowane", () => {
    expect(validParts(PARENT, ["Polska wstąpiła do NATO w 1999 roku.", "Litwa wstąpiła do NATO w 1999 roku."])).toHaveLength(2);
  });

  it("część z nową liczbą albo nowym faktem → twierdzenie sprawdzane w całości", () => {
    expect(validParts(PARENT, ["Polska wstąpiła do NATO w 1999 roku.", "Litwa wstąpiła do NATO w 2004 roku."])).toEqual([]);
    expect(validParts(PARENT, ["Polska wstąpiła do NATO w 1999 roku.", "Rakiety spadły na stolicę sąsiedniego kraju."])).toEqual([]);
    expect(validParts(PARENT, ["Polska wstąpiła do NATO w 1999 roku."])).toEqual([]); // jedna część to nie podział
  });

  it("postProcess tworzy części z własnymi id i terminami; checkUnits sprawdza części zamiast rodzica", () => {
    const r = postProcessClaims(
      out([
        raw(PARENT, {
          isMain: true,
          entities: ["Polska | Poland", "Litwa | Lithuania", "NATO", "1999"],
          parts: ["Polska wstąpiła do NATO w 1999 roku.", "Litwa wstąpiła do NATO w 1999 roku."],
        }),
      ]),
      PARENT,
    );
    const c = r.claims[0]!;
    expect(c.parts.map((p) => p.claim.id)).toEqual(["c1p1", "c1p2"]);
    expect(c.parts[1]!.mustHave).toEqual(expect.arrayContaining(["Litwa | Lithuania", "NATO", "1999"]));
    expect(c.parts[1]!.mustHave).not.toContain("Polska | Poland");
    expect(checkUnits(r.claims).map((u) => u.claim.id)).toEqual(["c1p1", "c1p2"]);
  });

  it("budżet jednostek: części tylko dopóki twierdzenia + części mieszczą się w limicie", () => {
    const four = (s: string) => ["A", "B", "C", "D"].map((x) => `${x} ${s}`);
    const base = "członkiem NATO od 1999 roku jest państwo";
    const claims = Array.from({ length: 3 }, (_, i) =>
      raw(`A, B, C i D ${base} ${i}.`, { isMain: i === 1, parts: four(`${base} ${i}.`) }),
    );
    const input = claims.map((c) => c.text).join(" ") + " " + ARTICLE;
    const r = postProcessClaims(out(claims), input);
    // 3 twierdzenia + 3 dodatkowe jednostki głównego = 6; drugie rozbicie (+3) przekroczyłoby limit 8.
    expect(r.claims[1]!.parts).toHaveLength(4); // główne twierdzenie ma pierwszeństwo
    expect(r.claims[0]!.parts).toHaveLength(0);
    expect(r.claims[2]!.parts).toHaveLength(0);
    const units = checkUnits(r.claims);
    expect(units.length).toBeLessThanOrEqual(MAX_CHECK_UNITS);
    expect(units[0]!.claim.id).toBe("c2p1"); // jednostki głównego twierdzenia idą pierwsze (budżet wyszukiwania na żywo)
  });
});

describe("czyszczenie transkrypcji", () => {
  it("napisy SRT → ciągły tekst bez numerów i znaczników czasu", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nDzień dobry, dzisiaj powiem wam\n\n2\n00:00:04,500 --> 00:00:08,000\nże Polska wstąpiła do NATO\n\n3\n00:00:08,500 --> 00:00:10,000\nw 2004 roku [muzyka]";
    expect(cleanTranscript(srt)).toBe("Dzień dobry, dzisiaj powiem wam że Polska wstąpiła do NATO w 2004 roku");
  });

  it("transkrypcja z YouTube (czas w osobnych liniach) → jedno zdanie zamiast urywków", () => {
    const yt = ["0:00", "Dzień dobry wszystkim", "0:03", "dzisiaj o tym że inflacja", "0:06", "w Polsce wynosi 25 procent", "0:09", "a rząd to ukrywa"].join("\n");
    expect(cleanTranscript(yt)).toBe("Dzień dobry wszystkim dzisiaj o tym że inflacja w Polsce wynosi 25 procent a rząd to ukrywa");
  });

  it("mówcy zostają, znaczniki czasu w nawiasach znikają", () => {
    expect(cleanTranscript("[00:12] Jan Kowalski: Polska wstąpiła do NATO w 1999 roku.\n[00:15] Anna Nowak: To prawda.")).toBe(
      "Jan Kowalski: Polska wstąpiła do NATO w 1999 roku.\nAnna Nowak: To prawda.",
    );
  });

  it("zwykły tekst (także z jedną godziną na początku linii) zostaje bez zmian", () => {
    const plain = "Rząd podniósł VAT do 8%. Spotkanie o 12:30 w Sejmie.\nDrugi akapit.";
    expect(cleanTranscript(plain)).toBe(plain);
    const agenda = "Plan dnia:\n12:30 – początek obrad Sejmu.\nKoniec.";
    expect(cleanTranscript(agenda)).toBe(agenda);
  });
});

function card(score: number | null, level: StrengthCard["level"] = "mocna"): StrengthCard {
  return {
    level,
    score,
    factors: [{ effect: "plus", textPl: `czynnik ${score}` }],
    primarySources: 1,
    independentPublishers: 1,
    newestEvidenceAt: null,
    archivalWarning: false,
    verifierAgreement: "zgoda",
    notes: [],
  };
}
function claim(id: string, text: string): Claim {
  return { id, text, type: "fakt", isMain: false, temporal: { kind: "jednorazowe" }, inputOverlap: 1 };
}
const part = (id: string, text: string, verdict: PartOutcome["verdict"], score: number | null, rule = 7, reason = "Powód."): PartOutcome => ({
  claim: claim(id, text),
  verdict,
  ruleApplied: rule,
  strength: card(score),
  reasonPl: reason,
});

describe("łączenie werdyktów części", () => {
  it.each([
    [["POTWIERDZONE", "POTWIERDZONE"], "POTWIERDZONE"],
    [["POTWIERDZONE", "FALSZYWE"], "WPROWADZAJACE"],
    [["FALSZYWE", "FALSZYWE"], "FALSZYWE"],
    [["FALSZYWE", "BRAK_DOWODOW"], "FALSZYWE"],
    [["POTWIERDZONE", "BRAK_DOWODOW"], "BRAK_DOWODOW"],
    [["BRAK_DOWODOW", "BRAK_DOWODOW"], "BRAK_DOWODOW"],
    [["WPROWADZAJACE", "POTWIERDZONE"], "WPROWADZAJACE"],
    [["NIE_PODLEGA", "POTWIERDZONE"], "POTWIERDZONE"],
    [["NIE_PODLEGA", "NIE_PODLEGA"], "NIE_PODLEGA"],
  ] as const)("%j → %s", (parts, expected) => {
    expect(aggregateVerdict([...parts])).toBe(expected);
  });

  it("siła całości = najsłabsza część; mieszanka prawda/fałsz → reguła 9", () => {
    const a = aggregateCompound([part("p1", "Polska wstąpiła do NATO w 1999 roku.", "POTWIERDZONE", 90), part("p2", "Litwa wstąpiła do NATO w 1999 roku.", "FALSZYWE", 86, 8)]);
    expect(a.verdict).toBe("WPROWADZAJACE");
    expect(a.ruleApplied).toBe(9);
    expect(a.strength.score).toBe(86);
    expect(a.strength.factors?.[0]?.textPl).toContain("2 podmiotów");
    const b = aggregateCompound([part("p1", "A.", "POTWIERDZONE", 90), part("p2", "B.", "BRAK_DOWODOW", null, 2)]);
    expect(b.verdict).toBe("BRAK_DOWODOW");
    expect(b.ruleApplied).toBe(2);
    expect(b.strength.score).toBeNull();
    expect(b.strength.level).toBe("slaba");
  });

  it("uzasadnienie zaczyna się od nazwania błędnej części", () => {
    const parts = [
      part("p1", "Polska wstąpiła do NATO w 1999 roku.", "POTWIERDZONE", 90, 7, "Potwierdza to źródło urzędowe."),
      part("p2", "Litwa wstąpiła do NATO w 1999 roku.", "FALSZYWE", 86, 8, "Przeczy temu źródło urzędowe."),
    ];
    const text = buildCompoundReasonPl("WPROWADZAJACE", parts);
    expect(firstSentencePl(text)).toBe(
      "Twierdzenie jest prawdziwe tylko częściowo: „Litwa wstąpiła do NATO w 1999 roku” to nieprawda, a „Polska wstąpiła do NATO w 1999 roku” — prawda.",
    );
    expect(text).toContain("„Litwa wstąpiła do NATO w 1999 roku” — Fałszywe. Przeczy temu źródło urzędowe.");
  });
});

describe("podsumowanie wielu twierdzeń", () => {
  it("zestawienie ocen z poprawną odmianą", () => {
    expect(tallyPl(["FALSZYWE", "FALSZYWE", "POTWIERDZONE", "BRAK_DOWODOW", "BRAK_DOWODOW"])).toBe(
      "Sprawdziliśmy 5 twierdzeń: 2 fałszywe, 1 potwierdzone, 2 bez wystarczających dowodów — ocena każdego jest poniżej.",
    );
    expect(tallyPl(["POTWIERDZONE", "POTWIERDZONE", "POTWIERDZONE", "POTWIERDZONE", "POTWIERDZONE"])).toContain("5 potwierdzonych");
  });

  it("długi tekst: podsumowanie mówi, że wybraliśmy najważniejsze twierdzenia", () => {
    const s = buildSummaryPl({ verdict: "FALSZYWE", reasonPl: "Przeczy temu źródło urzędowe." }, 2, {
      allVerdicts: ["FALSZYWE", "POTWIERDZONE", "BRAK_DOWODOW"],
      selectedFromLong: true,
    });
    expect(s).toContain("Sprawdziliśmy 3 twierdzenia: 1 fałszywe, 1 potwierdzone, 1 bez wystarczających dowodów");
    expect(s).toContain("wybraliśmy z niego najważniejsze twierdzenia");
    expect(s).not.toContain("W wiadomości są też inne twierdzenia");
  });
});

describe("zapytanie o funkcję bez nazwiska", () => {
  it("usuwa nazwiska osób, zostawia funkcję i nazwy instytucji", () => {
    expect(roleQueryFor("Prezydentem Polski jest Donald Tusk.")).toEqual({ query: "Prezydentem Polski jest", names: ["Donald Tusk"] });
    expect(roleQueryFor("Ministrem obrony narodowej jest Władysław Kosiniak-Kamysz.")?.names).toEqual(["Władysław Kosiniak-Kamysz"]);
    expect(roleQueryFor("Marszałkiem Sejmu jest Włodzimierz Czarzasty.")?.query).toBe("Marszałkiem Sejmu jest");
    expect(roleQueryFor("Donald Tusk jest Prezesem Rady Ministrów.")?.query).toBe("jest Prezesem Rady Ministrów.");
  });

  it("bez nazwiska osoby (instytucje, państwa) albo bez treści po usunięciu → null", () => {
    expect(roleQueryFor("Ukraina otrzymała status kraju kandydującego do Unii Europejskiej w czerwcu 2022 roku.")).toBeNull();
    expect(roleQueryFor("Donald Tusk jest.")).toBeNull();
  });

  it("nie pomija nazwiska przy sprawdzaniu czynności lub wypowiedzi osoby publicznej", () => {
    expect(roleQueryFor("Prezydent Karol Nawrocki podpisał ustawę o ochronie ludności.")).toBeNull();
    expect(roleQueryFor("Donald Tusk powiedział, że prezydentem jest Karol Nawrocki.")).toBeNull();
  });
});
