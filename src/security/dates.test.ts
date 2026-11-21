import { describe, expect, it } from "vitest";
import { formatPolishDate, resolveRelativeDates } from "./dates";

// 21 Nov 2026, 12:00 Warsaw (UTC+1) — a Saturday
const at = new Date("2026-11-21T11:00:00Z");

describe("resolveRelativeDates", () => {
  it("resolves Polish day words", () => {
    expect(resolveRelativeDates("Wczoraj premier ogłosił mobilizację.", at)).toBe("20 listopada 2026 premier ogłosił mobilizację.");
    expect(resolveRelativeDates("dziś rano", at)).toBe("21 listopada 2026 rano");
    expect(resolveRelativeDates("Dzisiaj o 10:00", at)).toBe("21 listopada 2026 o 10:00");
    expect(resolveRelativeDates("przedwczoraj w Sejmie", at)).toBe("19 listopada 2026 w Sejmie");
    expect(resolveRelativeDates("jutro wejdzie w życie", at)).toBe("22 listopada 2026 wejdzie w życie");
    expect(resolveRelativeDates("od wczoraj obowiązuje", at)).toBe("od 20 listopada 2026 obowiązuje");
  });

  it("resolves English day words", () => {
    expect(resolveRelativeDates("Yesterday the minister said", at)).toBe("20 listopada 2026 the minister said");
    expect(resolveRelativeDates("today", at)).toBe("21 listopada 2026");
  });

  it("does not touch words containing the keywords", () => {
    expect(resolveRelativeDates("wczorajszy komunikat", at)).toBe("wczorajszy komunikat");
    expect(resolveRelativeDates("dzisiejsze dane", at)).toBe("dzisiejsze dane");
  });

  it("keeps 'jutro' as the noun 'future'", () => {
    expect(resolveRelativeDates("walczymy o lepsze jutro", at)).toBe("walczymy o lepsze jutro");
  });

  it("resolves 'w tym tygodniu' to the Monday–Sunday range", () => {
    expect(resolveRelativeDates("w tym tygodniu", at)).toBe("w tygodniu od 16 do 22 listopada 2026");
    expect(resolveRelativeDates("w tym tygodniu", new Date("2026-12-01T10:00:00Z"))).toBe(
      "w tygodniu od 30 listopada do 6 grudnia 2026",
    );
    expect(resolveRelativeDates("w tym tygodniu", new Date("2026-01-01T10:00:00Z"))).toBe(
      "w tygodniu od 29 grudnia 2025 do 4 stycznia 2026",
    );
  });

  it("uses the Warsaw calendar day, not UTC", () => {
    // 23:30 UTC on 21 Nov is already 22 Nov in Warsaw
    expect(resolveRelativeDates("dziś", new Date("2026-11-21T23:30:00Z"))).toBe("22 listopada 2026");
  });

  it("crosses month and year boundaries with correct genitive month names", () => {
    expect(resolveRelativeDates("wczoraj", new Date("2026-03-01T10:00:00Z"))).toBe("28 lutego 2026");
    expect(resolveRelativeDates("wczoraj", new Date("2027-01-01T10:00:00Z"))).toBe("31 grudnia 2026");
    expect(formatPolishDate({ y: 2026, m: 9, d: 1 })).toBe("1 września 2026");
    expect(formatPolishDate({ y: 2026, m: 10, d: 5 })).toBe("5 października 2026");
  });

  it("w dniu dzisiejszym / wczorajszym", () => {
    expect(resolveRelativeDates("w dniu dzisiejszym", at)).toBe("w dniu 21 listopada 2026");
    expect(resolveRelativeDates("W dniu wczorajszym", at)).toBe("w dniu 20 listopada 2026");
  });
});
