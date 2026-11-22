import { describe, expect, it } from "vitest";
import { catalogSourceForHost, catalogSourceById, loadCatalog, normalizeHost, parseCatalogForTest } from "./catalog";

describe("katalog źródeł", () => {
  it("ładuje się i spełnia schemat CatalogSource", () => {
    const catalog = loadCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(12);
    for (const s of catalog) {
      expect(s.hosts.length).toBeGreaterThan(0);
      expect(s.licence.length).toBeGreaterThan(10);
      expect(s.qualification.length).toBeGreaterThan(10);
      expect(s.updateFrequency.length).toBeGreaterThan(3);
    }
  });

  it("dopasowuje host DOKŁADNIE (bez dziedziczenia z domeny nadrzędnej)", () => {
    expect(catalogSourceForHost("pravda.org.pl")?.id).toBe("pravda-pl");
    expect(catalogSourceForHost("www.dw.com")?.id).toBe("dw-factcheck");
    expect(catalogSourceForHost("api.sejm.gov.pl")?.id).toBe("sejm-eli");
    // subdomena nie dziedziczy poziomu
    expect(catalogSourceForHost("sub.pravda.org.pl")).toBeUndefined();
    expect(catalogSourceForHost("evil.api.sejm.gov.pl")).toBeUndefined();
    // domena nadrzędna nie dziedziczy po podrzędnej
    expect(catalogSourceForHost("dw.com")).toBeUndefined();
    expect(catalogSourceForHost("sejm.gov.pl")).toBeUndefined();
    expect(catalogSourceForHost("gov.pl")).toBeUndefined();
    // sufiks nie jest dopasowaniem
    expect(catalogSourceForHost("notpravda.org.pl")).toBeUndefined();
    expect(catalogSourceForHost("pravda.org.pl.evil.example")).toBeUndefined();
    // wariant www nie jest domniemany
    expect(catalogSourceForHost("www.pravda.org.pl")).toBeUndefined();
    expect(catalogSourceForHost("")).toBeUndefined();
  });

  it("normalizuje wielkość liter, port, kropkę końcową i pełny URL", () => {
    expect(normalizeHost("PRAVDA.ORG.PL")).toBe("pravda.org.pl");
    expect(normalizeHost("pravda.org.pl:443")).toBe("pravda.org.pl");
    expect(normalizeHost("pravda.org.pl.")).toBe("pravda.org.pl");
    expect(normalizeHost("https://pravda.org.pl/czy-x/?a=1")).toBe("pravda.org.pl");
    expect(catalogSourceForHost("HTTPS://Pravda.org.pl/abc")?.id).toBe("pravda-pl");
  });

  it("każdy host jest przypisany do jednego źródła", () => {
    const seen = new Map<string, string>();
    for (const s of loadCatalog()) {
      for (const h of s.hosts) {
        expect(seen.get(h)).toBeUndefined();
        seen.set(h, s.id);
        expect(h).toBe(normalizeHost(h));
      }
    }
  });

  it("odrzuca duplikat hosta i host w złym formacie", () => {
    const base = (id: string, host: string) => `
- id: ${id}
  hosts: [${host}]
  publisher: P
  type: pierwotne
  level: 1
  role: tresc
  independenceGroup: g
  licence: l
  fetchMethod: api
  updateFrequency: u
  qualification: q
  homepage: https://example.org/
`;
    expect(() => parseCatalogForTest(base("a", "example.org") + base("b", "example.org"))).toThrow(/dwóch źródeł/);
    expect(() => parseCatalogForTest(base("a", "Example.org"))).toThrow(/małymi literami/);
  });

  it("flaga ifcnEfcsn jest ustawiona tylko dla fact-checków zweryfikowanych na listach IFCN/EFCSN", () => {
    const flagged = loadCatalog().filter((s) => s.ifcnEfcsn);
    for (const s of flagged) expect(s.type).toBe("factcheck");
    // organizacje, których NIE ma na listach (stan 2026-11-21), nie mogą mieć flagi
    for (const id of ["konkret24", "fakehunter", "euvsdisinfo"]) {
      expect(catalogSourceById(id)?.ifcnEfcsn).toBe(false);
    }
    for (const id of ["pravda-pl", "dpa-factchecking", "demagog", "afp-sprawdzam"]) {
      expect(catalogSourceById(id)?.ifcnEfcsn).toBe(true);
    }
  });

  it("poziomy: źródła pierwotne to poziom 1, fact-checki bez IFCN/EFCSN nie przekraczają poziomu 3", () => {
    for (const s of loadCatalog()) {
      if (s.type === "pierwotne") expect(s.level).toBe(1);
      if (s.type === "factcheck" && !s.ifcnEfcsn) expect(s.level).toBe(3);
      if (s.type === "factcheck" && s.ifcnEfcsn) expect(s.level).toBe(2);
    }
  });

  it("flaga liveSearch uwzględnia kanały API i blokady automatycznego dostępu", () => {
    const catalog = loadCatalog();
    const offlinePrimary = new Set(["gus-bdl", "consilium-eu", "ohchr", "un-press", "eu-enlargement", "pap-depesze", "wroclaw-transport", "rpo", "zus-wskazniki", "zus-swiadczenia", "cbos", "unhcr-data", "sipri", "iiss", "kse-institute"]);
    for (const s of catalog) expect(typeof s.liveSearch, s.id).toBe("boolean");
    for (const s of catalog) {
      if (s.type === "pierwotne" && (s.fetchMethod === "dump" || offlinePrimary.has(s.id))) expect(s.liveSearch, s.id).toBe(false);
      // fetchMethod "api" = dane tylko przez API pośrednika (np. Demagog przez Google Fact Check Tools API) — bez pobierania stron.
      if (s.type === "factcheck" && s.ifcnEfcsn) expect(s.liveSearch, s.id).toBe(s.fetchMethod !== "api");
      if (s.type === "factcheck" && !s.ifcnEfcsn) expect(s.liveSearch, s.id).toBe(false);
    }
    for (const id of ["gov-pl", "nato", "msz-odyseusz"]) expect(catalogSourceById(id)?.liveSearch, id).toBe(true);
    expect(catalogSourceById("demagog")?.liveSearch).toBe(false);
    expect(catalogSourceById("demagog")?.fetchMethod).toBe("api");
    expect(catalogSourceById("konkret24")?.liveSearch).toBe(false);
    const parsed = parseCatalogForTest(`
- id: x
  hosts: [x.example.org]
  publisher: X
  type: pierwotne
  level: 1
  role: tresc
  independenceGroup: g
  licence: test
  fetchMethod: html
  updateFrequency: raz
  qualification: test
  homepage: https://x.example.org/
`);
    expect(parsed[0]!.liveSearch).toBe(false);
  });

  it("nowe źródła osób pełniących funkcje mają dokładne hosty i poziom 1", () => {
    expect(catalogSourceForHost("www.prezydent.pl")?.id).toBe("prezydent-pl");
    expect(catalogSourceForHost("www.senat.gov.pl")?.id).toBe("senat-pl");
    expect(catalogSourceForHost("commission.europa.eu")?.id).toBe("ec-commission");
    expect(catalogSourceForHost("data.europarl.europa.eu")?.id).toBe("ep-open-data");
    for (const id of ["prezydent-pl", "senat-pl", "ec-commission", "ep-open-data"]) expect(catalogSourceById(id)?.level).toBe(1);
    expect(catalogSourceForHost("prezydent.pl")).toBeUndefined();
    expect(catalogSourceForHost("senat.gov.pl")).toBeUndefined();
  });
});
