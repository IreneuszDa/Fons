import { describe, expect, it } from "vitest";
import { createBm25Branch, queryTexts } from "./bm25";
import { buildMatchQuery, contentTokens, ftsTerm, ftsTerms, prefixLength } from "./fts";
import { detectLang, stemToken } from "./stem";
import { claim, createTestDb } from "./test-fixtures";

describe("tokenizacja i budowa zapytania FTS5", () => {
  it("usuwa stopwords PL/EN i znaki specjalne, zachowuje polskie litery", () => {
    expect(contentTokens("To jest the największa sankcja, która została nałożona na Rosję!")).toEqual([
      "największa",
      "sankcja",
      "nałożona",
      "rosję",
    ]);
  });

  it("pomija znaczniki maskowania i zachowuje nazwisko, datę oraz kwotę w zapytaniu", () => {
    const text = "Karol Nawrocki [DOWOD] podał kwotę 601234567 zł w 2026 roku.";
    const q = { claim: claim(text), extraQueries: ["[PESEL], [IBAN].", "[EMAIL] Karol Nawrocki"] };
    expect(queryTexts(q)).toEqual(["Karol Nawrocki podał kwotę 601234567 zł w 2026 roku.", "Karol Nawrocki"]);
    expect(q.claim.text).toBe(text);
    expect(contentTokens("Karol Nawrocki [telefon] 601234567 [KARTA] [NATO]")).toEqual([
      "karol", "nawrocki", "601234567", "nato",
    ]);
    expect(buildMatchQuery(["[PESEL], [DOWOD]."])).toBeNull();
  });

  it("odcina polskie końcówki fleksyjne (rdzeń + prefiks), krótkie tokeny i liczby zostawia w całości", () => {
    expect(ftsTerm("sankcji")).toBe('"sankc"*');
    expect(ftsTerm("sankcje")).toBe('"sankcj"*');
    expect(ftsTerm("sankcjami")).toBe('"sankcj"*');
    expect(ftsTerm("ustawa")).toBe('"ustaw"*');
    expect(ftsTerm("dołączyła")).toBe('"dołącz"*');
    expect(ftsTerm("członkiem")).toBe('"członk"*');
    expect(ftsTerm("europejskiej")).toBe('"europejsk"*');
    expect(ftsTerm("unii")).toBe('"unii"');
    expect(ftsTerm("nato")).toBe('"nato"');
    expect(ftsTerm("2024")).toBe('"2024"');
    expect(ftsTerm("covid19")).toBe('"covid19"');
    expect(prefixLength("ue")).toBeNull();
  });

  it("angielskie końcówki: „joined” → join*, nigdy „joine*”", () => {
    expect(stemToken("joined", "en")).toBe("join");
    expect(stemToken("sanctions", "en")).toBe("sanction");
    expect(stemToken("countries", "en")).toBe("countr");
    expect(ftsTerm("joined", "en")).toBe('"join"*');
    expect(ftsTerms("joined", "en")).toEqual(['"join"*', '"joined"']);
    const q = buildMatchQuery(["Sweden joined NATO in 2024"])!;
    expect(q).toContain('"join"*');
    expect(q).not.toContain("joine\"*");
    expect(q).toContain('"nato"');
    expect(q).toContain('"2024"');
  });

  it("rdzeń nigdy nie jest krótszy niż minimum (4 znaki)", () => {
    expect(stemToken("rosji", "pl")).toBe("rosj");
    expect(stemToken("uses", "en")).toBeNull(); // ≤ 4 znaki — w całości
    expect(stemToken("lasted", "en")).toBe("last");
    expect(stemToken("members", "en")).toBe("member");
  });

  it("wykrywa język tekstu; niejednoznaczny tekst dostaje rdzenie PL i EN", () => {
    expect(detectLang("Szwecja dołączyła do NATO")).toBe("pl");
    expect(detectLang("Sweden joined NATO in 2024")).toBe("en");
    expect(detectLang("sankcje NOT Rosja")).toBe("mixed");
    expect(ftsTerms("members", "mixed")).toEqual(['"members"*', '"member"*']);
    expect(ftsTerms("marszałkiem", "pl")).toEqual(['"marszałk"*', '"marszałkiem"', '"marszałek"*']); // „e” ruchome
    expect(ftsTerms("polskiej", "pl")).toEqual(['"polsk"*', '"polskiej"']);
    expect(ftsTerms("sankcje", "mixed")).toEqual(['"sankcj"*', '"sankcje"*']);
  });

  it("łączy terminy przez OR i przeplata teksty, więc limit nie wycina zapytań dodatkowych", () => {
    const q = buildMatchQuery(["alfa beta gamma delta epsilon zeta", "angielski przeklad"], 4)!;
    expect(q).toBe('"alfa" OR "angielsk"* OR "angielski"* OR "beta"');
    const q2 = buildMatchQuery(["alfa beta gamma delta epsilon zeta", "angielski przeklad"], 8)!;
    expect(q2).toContain('"przeklad"');
  });

  it("zwraca null, gdy nie ma znaczących tokenów", () => {
    expect(buildMatchQuery(["", "   ", "to jest i w z"])).toBeNull();
    expect(buildMatchQuery(['"" ()*^:-'])).toBeNull();
  });

  it("każdy termin jest zacytowany — operatory FTS5 przestają być operatorami", () => {
    const q = buildMatchQuery(['title:foo NEAR(a b, 2) "x" OR NOT * ^bar (baz)'])!;
    // wszystkie terminy w cudzysłowach, połączone wyłącznie naszym OR
    const parts = q.split(" OR ");
    for (const p of parts) expect(p).toMatch(/^"[\p{L}\p{N}]+"\*?$/u);
    expect(q).not.toMatch(/NEAR\(/);
  });
});

describe("gałąź BM25", () => {
  const db = createTestDb();
  const branch = createBm25Branch(db);

  it("jest konieczna i ma id bm25", () => {
    expect(branch.id).toBe("bm25");
    expect(branch.required).toBe(true);
  });

  it("odzyskuje właściwą liczbę z treści przy wielu tytułach zawierających liczbę autora", async () => {
    const db = createTestDb();
    try {
      const put = db.prepare("INSERT INTO records (id, source_id, title, text, type, level, role) VALUES (?, 'urzad', ?, ?, 'pierwotne', 1, 'tresc')");
      put.run("statut", "Statut", "Komitet składa się z 24 delegatów.");
      for (let i = 0; i < 12; i++) put.run("rubryka" + i, "Komitet, 70 delegatów", "Okręg liczy 70 delegatów.");
      db.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
      const hits = await createBm25Branch(db).search({ claim: claim("Komitet liczy 70 delegatów."), limit: 5 });
      expect(hits.map(h => h.recordId)).toContain("statut");
    } finally { db.close(); }
  });

  it("odmiany fleksyjne: sankcji / sankcje / sankcjami znajdują te same rekordy", async () => {
    const run = async (text: string) => (await branch.search({ claim: claim(text) })).map((c) => c.recordId);
    const a = await run("sankcji");
    const b = await run("sankcje");
    const c = await run("sankcjami");
    for (const ids of [a, b, c]) {
      expect(ids).toEqual(expect.arrayContaining(["r01", "r02", "r03"]));
    }
    expect(new Set(a)).toEqual(new Set(b));
    expect(new Set(b)).toEqual(new Set(c));
  });

  it("zwraca kandydatów z via=bm25 i dodatnim, malejącym wynikiem", async () => {
    const res = await branch.search({ claim: claim("sankcje Unii Europejskiej wobec Rosji") });
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.via === "bm25" && r.score > 0)).toBe(true);
    for (let i = 1; i < res.length; i++) expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
    expect(res[0]!.recordId).toBe("r01");
  });

  it("tytuł waży więcej niż treść", async () => {
    // „ustawa” jest w tytule r04, a „ustawy” tylko w treści r11 (budżetowej)
    const res = await branch.search({ claim: claim("ustawa") });
    expect(res[0]!.recordId).toBe("r04");
    expect(res.map((r) => r.recordId)).toContain("r11");
  });

  it("korzysta z extraQueries (np. tłumaczenie)", async () => {
    const without = await branch.search({ claim: claim("zdjęcie zniszczyło miasto") });
    expect(without.map((r) => r.recordId)).not.toContain("r20");
    const withExtra = await branch.search({ claim: claim("zdjęcie zniszczyło miasto"), extraQueries: ["cyberbezpieczeństwa NASK"] });
    expect(withExtra.map((r) => r.recordId)).toContain("r20");
  });

  it("respektuje limit", async () => {
    const res = await branch.search({ claim: claim("sankcje Polska Unia rok"), limit: 2 });
    expect(res.length).toBeLessThanOrEqual(2);
  });

  it("puste i bezsensowne wejście → brak wyników, bez wyjątku", async () => {
    expect(await branch.search({ claim: claim("") })).toEqual([]);
    expect(await branch.search({ claim: claim("i w z to") })).toEqual([]);
  });

  it("przerwany sygnał kończy wyszukiwanie błędem AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(branch.search({ claim: claim("sankcje"), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  describe("odporność na wstrzyknięcie składni FTS5", () => {
    const hostile = [
      'sankcje" OR "a',
      '"unbalanced',
      "NEAR(sankcje Rosja, 5)",
      "sankcje NOT Rosja",
      "sankcje AND (Rosja OR Polska",
      "title:sankcje",
      "{title text}: sankcje",
      "^sankcje",
      "sankcje*",
      "* * *",
      "sankcje -Rosja",
      ")))(((",
      "sankcje; DROP TABLE records; --",
      "' OR 1=1 --",
      'x" ) UNION SELECT 1 --',
      "\u0000sankcje\u0000",
      "a".repeat(5000),
      "sankcje ".repeat(2000),
    ];

    it.each(hostile)("nie rzuca składniowo i nie psuje bazy: %s", async (input) => {
      await expect(branch.search({ claim: claim(input) })).resolves.toBeInstanceOf(Array);
      expect(db.prepare("SELECT count(*) AS n FROM records").get()).toEqual({ n: 20 });
    });

    it("operatory w tekście nie rozszerzają wyników (tylko literalne słowa)", async () => {
      // „sankcje NOT Rosja” bez ochrony wykluczyłoby rekordy z „Rosja”; z ochroną „not” jest stopwordem, a „Rosja” zwykłym terminem
      const res = await branch.search({ claim: claim("sankcje NOT Rosja") });
      expect(res.map((r) => r.recordId)).toContain("r01");
      // filtr kolumny nie działa: „text:ochrona” to dwa zwykłe słowa
      const col = await branch.search({ claim: claim("claim_reviewed:mikroczipy") });
      expect(col.map((r) => r.recordId)).toContain("r07");
      // „*” samotna gwiazdka nie dopasowuje wszystkiego
      const star = await branch.search({ claim: claim("*") });
      expect(star).toEqual([]);
    });
  });
});
