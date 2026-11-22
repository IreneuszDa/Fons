import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CorpusRecord } from "../shared/contracts";
import { computeSnapshotId, createCorpusStore, ensureCorpusLoaded, foldPolish, liveExpiryMs, openDatabase } from "./store";
import type { IncidentRecord } from "./types";

function rec(id: string, over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id,
    sourceId: "test-src",
    url: `https://example.org/${id}`,
    title: `Tytuł ${id}`,
    publisher: "Wydawca testowy",
    publishedAt: "2025-01-02",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    lang: "pl",
    text: `Treść rekordu ${id}`,
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: "g1",
    licence: "test",
    topics: [],
    origin: "corpus",
    ...over,
  };
}

let dir: string;
const catalogSource = { id: "test-src", hosts: ["example.org"], publisher: "Wydawca testowy", role: "tresc", type: "pierwotne",
  level: 1, independenceGroup: "g1", licence: "test", fetchMethod: "dump", updateFrequency: "test", qualification: "test", homepage: "https://example.org/" };
function writeCorpus(file: string, records: CorpusRecord[]): void {
  mkdirSync(resolve(dir, "corpus"), { recursive: true });
  writeFileSync(resolve(dir, "corpus", file), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
function writeIncidents(file: string, incidents: IncidentRecord[]): void {
  mkdirSync(resolve(dir, "incidents"), { recursive: true });
  writeFileSync(resolve(dir, "incidents", file), incidents.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "prawdowid-corpus-"));
  writeFileSync(resolve(dir, "sources.yaml"), JSON.stringify([catalogSource,
    { ...catalogSource, id: "review", hosts: ["review.example"], role: "stala_rola", type: "factcheck", level: 2 }]));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureCorpusLoaded", () => {
  it("ładuje rekordy i incydenty, zwraca migawkę, a CorpusStore je czyta", () => {
    writeCorpus("a.jsonl", [
      rec("a:1", { title: "Sankcje UE wobec Rosji", text: "Unia Europejska przyjęła kolejny pakiet sankcji." }),
      rec("a:2", {
        sourceId: "review", url: "https://review.example/article",
        role: "stala_rola",
        type: "factcheck",
        level: 2,
        claimReviewed: "Polska wychodzi z NATO",
        rating: { raw: "Fałsz", mapped: "FALSZYWE", binary: true },
        topics: ["nato"],
        period: "2025-03",
        supersededAt: "2026-04-01",
        text: "Polska wychodzi z NATO",
      }),
    ]);
    writeIncidents("i.jsonl", [
      { id: "inc:1", title: "Polska wychodzi z NATO", summary: "Narracja w sieci", url: "https://example.org/inc1", domains: ["fake.example"], publishedAt: "2025-03-01", recordId: "a:2" },
    ]);
    const db = openDatabase(":memory:");
    const res = ensureCorpusLoaded(db, { dataDir: dir });
    expect(res.records).toBe(2);
    expect(res.snapshotId).toMatch(/^[0-9a-f]{64}$/);

    const store = createCorpusStore(db);
    expect(store.count()).toBe(2);
    expect(store.snapshotId()).toBe(res.snapshotId);
    const fc = store.get("a:2")!;
    expect(fc.rating).toEqual({ raw: "Fałsz", mapped: "FALSZYWE", binary: true });
    expect(fc.claimReviewed).toBe("Polska wychodzi z NATO");
    expect(fc.period).toBe("2025-03");
    expect(fc.supersededAt).toBe("2026-04-01");
    expect(fc.topics).toEqual(["nato"]);
    expect(store.get("a:1")!.rating).toBeUndefined();
    expect(store.get("brak")).toBeUndefined();
    expect(store.getMany(["a:2", "nie-ma", "a:1"]).map((r) => r.id)).toEqual(["a:2", "a:1"]);
    const inc = db.prepare("SELECT * FROM incidents WHERE id = 'inc:1'").get() as { domains_json: string; record_id: string };
    expect(JSON.parse(inc.domains_json)).toEqual(["fake.example"]);
    expect(inc.record_id).toBe("a:2");
    db.close();
  });

  it("jest idempotentne: drugie wywołanie nie przeładowuje danych i daje tę samą migawkę", () => {
    writeCorpus("a.jsonl", [rec("a:1"), rec("a:2")]);
    const db = openDatabase(":memory:");
    const first = ensureCorpusLoaded(db, { dataDir: dir });
    const loadedAt = (db.prepare("SELECT value FROM corpus_meta WHERE key='corpus_loaded_at'").get() as { value: string }).value;
    // wektor ma przetrwać nieprzeładowanie
    db.prepare("INSERT INTO record_embeddings(record_id, vector) VALUES('a:1', ?)").run(Buffer.from([1, 2, 3]));
    const second = ensureCorpusLoaded(db, { dataDir: dir });
    expect(second).toEqual(first);
    expect((db.prepare("SELECT value FROM corpus_meta WHERE key='corpus_loaded_at'").get() as { value: string }).value).toBe(loadedAt);
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_embeddings").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("odświeża ocenę źródła i wycofuje rekordy, indeks oraz ostrzeżenia po zmianie samego katalogu", () => {
    const record = rec("a:1", { url: "https://example.org/research/1", text: "Badanie heliosfery" });
    writeCorpus("a.jsonl", [record]);
    writeIncidents("i.jsonl", [{ id: "i", url: record.url, title: "Badanie", summary: "Opis", domains: ["example.net"], publishedAt: null, recordId: record.id }]);
    const db = openDatabase(":memory:");
    const first = ensureCorpusLoaded(db, { dataDir: dir });
    const revised = { ...catalogSource, level: 3, type: "analiza", independenceGroup: "new-group" };
    writeFileSync(resolve(dir, "sources.yaml"), JSON.stringify({ catalog: [revised] }));
    const second = ensureCorpusLoaded(db, { dataDir: dir });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(createCorpusStore(db).get(record.id)).toMatchObject({ level: 3, type: "analiza", independenceGroup: "new-group" });
    writeFileSync(resolve(dir, "sources.yaml"), JSON.stringify([{ ...revised, pathPrefixes: ["/legal/"] }]));
    const third = ensureCorpusLoaded(db, { dataDir: dir, onWarning: () => {} });
    expect(third).toMatchObject({ records: 0 });
    expect(third.snapshotId).not.toBe(second.snapshotId);
    expect(db.prepare("SELECT 1 FROM records_fts WHERE records_fts MATCH 'heliosfery'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM incidents").get()).toBeUndefined();
    db.close();
  });

  it("stary wpis importera bez roli recenzji pozostaje nierozstrzygający także po podmianie pakietu", () => {
    const r = rec("review:old", { sourceId: "review", role: "tresc", url: "https://review.example/old", origin: "organizer",
      rating: { raw: "Prawda", mapped: "POTWIERDZONE", binary: true } });
    writeCorpus("organizer-old.jsonl", [r]);
    const db = openDatabase(":memory:");
    ensureCorpusLoaded(db, { dataDir: dir });
    expect(createCorpusStore(db).get(r.id)).toMatchObject({ role: "stala_rola", type: "factcheck" });
    expect(createCorpusStore(db).get(r.id)?.rating).toBeUndefined();
    db.close();
  });

  it("migawka nie zależy od kolejności linii ani plików, ale zmienia się przy zmianie treści", () => {
    writeCorpus("a.jsonl", [rec("a:1"), rec("a:2")]);
    const s1 = computeSnapshotId(dir);
    writeCorpus("a.jsonl", [rec("a:2"), rec("a:1")]);
    expect(computeSnapshotId(dir)).toBe(s1);
    writeCorpus("a.jsonl", [rec("a:1"), rec("a:2", { text: "Zmieniona treść" })]);
    expect(computeSnapshotId(dir)).not.toBe(s1);
  });

  it("przy zmianie migawki przeładowuje rekordy, przebudowuje FTS i czyści tylko wektory zmienionych/usuniętych rekordów", () => {
    writeCorpus("a.jsonl", [rec("a:1", { text: "pierwotna treść jeden" }), rec("a:2", { text: "pierwotna treść dwa" }), rec("a:3", { text: "pierwotna treść trzy" })]);
    const db = openDatabase(":memory:");
    const first = ensureCorpusLoaded(db, { dataDir: dir });
    const ins = db.prepare("INSERT INTO record_embeddings(record_id, vector) VALUES(?, ?)");
    for (const id of ["a:1", "a:2", "a:3"]) ins.run(id, Buffer.from([1]));

    // a:1 bez zmian, a:2 zmieniony, a:3 usunięty, a:4 nowy
    writeCorpus("a.jsonl", [rec("a:1", { text: "pierwotna treść jeden" }), rec("a:2", { text: "zupełnie nowy tekst o energetyce" }), rec("a:4", { text: "rekord czwarty" })]);
    const second = ensureCorpusLoaded(db, { dataDir: dir });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.records).toBe(3);
    expect(createCorpusStore(db).snapshotId()).toBe(second.snapshotId);
    expect(createCorpusStore(db).get("a:3")).toBeUndefined();
    const vec = (db.prepare("SELECT record_id FROM record_embeddings ORDER BY record_id").all() as { record_id: string }[]).map((r) => r.record_id);
    expect(vec).toEqual(["a:1"]);

    // FTS odświeżony: stary tekst a:2 nieobecny, nowy znajdowalny
    const hit = (q: string) => (db.prepare("SELECT r.id FROM records_fts f JOIN records r ON r.rowid = f.rowid WHERE records_fts MATCH ?").all(q) as { id: string }[]).map((x) => x.id);
    expect(hit("energetyce")).toEqual(["a:2"]);
    expect(hit("dwa")).toEqual([]);
    expect(hit("trzy")).toEqual([]);
    expect(hit("czwarty")).toEqual(["a:4"]);
    db.close();
  });

  it("pomija linie niezgodne ze schematem (z ostrzeżeniem) i duplikaty id", () => {
    writeCorpus("a.jsonl", [rec("a:1"), rec("a:1", { text: "duplikat" })]);
    appendFileSync(resolve(dir, "corpus", "a.jsonl"), `{"id":"zly","url":"nie-url"}\n`);
    const warnings: string[] = [];
    const db = openDatabase(":memory:");
    const res = ensureCorpusLoaded(db, { dataDir: dir, onWarning: (m) => warnings.push(m) });
    expect(res.records).toBe(1);
    expect(warnings.join(" ")).toMatch(/pominięto 2/);
    db.close();
  });

  it("FTS: wyszukiwanie z ogonkami, a tabela records_fold pozwala szukać bez ogonków (także ł)", () => {
    writeCorpus("a.jsonl", [
      rec("a:1", { title: "Ochrona międzynarodowa", text: "Cudzoziemiec może złożyć wniosek o udzielenie ochrony międzynarodowej w Polsce." }),
      rec("a:2", { title: "Żółć", text: "Zupełnie inny tekst o gęślach" }),
    ]);
    const db = openDatabase(":memory:");
    ensureCorpusLoaded(db, { dataDir: dir });
    const ftsHit = (q: string) => (db.prepare("SELECT r.id FROM records_fts f JOIN records r ON r.rowid = f.rowid WHERE records_fts MATCH ? ORDER BY bm25(records_fts)").all(q) as { id: string }[]).map((x) => x.id);
    expect(ftsHit("międzynarodowej")).toEqual(["a:1"]);
    expect(ftsHit("miedzynarodowej")).toEqual(["a:1"]); // remove_diacritics działa dla ę/ó/ą/ś/ż/ć/ń
    const foldHit = (q: string) => (db.prepare("SELECT r.id FROM records_fold f JOIN records r ON r.rowid = f.rowid WHERE records_fold MATCH ?").all(foldPolish(q)) as { id: string }[]).map((x) => x.id);
    expect(foldHit("zolc")).toEqual(["a:2"]); // ł nie jest składane przez unicode61 — to robi foldPolish
    expect(foldHit("gesla")).toEqual([]); // "gęślach" to inna forma — brak stemmingu
    expect(foldHit("gesl*")).toEqual(["a:2"]);
    expect(foldPolish("Żółć Łódź")).toBe("Zolc Lodz");
    db.close();
  });
});

describe("CorpusStore: awaryjny odczyt z live_snapshots", () => {
  const NOW = new Date("2026-11-21T12:00:00.000Z");
  const LIVE_DDL =
    "CREATE TABLE live_snapshots(id TEXT PRIMARY KEY, run_id TEXT, record_json TEXT, created_at TEXT, expires_at TEXT)";

  function liveRecord(id: string, over: Partial<CorpusRecord> = {}): CorpusRecord {
    return rec(id, { origin: "live_snapshot", url: "https://example.org/news/article", ...over });
  }
  function insertLive(db: ReturnType<typeof openDatabase>, id: string, json: string, expiresAt: string | null) {
    db.prepare("INSERT INTO live_snapshots(id, run_id, record_json, created_at, expires_at) VALUES(?, ?, ?, ?, ?)").run(
      id,
      "run-1",
      json,
      "2026-11-21T11:00:00.000Z",
      expiresAt,
    );
  }

  it("bez tabeli live_snapshots id live:* po prostu nie istnieje (bez wyjątku), a zwykłe rekordy działają", () => {
    writeCorpus("a.jsonl", [rec("a:1")]);
    const db = openDatabase(":memory:");
    ensureCorpusLoaded(db, { dataDir: dir });
    const store = createCorpusStore(db, { now: () => NOW });
    expect(store.get("live:abc")).toBeUndefined();
    expect(store.getMany(["a:1", "live:abc"]).map((r) => r.id)).toEqual(["a:1"]);
    expect(store.count()).toBe(1);
    db.close();
  });

  it("zwraca niewygasły rekord z live_snapshots (id wiersza, origin live_snapshot), także w getMany", () => {
    writeCorpus("a.jsonl", [rec("a:1")]);
    const db = openDatabase(":memory:");
    ensureCorpusLoaded(db, { dataDir: dir });
    db.exec(LIVE_DDL);
    // record_json bez zgodnego origin/id: magazyn ustawia oba pola
    insertLive(db, "live:1", JSON.stringify(liveRecord("inne-id", { origin: "corpus", title: "Rekord z migawki live" })), "2026-11-21T13:00:00.000Z");
    const store = createCorpusStore(db, { now: () => NOW });
    const got = store.get("live:1")!;
    expect(got.id).toBe("live:1");
    expect(got.origin).toBe("live_snapshot");
    expect(got.title).toBe("Rekord z migawki live");
    expect(store.getMany(["a:1", "live:1", "live:nie-ma"]).map((r) => r.id)).toEqual(["a:1", "live:1"]);
    // migawki live nie liczą się do rozmiaru korpusu
    expect(store.count()).toBe(1);
    db.close();
  });

  it("ignoruje wygasłe wiersze; brak terminu (NULL) nie wygasa; rozumie formaty ISO, SQLite i epokę", () => {
    const db = openDatabase(":memory:");
    db.exec(LIVE_DDL);
    const json = JSON.stringify(liveRecord("x"));
    insertLive(db, "live:expired", json, "2026-11-21T11:59:59.000Z");
    insertLive(db, "live:exactly-now", json, "2026-11-21T12:00:00.000Z");
    insertLive(db, "live:null", json, null);
    insertLive(db, "live:sqlite-future", json, "2026-11-21 12:00:01");
    insertLive(db, "live:sqlite-past", json, "2026-11-21 11:00:00");
    insertLive(db, "live:epoch-ms-future", json, String(NOW.getTime() + 60_000));
    insertLive(db, "live:epoch-s-past", json, String(Math.floor(NOW.getTime() / 1000) - 60));
    insertLive(db, "live:garbage", json, "kiedyś");
    const store = createCorpusStore(db, { now: () => NOW });
    const ids = (list: string[]) => store.getMany(list).map((r) => r.id);
    expect(ids(["live:expired", "live:exactly-now", "live:null", "live:sqlite-future", "live:sqlite-past", "live:epoch-ms-future", "live:epoch-s-past", "live:garbage"])).toEqual([
      "live:null",
      "live:sqlite-future",
      "live:epoch-ms-future",
    ]);
    db.close();
  });

  it("uszkodzony JSON albo rekord niezgodny ze schematem to brak rekordu, nie wyjątek", () => {
    const db = openDatabase(":memory:");
    db.exec(LIVE_DDL);
    insertLive(db, "live:bad-json", "{nie json", null);
    insertLive(db, "live:bad-schema", JSON.stringify({ title: "bez wymaganych pól" }), null);
    const store = createCorpusStore(db, { now: () => NOW });
    expect(store.get("live:bad-json")).toBeUndefined();
    expect(store.get("live:bad-schema")).toBeUndefined();
    db.close();
  });

  it("tabela live_snapshots jest czytana tylko dla id zaczynających się od \"live:\"", () => {
    const db = openDatabase(":memory:");
    db.exec(LIVE_DDL);
    insertLive(db, "a:1", JSON.stringify(liveRecord("a:1")), null);
    insertLive(db, "LIVE:2", JSON.stringify(liveRecord("LIVE:2")), null);
    const store = createCorpusStore(db, { now: () => NOW });
    expect(store.get("a:1")).toBeUndefined();
    expect(store.get("LIVE:2")).toBeUndefined();
    db.close();
  });

  it("rekord z tabeli records ma pierwszeństwo przed wierszem live_snapshots o tym samym id", () => {
    writeCorpus("a.jsonl", [rec("live:dup", { title: "Z korpusu" })]);
    const db = openDatabase(":memory:");
    ensureCorpusLoaded(db, { dataDir: dir });
    db.exec(LIVE_DDL);
    insertLive(db, "live:dup", JSON.stringify(liveRecord("live:dup", { title: "Z migawki" })), null);
    const got = createCorpusStore(db, { now: () => NOW }).get("live:dup")!;
    expect(got.title).toBe("Z korpusu");
    expect(got.origin).toBe("corpus");
    db.close();
  });

  it("liveExpiryMs zwraca null tylko dla braku terminu", () => {
    expect(liveExpiryMs(null)).toBeNull();
    expect(liveExpiryMs("")).toBeNull();
    expect(Number.isNaN(liveExpiryMs("jutro"))).toBe(true);
    expect(liveExpiryMs("2026-11-21T12:00:00Z")).toBe(NOW.getTime());
    expect(liveExpiryMs("2026-11-21 12:00:00")).toBe(NOW.getTime());
  });
});
