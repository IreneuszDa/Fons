import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBm25Branch } from "./bm25";
import { capPerSource, diversifyFragments } from "./diversity";
import { SCHEMA, claim } from "./test-fixtures";

type Rec = { sourceId: string; level: 1 | 2 | 3 };
const recs = (spec: Record<string, Rec>) => new Map(Object.entries(spec));

describe("capPerSource (miękki limit jednego źródła)", () => {
  it("nadmiar jednego źródła schodzi za pozostałe, kolejność w grupach zachowana", () => {
    const items = ["d1", "d2", "d3", "g1", "d4", "g2"];
    const src = (id: string) => (id.startsWith("d") ? "demagog" : "gov");
    expect(capPerSource(items, src, 2)).toEqual(["d1", "d2", "g1", "g2", "d3", "d4"]);
    expect(capPerSource(items, src, 2, 4)).toEqual(["d1", "d2", "g1", "g2"]);
  });

  it("jedno źródło: kolejność bez zmian (nadmiar wypełnia wolne miejsca)", () => {
    expect(capPerSource(["a", "b", "c"], () => "s", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("diversifyFragments (fragmenty oceniane dla jednego twierdzenia)", () => {
  const demagog = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i + 1}`, { sourceId: "demagog", level: 2 as const }]));

  it("najwyżej 4 z 8 z jednego źródła, gdy są inni kandydaci", () => {
    const records = recs({ ...demagog(10), s1: { sourceId: "sejm", level: 2 }, s2: { sourceId: "pap", level: 3 }, s3: { sourceId: "dw", level: 2 }, s4: { sourceId: "afp", level: 2 } });
    const ranked = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "s1", "s2", "s3", "s4"];
    const out = diversifyFragments(ranked, records, { max: 8 });
    expect(out).toHaveLength(8);
    expect(out.filter((id) => id.startsWith("d"))).toEqual(["d1", "d2", "d3", "d4"]);
    expect(out.slice(4)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("rezerwuje 2 miejsca dla poziomu 1, gdy w puli jest rekord poziomu 1 (wypiera najsłabsze)", () => {
    const records = recs({
      ...demagog(4),
      a: { sourceId: "afp", level: 2 },
      b: { sourceId: "dw", level: 2 },
      c: { sourceId: "pap", level: 3 },
      e: { sourceId: "efe", level: 2 },
      g1: { sourceId: "gov-pl", level: 1 },
      g2: { sourceId: "sejm", level: 1 },
      g3: { sourceId: "gov-pl", level: 1 },
    });
    const ranked = ["d1", "d2", "d3", "d4", "a", "b", "c", "e", "g1", "g2", "g3"];
    const out = diversifyFragments(ranked, records, { max: 8 });
    expect(out).toHaveLength(8);
    expect(out).toContain("g1");
    expect(out).toContain("g2");
    expect(out).not.toContain("g3");
    expect(out).not.toContain("e"); // najsłabszy rekord spoza poziomu 1 ustępuje
    expect(out).not.toContain("c");
  });

  it("jeden rekord poziomu 1 w puli → jedno zarezerwowane miejsce; brak poziomu 1 → bez zmian", () => {
    const one = recs({ ...demagog(9), g1: { sourceId: "gov-pl", level: 1 } });
    const out = diversifyFragments([...Array.from({ length: 9 }, (_, i) => `d${i + 1}`), "g1"], one, { max: 8 });
    expect(out).toContain("g1");
    expect(out).toHaveLength(8); // brak innych źródeł: nadmiar Demagoga wypełnia wolne miejsca
    const none = recs(demagog(9));
    expect(diversifyFragments(Array.from({ length: 9 }, (_, i) => `d${i + 1}`), none, { max: 8 })).toEqual(
      Array.from({ length: 8 }, (_, i) => `d${i + 1}`),
    );
  });

  it("przypięte rekordy zostają zawsze, na początku, i liczą się do limitu źródła", () => {
    const records = recs({ ...demagog(6), o1: { sourceId: "demagog", level: 2 }, x: { sourceId: "pap", level: 3 } });
    const out = diversifyFragments(["d1", "d2", "d3", "d4", "d5", "x"], records, { max: 5, pinned: ["o1", "missing"] });
    expect(out[0]).toBe("o1");
    expect(out).toEqual(["o1", "d1", "d2", "d3", "x"]);
  });
});

describe("gałąź BM25: miękki limit jednego źródła w puli", () => {
  function db() {
    const d = new BetterSqlite3(":memory:");
    d.exec(SCHEMA);
    const ins = d.prepare(
      `INSERT INTO records (id, source_id, url, title, publisher, published_at, fetched_at, lang, text, role, type, level,
         independence_group, licence, claim_reviewed, rating_json, topics_json, period, origin)
       VALUES (?, ?, 'https://example.org/' || ?, ?, 'Test', '2024-01-01', '2025-01-01', 'pl', ?, 'tresc', 'pierwotne', 1, 'g', 'CC0', NULL, NULL, '[]', NULL, 'corpus')`,
    );
    // 12 rekordów fact-checków z silnym dopasowaniem (tytuł), 4 urzędowe ze słabszym (tylko treść).
    for (let i = 1; i <= 12; i++) ins.run(`fc${i}`, "demagog", `fc${i}`, `Minister obrony narodowej wypowiedź ${i}`, "Ocena wypowiedzi ministra obrony.");
    for (let i = 1; i <= 4; i++) ins.run(`gov${i}`, "gov-pl", `gov${i}`, `Komunikat ${i}`, "Minister obrony narodowej kieruje resortem.");
    d.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
    return d;
  }

  it("jedno źródło nie zajmuje więcej niż 40% puli, gdy są trafienia z innych źródeł", async () => {
    const out = await createBm25Branch(db()).search({ claim: claim("minister obrony narodowej"), limit: 10 });
    expect(out).toHaveLength(10);
    const fc = out.filter((c) => c.recordId.startsWith("fc")).length;
    expect(fc).toBeLessThanOrEqual(6); // 4 miejsca w limicie + nadmiar tylko na wolne miejsca
    expect(out.filter((c) => c.recordId.startsWith("gov"))).toHaveLength(4);
    expect(out.slice(0, 4).every((c) => c.recordId.startsWith("fc"))).toBe(true); // najlepsze trafienia zostają na górze
  });
});

describe("diversifyFragments: limit rekordów o stałej roli", () => {
  it("najwyżej 3 tezy fact-checków (różnych wydawców), gdy są rekordy treści; nadmiar tylko na wolne miejsca", () => {
    const fixed = (src: string) => ({ sourceId: src, level: 2 as const, role: "stala_rola" as const });
    const content = (src: string) => ({ sourceId: src, level: 1 as const, role: "tresc" as const });
    const records = new Map(Object.entries({
      f1: fixed("demagog"), f2: fixed("politifact"), f3: fixed("afp"), f4: fixed("dw"), f5: fixed("efe"),
      c1: content("nato"), c2: content("eur-lex"), c3: content("nato"), c4: content("gov-pl"), c5: content("sejm"),
    }));
    const out = diversifyFragments(["f1", "f2", "f3", "f4", "f5", "c1", "c2", "c3", "c4", "c5"], records, { max: 8 });
    expect(out.filter((id) => id.startsWith("f"))).toEqual(["f1", "f2", "f3"]);
    expect(out).toHaveLength(8);
    const few = diversifyFragments(["f1", "f2", "f3", "f4", "c1"], records, { max: 8 });
    expect(few).toEqual(["f1", "f2", "f3", "f4", "c1"]);
  });
});
