import { describe, expect, it } from "vitest";
import { parsePeriod, textCoversDate } from "./periods";

describe("textCoversDate (reguła 3: cytat mówi o czasie zdarzenia lub późniejszym)", () => {
  const nov2026 = parsePeriod("2026-11")!;
  it.each([
    ["przedłużone do 30 marca 2027 r.", true],
    ["obowiązuje do 31.12.2026", true],
    ["valid until December 2026", true],
    ["do 2026-11-15", true],
    ["plan na lata 2027–2030", true],
    ["od 2 października 2026 r.", false],
    ["w 2026 roku", false],
    ["1.10.2026", false],
    ["kraje mają 30 żołnierzy", false],
    ["15,2027 mln", false],
  ])("%s → %s", (text, want) => {
    expect(textCoversDate(text, nov2026)).toBe(want);
  });
});
