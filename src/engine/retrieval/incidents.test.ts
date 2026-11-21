import { describe, expect, it } from "vitest";
import { createIncidentBranch, extractHosts, matchIncidentDomains } from "./incidents";
import { claim, createTestDb } from "./test-fixtures";

describe("gałąź incydentów", () => {
  const db = createTestDb();
  const branch = createIncidentBranch(db);

  it("jest opcjonalna", () => {
    expect(branch.id).toBe("incident");
    expect(branch.required).toBe(false);
  });

  it("zwraca rekordy powiązane z incydentami (via=incident)", async () => {
    const res = await branch.search({ claim: claim("szczepionki zawierają mikroczipy") });
    expect(res.map((r) => r.recordId)).toEqual(["r07"]);
    expect(res[0]!.via).toBe("incident");
    expect(res[0]!.score).toBeGreaterThan(0);
  });

  it("pomija incydenty bez rekordu i z nieistniejącym rekordem", async () => {
    const res = await branch.search({ claim: claim("sankcji incydent") });
    expect(res).toEqual([]);
  });

  it("błąd SQL (brak tabeli) propaguje się — retrieve() oznaczy gałąź jako niedostępną", async () => {
    const broken = createTestDb();
    broken.exec("DROP TABLE incidents_fts");
    await expect(createIncidentBranch(broken).search({ claim: claim("mikroczipy") })).rejects.toThrow();
  });
});

describe("extractHosts", () => {
  it("wyciąga hosty z URL-i ze schematem i bez, w tym z tekstu", () => {
    expect(
      extractHosts("Zobacz https://Zla-Strona.pl/artykul?id=1, oraz fake-news.example.net/post i (http://a.b.example.com/x)."),
    ).toEqual(expect.arrayContaining(["zla-strona.pl", "fake-news.example.net", "a.b.example.com"]));
  });

  it("używa hosta, a nie loginu z userinfo", () => {
    expect(extractHosts("http://zla-strona.pl@dobra.pl/x")).toEqual(["dobra.pl"]);
  });

  it("nie traktuje domeny z adresu e-mail jako URL-a", () => {
    expect(extractHosts("napisz do jan@zla-strona.pl")).toEqual([]);
  });

  it("obsługuje IDN (punycode) i kropkę końcową", () => {
    expect(extractHosts("https://żółć.pl./")).toEqual(["xn--kda4b0koi.pl"]);
  });
});

describe("matchIncidentDomains — dokładny host, tylko ostrzeżenia", () => {
  const db = createTestDb();

  it("dopasowuje dokładny host z URL-a", () => {
    expect(matchIncidentDomains("https://zla-strona.pl/artykul/123", db)).toEqual([
      { incidentId: "i01", title: "Kampania o mikroczipach w szczepionkach", url: "https://example.org/incident/1" },
    ]);
  });

  it("dopasowuje wpis podany jako pełny URL w domains_json i wielkość liter nie ma znaczenia", () => {
    const res = matchIncidentDomains("Przeczytałem to na HTTPS://DEZINFO.EXAMPLE.COM/inna-sciezka", db);
    expect(res.map((r) => r.incidentId)).toEqual(["i01"]);
  });

  it("dopasowuje host bez schematu w tekście wiadomości", () => {
    expect(matchIncidentDomains("Widziałem to na fake-news.example.net/post/5, prawda?", db).map((r) => r.incidentId)).toEqual([
      "i02",
    ]);
  });

  it("NIE dopasowuje subdomen ani domen nadrzędnych ani podobnych nazw", () => {
    expect(matchIncidentDomains("https://blog.zla-strona.pl/x", db)).toEqual([]); // subdomena
    expect(matchIncidentDomains("https://www.zla-strona.pl/x", db)).toEqual([]); // www to subdomena
    expect(matchIncidentDomains("https://pl/x https://example.com/x", db)).toEqual([]); // domena nadrzędna wpisu dezinfo.example.com
    expect(matchIncidentDomains("https://zla-strona.pl.evil.com/x", db)).toEqual([]); // host jako prefiks
    expect(matchIncidentDomains("https://nie-zla-strona.pl/x", db)).toEqual([]); // sufiks nazwy
    expect(matchIncidentDomains("https://zla-strona.pl@dobra.pl/x", db)).toEqual([]); // userinfo
  });

  it("nie dopasowuje samej nazwy w tekście bez domeny", () => {
    expect(matchIncidentDomains("zla strona pl", db)).toEqual([]);
    expect(matchIncidentDomains("", db)).toEqual([]);
  });

  it("deduplikuje incydenty i zwraca wszystkie pasujące", () => {
    const res = matchIncidentDomains("zla-strona.pl oraz https://zla-strona.pl/2 i fake-news.example.net", db);
    expect(res.map((r) => r.incidentId).sort()).toEqual(["i01", "i02"]);
  });

  it("odporność na zepsuty domains_json", () => {
    const broken = createTestDb();
    broken.prepare("UPDATE incidents SET domains_json = 'nie-json' WHERE id = 'i01'").run();
    broken.prepare("UPDATE incidents SET domains_json = '{\"a\":1}' WHERE id = 'i02'").run();
    expect(matchIncidentDomains("https://zla-strona.pl/", broken)).toEqual([]);
  });
});
