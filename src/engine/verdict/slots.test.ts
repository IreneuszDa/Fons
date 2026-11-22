import { describe, expect, it } from "vitest";
import { extractSlots, institutionalMeasure, isSingleDateClaim, quoteCorrectsSlot, sourceMeasureValues } from "./slots";

describe("jedna liczba przypisana wskazanej instytucji", () => {
  it.each([
    ["Czy kadencja Sejmu trwa 5 lat?", "Art. 98. 1. Sejm i Senat są wybierane na czteroletnie kadencje.", true, [4]],
    ["Kadencja zarządu trwa 2 lata.", "Zarząd jest wybierany na sześcioletnią kadencję.", true, [6]],
    ["Kadencja Senatu trwa 5 lat.", "Komitet jest wybierany na sześcioletnią kadencję.", true, []],
    ["Senat RP liczy 150 senatorów.", "Art. 97. 1. Senat składa się ze 100 senatorów.", true, [100]],
    ["Senat RP liczy 150 senatorów.", "Senat składa się ze 100 senatorów.", false, []],
    ["Komitet liczy 15 członków.", "Komitet liczy 15 członków. Rada liczy 25 członków.", false, [15]],
    ["Komitet liczy 15 członków.", "Komitet liczy 36 obserwatorów.", false, []],
    ["Komitet liczy 15 członków.", "Komitet osiedlowy liczy 36 członków.", false, []],
    ["Komitet liczy 15 członków.", "Komitet nie liczy 36 członków.", false, []],
    ["Komitet liczy 15 członków.", "Czy komitet liczy 36 członków? Komitet liczy 28 członków?", false, []],
    ["Kadencja Senatu trwa 5 lat.", "Dawniej Sejm i Senat są wybierane na czteroletnie kadencje.", true, []],
    ["Komitet liczy 15 członków.", "Komitet liczy 36 członków, o ile obradują wszystkie delegacje.", false, []],
  ] as const)("%s ↔ %s", (claim, quote, legal, expected) => {
    expect(sourceMeasureValues(institutionalMeasure(claim)!, quote, legal)).toEqual(expected);
  });
});

describe("extractSlots — lata i wartości", () => {
  it.each([
    ["Polska wstąpiła do NATO w 2004 roku.", ["2004"], []],
    ["Ustawa weszła w życie 1 stycznia 2025.", ["2025"], []],
    ["on 12 March 1999 they joined", ["1999"], []],
    ["March 12, 1999", ["1999"], []],
    ["12.03.1999 r.", ["1999"], []],
    ["2024-06-30", ["2024"], []],
    ["W 2024 roku inflacja wyniosła 15,5 procent.", ["2024"], [15.5]],
    ["38 mln mieszkańców", [], [38e6]],
    ["38 000 000 osób", [], [38e6]],
    ["2,5 mld zł", [], [2.5e9]],
    ["Kadencja trwa 5 lat.", [], [5]],
  ] as const)("%s", (text, years, values) => {
    const s = extractSlots(text);
    expect(s.years).toEqual(years);
    expect(s.values).toEqual(values);
  });
});

describe("isSingleDateClaim — twierdzenie „jednej daty”", () => {
  it.each([
    ["Polska wstąpiła do NATO w 2004 roku.", true],
    ["W 2004 roku Polska wstąpiła do NATO.", true],
    ["Lech Wałęsa został prezydentem Polski w 1990 roku.", true],
    ["Ustawa weszła w życie 1 stycznia 2025.", true],
    ["Rosja rozpoczęła pełnoskalową inwazję na Ukrainę w 2014 roku.", true], // ten sam kształt co A03 — rozróżnia czytelnik
    ["Wczoraj w Krakowie była powódź.", false], // brak roku w tekście (bez resolvedDate)
    ["Polska wstąpiła do NATO w 2004 roku, razem z Litwą i Łotwą.", false], // przecinek
    ["Polska wstąpiła do NATO i UE w 2004 roku.", false], // spójnik „i”
    ["Na szczycie NATO w Madrycie w 1999 roku Polskę zaproszono do rozmów.", false], // 3 nazwy
    ["W 2004 roku do NATO wstąpiło 7 państw.", false], // jest też liczba
    ["Polska była w NATO w 2004 roku już od 1999 roku.", false], // dwa lata
    ["Pierwsza tura wyborów odbyła się 18 maja.", false], // data bez roku i bez resolvedDate
  ] as const)("%s → %s", (text, want) => {
    expect(isSingleDateClaim(text)).toBe(want);
  });

  it("data względna („wczoraj”, „18 maja”) liczy się jako jedna data tylko z resolvedDate", () => {
    expect(isSingleDateClaim("Wczoraj w Krakowie była powódź.", { resolvedDate: true })).toBe(true);
    expect(isSingleDateClaim("Pierwsza tura wyborów odbyła się 18 maja.", { resolvedDate: true })).toBe(true);
    expect(isSingleDateClaim("Polska wstąpiła do NATO w 2004 roku.", { resolvedDate: true })).toBe(true);
    expect(isSingleDateClaim("W 2004 roku do NATO wstąpiło 7 państw.", { resolvedDate: true })).toBe(false);
  });

  it("dzień i miesiąc bez roku to data, nie wartość liczbowa", () => {
    expect(extractSlots("Pierwsza tura odbyła się 18 maja.")).toEqual({ years: [], values: [] });
  });
});

describe("quoteCorrectsSlot — cytat podaje inną wartość", () => {
  const NATO = "Polska wstąpiła do NATO w 2004 roku.";
  it.each([
    [NATO, "Poland 1999", "czas", { claim: ["2004"], quote: ["1999"] }],
    [NATO, "in 1997 and on 12 March 1999 they became the first former members of the Warsaw Pact to join NATO", "czas", { claim: ["2004"], quote: ["1997", "1999"] }],
    [NATO, "Lithuania, Latvia and Estonia joined in 2004; Poland in 1999", "czas", null], // rok twierdzenia jest w cytacie
    [NATO, "Poland is a member of NATO.", "czas", null], // brak roku w cytacie
    ["W 2024 roku inflacja wyniosła 15 procent.", "W 2024 r. inflacja wyniosła 3,6 proc.", "liczba", { claim: ["15"], quote: ["3,6"] }],
    ["W 2024 roku inflacja wyniosła 15 procent.", "W 2023 r. inflacja wyniosła 11,4 proc.", "liczba", null], // inny okres
    ["W 2024 roku inflacja wyniosła 15 procent.", "Inflacja wyniosła 15%.", "liczba", null], // ta sama wartość
    ["Polska ma 38 mln mieszkańców.", "Ludność: 38 000 000 osób.", "liczba", null], // ta sama po przeliczeniu
    ["Kadencja Sejmu trwa 5 lat.", "Kadencja Sejmu trwa 4 lata.", "liczba", { claim: ["5"], quote: ["4"] }],
  ] as const)("%s ↔ %s (%s)", (claim, quote, aspect, want) => {
    const got = quoteCorrectsSlot(claim, quote, aspect);
    if (want === null) expect(got).toBeNull();
    else expect(got).toEqual(want);
  });
});
