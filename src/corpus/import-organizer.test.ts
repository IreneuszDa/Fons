import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCache, catalogSourceForHost, loadCatalog } from "./catalog";
import { readCorpus } from "./files";
import { ORGANIZER_BASE_ID, importIncidentBase, importSourceList, parseCsv, parseTable, runImport, toIsoDate } from "./import-organizer";
import { paths } from "./paths";
import { clearRatingMapCache } from "./ratings";
import { ensureCorpusLoaded, openDatabase } from "./store";

const FIX = resolve(__dirname, "fixtures");
const sourcesCsv = readFileSync(resolve(FIX, "organizer-sources.sample.csv"), "utf8");
const incidentsJson = readFileSync(resolve(FIX, "organizer-incidents.sample.json"), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "prawdowid-org-"));
  copyFileSync(paths.sourcesYaml(), resolve(dir, "sources.yaml"));
  copyFileSync(paths.ratingMapYaml(), resolve(dir, "rating-map.yaml"));
  clearCatalogCache();
  clearRatingMapCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearCatalogCache();
  clearRatingMapCache();
});

describe("parsowanie tabel", () => {
  it("CSV: separator ;, cudzysłowy, przecinki w polu, puste wiersze", () => {
    const rows = parseCsv(sourcesCsv);
    expect(rows).toHaveLength(4);
    expect(rows[1]!.domain).toBe("gov.przyklad.example, www.gov.przyklad.example");
    expect(rows[0]!["nazwa"]).toBe("Przykładowy Fact-Check (PRÓBKA)");
  });
  it("CSV: separator przecinek i znak nowej linii w cudzysłowie", () => {
    const rows = parseCsv('host,name\n"a.example","Linia 1\nLinia ""2"""\n');
    expect(rows).toEqual([{ host: "a.example", name: 'Linia 1\nLinia "2"' }]);
  });
  it("JSON: obiekt z tablicą w polu items oraz goła tablica", () => {
    expect(parseTable(incidentsJson, "json")).toHaveLength(4);
    expect(parseTable('[{"a":1}]', "json")).toEqual([{ a: 1 }]);
    expect(() => parseTable('{"x":1}', "json")).toThrow();
  });
  it("daty: ISO, DD.MM.RRRR, nieczytelne => null", () => {
    expect(toIsoDate("21.03.2024")).toBe("2024-03-21");
    expect(toIsoDate("2024-05-02")).toBe("2024-05-02");
    expect(toIsoDate("2024-05-02T10:00:00Z")).toBe("2024-05-02T10:00:00Z");
    expect(toIsoDate("not a date")).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });
});

describe("importSourceList", () => {
  it("tworzy wpisy katalogu zgodne z CatalogSource, pomija host już w katalogu i wiersz bez hosta", () => {
    const res = importSourceList(parseCsv(sourcesCsv), {}, loadCatalog(dir));
    expect(res.sources).toHaveLength(2);
    const [fc, gov] = res.sources;
    expect(fc!.hosts).toEqual(["www.przyklad-factcheck.example"]);
    expect(fc!.type).toBe("factcheck");
    expect(fc!.level).toBe(2);
    expect(fc!.role).toBe("stala_rola");
    expect(fc!.ifcnEfcsn).toBe(true);
    expect(fc!.licence).toBe("CC BY 4.0");
    expect(gov!.hosts).toEqual(["gov.przyklad.example", "www.gov.przyklad.example"]);
    expect(gov!.type).toBe("pierwotne");
    expect(gov!.level).toBe(1); // brak poziomu w pakiecie => domyślny dla typu
    expect(gov!.ifcnEfcsn).toBe(false);
    // ta sama reguła co w katalogu: urzędowe i fact-checkerzy IFCN/EFCSN dopuszczeni do wyszukiwania na żywo
    expect(fc!.liveSearch).toBe(true);
    expect(gov!.liveSearch).toBe(true);
    expect(res.skipped.map((s) => s.reason).join("|")).toMatch(/już w katalogu/);
    expect(res.skipped.map((s) => s.reason).join("|")).toMatch(/brak czytelnego hosta/);
  });

  it("mapowanie pól jest konfigurowalne", () => {
    const rows = [{ Domena: "https://x.example/strona", Wydawca: "X", Kategoria: "analysis" }];
    const res = importSourceList(rows, { sources: { host: ["Domena"], publisher: ["Wydawca"], type: ["Kategoria"] } });
    expect(res.sources[0]).toMatchObject({ hosts: ["x.example"], publisher: "X", type: "analiza", level: 3, role: "tresc" });
  });
});

describe("importIncidentBase", () => {
  const catalog = () => loadCatalog(dir);
  const importedAt = "2026-11-21T12:00:00.000Z";

  it("tworzy rekordy o stałej roli z oceną z tabeli, incydenty z domenami (bez platform) i pomija wiersze niepełne", () => {
    const res = importIncidentBase(parseTable(incidentsJson, "json"), {}, { importedAt, catalog: catalog(), dataDir: dir });
    expect(res.records).toHaveLength(3);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toMatch(/brak adresu/);

    const first = res.records[0]!;
    expect(first.origin).toBe("organizer");
    expect(first.role).toBe("stala_rola");
    expect(first.sourceId).toBe(ORGANIZER_BASE_ID);
    expect(first.publishedAt).toBe("2024-03-21");
    expect(first.fetchedAt).toBe(importedAt);
    expect(first.lang).toBe("pl");
    expect(first.claimReviewed).toBe("Przykładowa teza dezinformacyjna numer jeden.");
    expect(first.rating).toEqual({ raw: "Fałsz", mapped: "FALSZYWE", binary: true }); // wspólne etykiety polskie (fallback)
    expect(first.text).toContain("Opis przykładowy");

    const byClaim = (c: string) => res.records.find((r) => r.claimReviewed === c)!;
    expect(byClaim("Przykładowa teza z oceną spoza tabeli.").rating).toEqual({ raw: "Prawie prawda ale nie do końca", mapped: null, binary: false });
    const eng = byClaim("Przykładowa teza z angielską oceną.");
    expect(eng.rating).toEqual({ raw: "Misleading", mapped: "WPROWADZAJACE", binary: false });
    expect(eng.publishedAt).toBeNull(); // nieczytelna data => null, nie wymyślamy

    const inc = res.incidents.find((i) => i.recordId === first.id)!;
    expect(inc.domains).toEqual(["fake-portal.example", "facebook.example", "inny-portal.example"]);
  });

  it("host spoza katalogu trafia do źródła organizer-base; host z katalogu zachowuje poziom z katalogu", () => {
    const rows = [
      { claim: "Teza A", link: "https://nowy.example/a", verdict: "False" },
      { claim: "Teza B (host z katalogu)", link: "https://pravda.org.pl/jakis-wpis/", verdict: "Fałsz" },
    ];
    const res = importIncidentBase(rows, {}, { importedAt, catalog: catalog(), dataDir: dir });
    expect(res.newSources).toHaveLength(1);
    expect(res.newSources[0]!.id).toBe(ORGANIZER_BASE_ID);
    expect(res.newSources[0]!.hosts).toEqual(["nowy.example"]);
    const a = res.records.find((r) => r.claimReviewed === "Teza A")!;
    expect(a.sourceId).toBe(ORGANIZER_BASE_ID);
    expect(a.level).toBe(2);
    expect(a.rating).toEqual({ raw: "False", mapped: "FALSZYWE", binary: true });
    const b = res.records.find((r) => r.claimReviewed === "Teza B (host z katalogu)")!;
    expect(b.sourceId).toBe("pravda-pl");
    expect(b.level).toBe(catalogSourceForHost("pravda.org.pl", dir)!.level);
    expect(b.rating).toEqual({ raw: "Fałsz", mapped: "FALSZYWE", binary: true });
  });

  it("identyfikatory są stabilne (powtórny import daje te same id) i bez duplikatów", () => {
    const rows = parseTable(incidentsJson, "json");
    const a = importIncidentBase(rows, {}, { importedAt, catalog: catalog(), dataDir: dir });
    const b = importIncidentBase(rows, {}, { importedAt: "2027-01-01T00:00:00.000Z", catalog: catalog(), dataDir: dir });
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    const dup = importIncidentBase([...rows, ...rows], {}, { importedAt, catalog: catalog(), dataDir: dir });
    expect(dup.records).toHaveLength(a.records.length);
    expect(dup.skipped.some((s) => s.reason.includes("duplikat"))).toBe(true);
  });

  it("konfigurowalne nazwy pól (inne nagłówki niż domyślne)", () => {
    const rows = [{ Teza: "Teza C", Adres: "https://c.example/1", Ocena: "False", Opis: "Wyjaśnienie" }];
    const res = importIncidentBase(rows, { incidents: { claim: ["Teza"], url: ["Adres"], rating: ["Ocena"], summary: ["Opis"] } }, { importedAt, catalog: catalog(), dataDir: dir });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.text).toBe("Teza C\nWyjaśnienie");
  });
});

describe("runImport (CLI) end-to-end na próbce", () => {
  it("zapisuje katalog organizatora, jsonl i da się to załadować do bazy; powtórny import jest idempotentny", () => {
    const args = { sources: resolve(FIX, "organizer-sources.sample.csv"), incidents: resolve(FIX, "organizer-incidents.sample.json"), dataDir: dir };
    const logs: string[] = [];
    runImport(args, (m) => logs.push(m));
    expect(existsSync(paths.organizerSourcesYaml(dir))).toBe(true);
    const catalog = loadCatalog(dir);
    expect(catalogSourceForHost("www.przyklad-factcheck.example", dir)?.id).toMatch(/^org-/);
    expect(catalogSourceForHost("nowy-host.example", dir)?.id).toBe(ORGANIZER_BASE_ID);
    expect(catalog.length).toBeGreaterThan(14);

    const first = readCorpus(dir);
    expect(first.errors).toEqual([]);
    expect(first.records).toHaveLength(3);
    expect(first.incidents).toHaveLength(3);

    runImport(args, () => {});
    clearCatalogCache();
    const second = readCorpus(dir);
    expect(second.records.map((r) => r.id).sort()).toEqual(first.records.map((r) => r.id).sort());

    const db = openDatabase(":memory:");
    const res = ensureCorpusLoaded(db, { dataDir: dir });
    expect(res.records).toBe(3);
    db.close();
    expect(logs.join("\n")).toMatch(/Gotowe/);
  });

  it("nie dotyka plików w data/ repozytorium (katalog tymczasowy)", () => {
    mkdirSync(resolve(dir, "corpus"), { recursive: true });
    runImport({ incidents: resolve(FIX, "organizer-incidents.sample.json"), dataDir: dir }, () => {});
    expect(existsSync(resolve(dir, "corpus", "organizer-organizer-base.jsonl")) || existsSync(resolve(dir, "corpus", "organizer-base.jsonl"))).toBe(true);
  });
});
