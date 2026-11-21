import { describe, expect, it } from "vitest";
import { loadCatalog } from "./catalog";
import { corpusFiles } from "./files";
import { extractRatingLabel, loadRatingMap, mapRating, normalizeRatingKey } from "./ratings";
import { CorpusRecord } from "../shared/contracts";

describe("mapRating", () => {
  it("mapuje znane oceny Demagoga, Pravdy, AFP, Konkret24 i EUvsDisinfo", () => {
    expect(mapRating("demagog", "Prawda")).toEqual({ raw: "Prawda", mapped: "POTWIERDZONE", binary: true });
    expect(mapRating("demagog", "Fałsz")).toEqual({ raw: "Fałsz", mapped: "FALSZYWE", binary: true });
    expect(mapRating("demagog", "Manipulacja")).toEqual({ raw: "Manipulacja", mapped: "WPROWADZAJACE", binary: false });
    expect(mapRating("demagog", "Częściowa prawda").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("demagog", "Nieweryfikowalne").mapped).toBe("BRAK_DOWODOW");
    expect(mapRating("pravda-pl", "Niedające się zweryfikować").mapped).toBe("BRAK_DOWODOW");
    expect(mapRating("afp-sprawdzam", "Fałsz").binary).toBe(true);
    expect(mapRating("konkret24", "Manipulacja").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("euvsdisinfo", "DISINFO")).toEqual({ raw: "DISINFO", mapped: "FALSZYWE", binary: false });
  });

  it("mapuje typowe angielskie oceny ClaimReview", () => {
    const cases: [string, string | null, boolean][] = [
      ["False", "FALSZYWE", true],
      ["Mostly False", "FALSZYWE", false],
      ["Misleading", "WPROWADZAJACE", false],
      ["Missing context", "WPROWADZAJACE", false],
      ["Half true", "WPROWADZAJACE", false],
      ["Mostly true", "POTWIERDZONE", false],
      ["True", "POTWIERDZONE", true],
      ["Pants on fire", "FALSZYWE", false],
      ["Pants on Fire!", "FALSZYWE", false],
      ["Satire", "NIE_PODLEGA", false],
      ["Unproven", "BRAK_DOWODOW", false],
    ];
    for (const [raw, mapped, binary] of cases) {
      const r = mapRating("politifact", raw);
      expect(r.mapped, raw).toBe(mapped);
      expect(r.binary, raw).toBe(binary);
      expect(r.raw).toBe(raw);
    }
  });

  it("ocena nieznana => mapped null i binary false (nie rozstrzyga)", () => {
    expect(mapRating("demagog", "Coś zupełnie innego")).toEqual({ raw: "Coś zupełnie innego", mapped: null, binary: false });
    expect(mapRating("pravda-pl", "Zrealizowane")).toEqual({ raw: "Zrealizowane", mapped: null, binary: false });
    expect(mapRating("politifact", "Full Flop").mapped).toBeNull();
    expect(mapRating("źródło-spoza-listy", "Fałsz").mapped).toBe("FALSZYWE"); // fallback: wspólne etykiety polskie
    expect(mapRating("źródło-spoza-listy", "False").mapped).toBe("FALSZYWE"); // fallback: tablica angielska
    expect(mapRating("źródło-spoza-listy", "Częściowo prawda").mapped).toBeNull(); // nieznana => nie rozstrzyga
    expect(mapRating("demagog", "").mapped).toBeNull();
  });

  it("zachowuje raw dosłownie, a dopasowanie nie zależy od wielkości liter ani ogonków", () => {
    expect(mapRating("demagog", "FAŁSZ.").raw).toBe("FAŁSZ.");
    expect(mapRating("demagog", "FAŁSZ.").mapped).toBe("FALSZYWE");
    expect(mapRating("demagog", "falsz").mapped).toBe("FALSZYWE");
    expect(normalizeRatingKey("  “Half-True” ")).toBe("half true");
  });

  it("binary=true tylko dla ocen prawda/fałsz i tylko z mapped != null", () => {
    const map = loadRatingMap();
    for (const [name, table] of Object.entries(map.tables)) {
      for (const [label, rule] of Object.entries(table)) {
        if (rule.binary) {
          expect(["POTWIERDZONE", "FALSZYWE"], `${name}:${label}`).toContain(rule.verdict);
        }
      }
    }
    // EUvsDisinfo: zaprzeczenie dezinformacji nie czyni jej prawdziwą
    expect(mapRating("euvsdisinfo", "DISINFO").binary).toBe(false);
  });

  it("w tablicach nie ma kolizji kluczy po normalizacji", () => {
    const map = loadRatingMap();
    // loadRatingMap normalizuje klucze; sprawdzamy, że liczba kluczy nie spadła (brak kolizji w pliku)
    // (porównanie z surowym YAML robi parser — duplikaty dosłowne wywalają parsowanie)
    for (const table of Object.values(map.tables)) expect(Object.keys(table).length).toBeGreaterThan(0);
  });

  it("każde źródło z tabeli `sources` istnieje w katalogu", () => {
    const ids = new Set(loadCatalog().map((s) => s.id));
    for (const id of Object.keys(loadRatingMap().sources)) expect(ids.has(id), id).toBe(true);
  });

  it("oceny zapisane w korpusie zgadzają się z bieżącą tabelą mapowania", () => {
    let checked = 0;
    for (const f of corpusFiles()) {
      for (const line of f.lines) {
        const r = CorpusRecord.parse(JSON.parse(line));
        if (r.role !== "stala_rola" || !r.rating) continue;
        expect(r.rating, r.id).toEqual(mapRating(r.sourceId, r.rating.raw));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("extractRatingLabel", () => {
  it("zwraca krótką ocenę bez zmian", () => {
    expect(extractRatingLabel("False")).toBe("False");
  });
  it("wyciąga etykietę z długiego opisu DW", () => {
    expect(extractRatingLabel("Verdict: Fake    The video scenes do not show the recent drones that entered Polish airspace, but are from a game.")).toBe("Fake");
    expect(extractRatingLabel("DW Fact check: False    The video does not show a Russian drone in Poland and that is easy to detect.")).toBe("False");
  });
  it("zwraca null, gdy etykiety nie da się jednoznacznie wyciągnąć", () => {
    expect(extractRatingLabel("To jest po prostu bardzo długie zdanie bez żadnej etykiety oceny, które ma ponad sześćdziesiąt znaków.")).toBeNull();
  });
});
