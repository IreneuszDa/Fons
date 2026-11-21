import { describe, expect, it } from "vitest";
import { CorpusRecord } from "../shared/contracts";
import { catalogSourceForHost, loadCatalog } from "./catalog";
import { corpusFiles, incidentFiles, readCorpus } from "./files";
import { createCorpusStore, ensureCorpusLoaded, openDatabase } from "./store";
import { IncidentRecord } from "./types";

const files = corpusFiles();

describe("pliki korpusu data/corpus/*.jsonl", () => {
  it("istnieją i każda linia jest poprawnym CorpusRecord", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      f.lines.forEach((line, i) => {
        const parsed = CorpusRecord.safeParse(JSON.parse(line));
        expect(parsed.success, `${f.name}:${i + 1}`).toBe(true);
      });
    }
  });

  it("id są unikalne w całym korpusie i mają postać `sourceId:hash`", () => {
    const seen = new Set<string>();
    for (const f of files) {
      for (const line of f.lines) {
        const r = CorpusRecord.parse(JSON.parse(line));
        expect(seen.has(r.id), r.id).toBe(false);
        seen.add(r.id);
        expect(r.id.startsWith(`${r.sourceId}:`), r.id).toBe(true);
      }
    }
  });

  it("spełnia progi zadania: >= 300 rekordów, >= 12 hostów, 3 typy źródeł", () => {
    const { records, errors } = readCorpus();
    expect(errors).toEqual([]);
    expect(records.length).toBeGreaterThanOrEqual(300);
    const hosts = new Set(records.map((r) => new URL(r.url).hostname));
    expect(hosts.size).toBeGreaterThanOrEqual(12);
    expect(new Set(records.map((r) => r.type))).toEqual(new Set(["pierwotne", "factcheck", "analiza"]));
  });

  it("każdy rekord ma tytuł, wydawcę, datę pobrania, link i fragment; daty są poprawne", () => {
    for (const r of readCorpus().records) {
      expect(r.title.trim().length, r.id).toBeGreaterThan(3);
      expect(r.publisher.trim().length, r.id).toBeGreaterThan(2);
      expect(r.text.trim().length, r.id).toBeGreaterThan(20);
      expect(r.text.length, r.id).toBeLessThanOrEqual(1700);
      expect(["http:", "https:"]).toContain(new URL(r.url).protocol);
      expect(Number.isNaN(Date.parse(r.fetchedAt)), r.id).toBe(false);
      expect(r.fetchedAt.endsWith("Z"), r.id).toBe(true);
      if (r.publishedAt !== null) {
        expect(Number.isNaN(Date.parse(r.publishedAt)), `${r.id} ${r.publishedAt}`).toBe(false);
        // data publikacji nie może być późniejsza niż pobranie (+1 dzień na strefy czasowe)
        expect(Date.parse(r.publishedAt), `${r.id} ${r.publishedAt}`).toBeLessThanOrEqual(Date.parse(r.fetchedAt) + 86_400_000);
      }
    }
  });

  it("host każdego rekordu jest w katalogu (dokładnie) i pola rekordu zgadzają się z wpisem katalogu", () => {
    for (const r of readCorpus().records) {
      if (r.origin === "organizer") continue;
      const host = new URL(r.url).hostname;
      const src = catalogSourceForHost(host);
      expect(src, `${r.id}: host ${host} spoza katalogu`).toBeDefined();
      expect(src!.id, r.id).toBe(r.sourceId);
      expect(r.level, r.id).toBe(src!.level);
      expect(r.type, r.id).toBe(src!.type);
      expect(r.role, r.id).toBe(src!.role);
      expect(r.independenceGroup, r.id).toBe(src!.independenceGroup);
      expect(r.licence, r.id).toBe(src!.licence);
    }
  });

  it("rekordy o stałej roli zawierają tezę i tylko potwierdzone etykiety wydawcy", () => {
    for (const r of readCorpus().records) {
      if (r.role === "stala_rola") {
        expect(r.claimReviewed, r.id).toBeTruthy();
        if (r.sourceId === "euvsdisinfo" && r.topics.includes("euvsdisinfo-mcp")) {
          expect(r.rating, r.id).toBeUndefined();
        } else {
          expect(r.rating?.raw, r.id).toBeTruthy();
        }
        // teza jest częścią tekstu rekordu (dosłownie)
        expect(r.text.includes(r.claimReviewed!), r.id).toBe(true);
      } else {
        expect(r.claimReviewed, r.id).toBeUndefined();
        expect(r.rating, r.id).toBeUndefined();
      }
    }
  });

  it("treści redakcyjne to metadane + krótki cytat (<= 300 znaków dla gov.pl i EUvsDisinfo, uzasadnienie fact-checku <= 300)", () => {
    const fixedFactchecks = new Set(["pravda-pl", "dpa-factchecking", "dw-factcheck", "factcheck-org", "politifact", "demagog"]);
    for (const r of readCorpus().records) {
      if (["gov-pl", "euvsdisinfo", "prezydent-pl", "senat-pl"].includes(r.sourceId)) expect(r.text.length, r.id).toBeLessThanOrEqual(300);
      if (fixedFactchecks.has(r.sourceId)) {
        const [, ...rest] = r.text.split("\n");
        expect(rest.join("\n").length, r.id).toBeLessThanOrEqual(300);
      }
    }
  });

  it("rekordy generowane z danych są oznaczone, a url wskazuje zapytanie do API", () => {
    const recs = readCorpus().records.filter((r) => r.sourceId === "eurostat");
    expect(recs.length).toBeGreaterThan(50);
    for (const r of recs) {
      expect(r.topics, r.id).toContain("generated-from-data");
      expect(r.url, r.id).toContain("ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/");
      expect(r.period, r.id).toBeTruthy();
      expect(r.text, r.id).toMatch(/\d/);
    }
    // Zdania generowane z danych występują tylko w źródłach, które to dokumentują (docs/SOURCES.md).
    const allowed = new Set(["eurostat", "sejm-eli", "gov-pl", "ep-open-data", "gus-bdl", "ec-finance", "eu-portal", "nato"]);
    for (const r of readCorpus().records) {
      if (r.topics.includes("generated-from-data")) expect(allowed.has(r.sourceId), r.id).toBe(true);
      if (r.sourceId === "gus-bdl") {
        expect(r.topics, r.id).toContain("generated-from-data");
        expect(r.url, r.id).toMatch(/^https:\/\/bdl\.stat\.gov\.pl\/api\/v1\/data\//);
        expect(r.period, r.id).toBeTruthy();
      }
    }
  });

  it("osoby pełniące funkcje: rekordy posłów to zdania z API (url wpisu posła, publishedAt null, bez danych prywatnych)", () => {
    const mps = readCorpus().records.filter((r) => r.sourceId === "sejm-eli" && /\/sejm\/term\d+\/MP\/\d+$/.test(r.url));
    expect(mps.length).toBeGreaterThan(400);
    for (const r of mps) {
      expect(r.topics, r.id).toContain("generated-from-data");
      expect(r.topics, r.id).toContain("posel");
      expect(r.publishedAt, r.id).toBeNull();
      expect(r.text, r.id).toMatch(/poseł\/posłanka/);
      expect(r.text, r.id).not.toMatch(/@|urodz|ur\. /i);
      expect(r.level).toBe(1);
    }
    const active = mps.filter((r) => r.topics.includes("mandat-aktywny"));
    expect(active.length).toBeGreaterThan(400);
    for (const r of active) expect(r.text, r.id).toMatch(/klub lub koło poselskie|poseł niezrzeszony/);
    expect(readCorpus().records.some((r) => r.sourceId === "sejm-eli" && r.topics.includes("klub-poselski") && /\/clubs\//.test(r.url))).toBe(true);
  });

  it("osoby pełniące funkcje: są rekordy o rządzie, MSZ, ambasadorach, Prezydencie, Senacie, Marszałku Sejmu, Komisji, NATO i PE", () => {
    const recs = readCorpus().records;
    const bySource = (id: string) => recs.filter((r) => r.sourceId === id);
    const mfa = recs.find((r) => r.sourceId === "gov-pl" && r.topics.includes("msz") && /Minister Spraw Zagranicznych/.test(r.text) && !r.topics.includes("generated-from-data"));
    expect(mfa, "minister spraw zagranicznych").toBeDefined();
    expect(mfa!.url).toMatch(/^https:\/\/www\.gov\.pl\/web\//);
    expect(recs.filter((r) => r.sourceId === "gov-pl" && r.topics.includes("rada-ministrow")).length).toBeGreaterThanOrEqual(15);
    expect(recs.filter((r) => r.sourceId === "gov-pl" && r.topics.includes("ambasador")).length).toBeGreaterThanOrEqual(50);
    expect(bySource("prezydent-pl").some((r) => /Prezydent Rzeczypospolitej Polskiej/.test(r.text))).toBe(true);
    expect(bySource("senat-pl").some((r) => r.topics.includes("marszalek-senatu") && /Marszałek$/.test(r.text))).toBe(true);
    expect(recs.some((r) => r.sourceId === "sejm-eli" && r.topics.includes("marszalek-sejmu") && /^Marszałek Sejmu: /.test(r.text))).toBe(true);
    expect(bySource("ec-commission").some((r) => r.topics.includes("przewodniczacy-komisji") && r.text.startsWith("The President "))).toBe(true);
    expect(bySource("ec-commission").some((r) => r.topics.includes("wysoki-przedstawiciel"))).toBe(true);
    expect(bySource("ep-open-data").length).toBeGreaterThan(40);
    expect(bySource("nato").some((r) => /The post is currently held by/.test(r.text))).toBe(true);
  });

  it("Demagog: rekordy ClaimReview o stałej roli, poziom 2, ocena z tabeli mapowania, url na hoście wydawcy", () => {
    const dem = readCorpus().records.filter((r) => r.sourceId === "demagog");
    expect(dem.length).toBeGreaterThan(50);
    for (const r of dem) {
      expect(new URL(r.url).hostname, r.id).toBe("demagog.org.pl");
      expect(r.role).toBe("stala_rola");
      expect(r.level).toBe(2);
      expect(r.rating?.raw, r.id).toBeTruthy();
      expect(r.publishedAt, r.id).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    expect(dem.filter((r) => r.rating?.mapped !== null).length / dem.length).toBeGreaterThan(0.8);
  });

  it("poziom/typ: źródła pierwotne mają poziom 1, fact-checki IFCN/EFCSN poziom 2", () => {
    const catalog = new Map(loadCatalog().map((s) => [s.id, s]));
    for (const r of readCorpus().records) {
      const src = catalog.get(r.sourceId)!;
      if (r.type === "pierwotne") expect(r.level).toBe(1);
      if (r.type === "factcheck" && src.ifcnEfcsn) expect(r.level).toBe(2);
    }
  });
});

describe("incydenty data/incidents/*.jsonl", () => {
  const PLATFORMS = ["facebook.com", "x.com", "twitter.com", "youtube.com", "t.me", "tiktok.com", "instagram.com"];
  it("poprawne rekordy, unikalne id, powiązania z istniejącymi rekordami, bez platform w domenach", () => {
    const { records, incidents } = readCorpus();
    expect(incidentFiles().length).toBeGreaterThan(0);
    expect(incidents.length).toBeGreaterThan(100);
    const ids = new Set(records.map((r) => r.id));
    const seen = new Set<string>();
    for (const i of incidents) {
      IncidentRecord.parse(i);
      expect(seen.has(i.id), i.id).toBe(false);
      seen.add(i.id);
      if (i.recordId) expect(ids.has(i.recordId), `${i.id} -> ${i.recordId}`).toBe(true);
      for (const d of i.domains) {
        expect(d, i.id).toBe(d.toLowerCase());
        expect(PLATFORMS.some((p) => d === p || d.endsWith(`.${p}`)), `${i.id}: ${d}`).toBe(false);
      }
    }
  });
});

describe("ładowanie prawdziwego korpusu do SQLite", () => {
  it("ładuje wszystkie rekordy, jest idempotentne, a wyszukiwanie FTS zwraca sensowne trafienia", () => {
    const db = openDatabase(":memory:");
    const first = ensureCorpusLoaded(db);
    const second = ensureCorpusLoaded(db);
    expect(second).toEqual(first);
    const store = createCorpusStore(db);
    expect(store.count()).toBe(readCorpus().records.length);

    const search = (q: string, n = 5) =>
      (db
        .prepare("SELECT r.id, r.source_id, r.title FROM records_fts f JOIN records r ON r.rowid = f.rowid WHERE records_fts MATCH ? ORDER BY bm25(records_fts, 5.0, 1.0, 3.0) LIMIT ?")
        .all(q, n) as { id: string; source_id: string; title: string }[]);

    // fakt o członkostwie Polski w NATO od 1999 r. — strona NATO z listą państw
    const nato = search("Poland 1999 NATO member countries");
    expect(nato.some((h) => h.source_id === "nato")).toBe(true);
    // sankcje UE wobec Rosji — rozporządzenie 833/2014 (EUR-Lex) albo polska ustawa sankcyjna
    const sanctions = search("ograniczających Rosji");
    expect(sanctions.some((h) => h.source_id === "eur-lex" || h.source_id === "sejm-eli")).toBe(true);
    // fact-check Pravdy o Ukrainie
    const pravda = search("uchodźcy z Ukrainy obywatelstwo");
    expect(pravda.some((h) => h.source_id === "pravda-pl" || h.source_id === "sejm-eli")).toBe(true);
    // statystyki z Eurostatu: ochrona czasowa Ukraińców
    const eurostat = search("ochroną czasową objętych obywateli Ukrainy");
    expect(eurostat[0]?.source_id).toBe("eurostat");
    // wydatki na obronę jako % PKB
    expect(search("wydatki na obronę narodową PKB Polsce").some((h) => h.source_id === "eurostat")).toBe(true);

    const meta = db.prepare("SELECT value FROM corpus_meta WHERE key = 'snapshot_id'").get() as { value: string };
    expect(meta.value).toBe(first.snapshotId);
    db.close();
  });
});
