import { describe, expect, it } from "vitest";
import { literalCheck, literalFactorPl } from "./literal";

const KPRP = "Dr Karol Nawrocki – Prezydent Rzeczypospolitej Polskiej Urząd ten objął 6 sierpnia 2025 roku, składając przysięgę przed Zgromadzeniem Narodowym.";

describe("kontrola dosłowna (nazwy i liczby)", () => {
  it("inna osoba na tym samym urzędzie → zgodne z OBALA, z nazwami obu stron", () => {
    const r = literalCheck("Jakub Siuda to prezydent polski.", KPRP, "OBALA");
    expect(r.consistent).toBe(true);
    expect(r.kind).toBe("names");
    expect(r.claimOnly).toEqual(["Jakub Siuda"]);
    expect(r.quoteOnly[0]).toBe("Dr Karol Nawrocki");
    expect(literalFactorPl(r)).toContain("„Jakub Siuda”");
  });

  it("odmiana nazwiska i przymiotnika nie przeszkadza", () => {
    const r = literalCheck("Prezydentem Polski jest Jakub Siuda.", KPRP, "OBALA");
    expect(r.consistent).toBe(true);
  });

  it("inna liczba w tym samym zdaniu prawnym → zgodne z OBALA", () => {
    const r = literalCheck("Kadencja Sejmu trwa 5 lat.", "Kadencja Sejmu i Senatu trwa 4 lata.", "OBALA");
    expect(r.consistent).toBe(true);
    expect(r.kind).toBe("numbers");
    expect(r.claimOnly).toEqual(["5"]);
    expect(r.quoteOnly).toEqual(["4"]);
  });

  it("WSPIERA: wszystkie nazwy i liczby są w cytacie", () => {
    expect(literalCheck("Karol Nawrocki jest prezydentem Polski.", KPRP, "WSPIERA").consistent).toBe(true);
    expect(literalCheck("Polska jest członkiem NATO od 12 marca 1999 roku.", "Polska przystąpiła do NATO 12 marca 1999 roku.", "WSPIERA").consistent).toBe(true);
  });

  it("WSPIERA z inną liczbą w cytacie nie przechodzi", () => {
    expect(literalCheck("Polska jest członkiem NATO od 1998 roku.", "Polska przystąpiła do NATO 12 marca 1999 roku.", "WSPIERA").consistent).toBe(false);
  });

  it("cytat o czymś innym (brak wspólnego tematu) nie przechodzi, nawet gdy model dał OBALA", () => {
    expect(literalCheck("Jakub Siuda spotkał się z ministrem w Gdańsku.", KPRP, "OBALA").consistent).toBe(false);
    expect(literalCheck("Inflacja w Polsce wyniosła 15%.", "Bezrobocie w Niemczech wynosi 6%.", "OBALA").consistent).toBe(false);
  });

  it("OBALA bez różnicy w nazwach ani liczbach (np. zaprzeczenie słowne) nie przechodzi — to ocena modelu", () => {
    expect(literalCheck("Szwecja nie jest członkiem NATO.", "Szwecja jest członkiem NATO od 7 marca 2024 roku.", "OBALA").consistent).toBe(false);
  });

  it("inne relacje są pomijane", () => {
    expect(literalCheck("Jakub Siuda to prezydent polski.", KPRP, "CZESCIOWO").consistent).toBe(false);
  });
});
