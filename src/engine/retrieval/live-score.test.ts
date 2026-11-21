import { describe, expect, it } from "vitest";
import { chunkText, PASSAGE_MAX_CHARS, queryStems, scorePassages, stemToken } from "./live-score";

describe("stemToken / queryStems", () => {
  it("składa polską fleksję do wspólnego rdzenia", () => {
    expect(stemToken("Szwecja")).toBe(stemToken("Szwecji"));
    expect(stemToken("sankcjami")).toBe(stemToken("sankcje"));
    expect(stemToken("2024")).toBe("2024");
    expect(stemToken("NATO")).toBe("nato");
  });

  it("pomija stopwords i duplikaty", () => {
    const s = queryStems(["Szwecja dołączyła do NATO w 2024 roku.", "Sweden joined NATO in 2024"]);
    expect(s).toContain("nato");
    expect(s).toContain("2024");
    expect(s).not.toContain("do");
    expect(s.filter((x) => x === "nato")).toHaveLength(1);
  });
});

describe("chunkText", () => {
  it("łączy akapity do ~1200 znaków i nie przekracza twardego limitu", () => {
    const para = "Zdanie testowe numer jeden jest tutaj. ".repeat(8).trim();
    const text = Array.from({ length: 30 }, () => para).join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
    expect(chunks[0]!.length).toBeGreaterThan(900);
  });

  it("tnie bardzo długi akapit bez spacji i odrzuca okruchy", () => {
    const chunks = chunkText("a".repeat(4000));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
    expect(chunkText("krótko")).toEqual([]);
  });

  it("respektuje maxPassages", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Akapit ${i} ` + "słowo ".repeat(40)).join("\n");
    expect(chunkText(text, { maxPassages: 5 }).length).toBeLessThanOrEqual(5);
  });
});

describe("scorePassages", () => {
  const passages = [
    { key: "a", title: "Państwa członkowskie NATO", text: "Sweden joined NATO on 7 March 2024 as the 32nd member of the Alliance." },
    { key: "b", title: "Historia", text: "Finland became a NATO member in April 2023 after a long process." },
    { key: "c", title: "Kuchnia", text: "Przepis na pierogi ruskie z cebulą i serem białym." },
  ];

  it("rankuje fragment pasujący do rdzeni zapytania najwyżej i pomija niezwiązane", () => {
    const stems = queryStems(["Szwecja dołączyła do NATO w 2024 roku.", "Sweden joined NATO in 2024"]);
    const out = scorePassages(passages, stems);
    expect(out[0]!.key).toBe("a");
    expect(out.map((o) => o.key)).not.toContain("c");
  });

  it("zwraca pustą listę dla pustego zapytania lub fragmentów", () => {
    expect(scorePassages([], ["nato"])).toEqual([]);
    expect(scorePassages(passages, [])).toEqual([]);
  });
});
