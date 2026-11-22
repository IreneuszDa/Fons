import { describe, expect, it } from "vitest";
import { readCorpus } from "./files";
import { captureNotice, odyseuszSourceTexts } from "./odyseusz-evidence";

const record = readCorpus().records.find(r => r.sourceId === "msz-odyseusz")!;
const at = "2026-11-22T10:00:00.000Z";
const segments = record.text.split(" […] ");
const profile = {
  kodISO: "IT", dataAktualizacji: record.publishedAt, nrWersji: 1, idWersjiProfiluPanstwa: 2,
  trescPowiadomieniaDluga: segments.join(" " + "Dodatkowe informacje urzędowe. ".repeat(50)),
};

describe("weryfikacja wyciągu z komunikatu MSZ", () => {
  it("odszukuje fragmenty w odpowiedzi API i zachowuje ograniczony kontekst z pozycjami", () => {
    const proof = captureNotice(record, JSON.stringify(profile), at);
    expect(proof.slices).toHaveLength(2);
    expect(proof.slices[0]!.text).toContain("Dodatkowe informacje");
    expect(proof.slices[1]!.offset).toBeGreaterThan(1000);
    expect(proof.slices.map(s => s.text).join(" […] ").length).toBeLessThanOrEqual(300);
    expect(odyseuszSourceTexts(record)[0]).toContain(segments[0]);
  });
  it("odrzuca inną datę, kraj, pole API lub kolejność urzędowego komunikatu", () => {
    for (const change of [
      { kodISO: "FR" }, { dataAktualizacji: "2026-11-20" }, { trescPowiadomieniaDluga: "Inny komunikat." },
      { trescPowiadomieniaDluga: [...segments].reverse().join(" ") }, { trescPowiadomieniaDluga: undefined, innePole: record.text },
    ]) expect(() => captureNotice(record, JSON.stringify({ ...profile, ...change }), at)).toThrow();
  });
});
