/**
 * Baza korpusu: SQLite (better-sqlite3) + FTS5. Jedna baza dla całej usługi — inne moduły dokładają własne tabele.
 *
 * Schemat (właściciel: korpus), zgodny z docs/MODULES.md:
 *   records, records_fts (FTS5, content='records'), incidents, incidents_fts, corpus_meta, record_embeddings.
 * Dodatkowo (pomocniczo): records_fold — zwykła tabela FTS5 z tekstem bez polskich znaków diakrytycznych
 * (w tym "ł" -> "l", którego unicode61 nie składa), do zapytań wpisanych bez ogonków.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { CorpusRecord, type CorpusStore, type FixedRating } from "../shared/contracts";
import { corpusFiles, incidentFiles, readCorpus } from "./files";
import { clearCatalogCache, loadCatalog, sourceAtUrl } from "./catalog";
import type { IncidentRecord } from "./types";
import { publicationLinks } from "./publication-links";

type Db = Database.Database;
const activeCatalogs = new WeakMap<Db, ReturnType<typeof loadCatalog>>();

const FTS_TOKENIZE = "unicode61 remove_diacritics 2";

/** Składa polskie (i inne łacińskie) znaki diakrytyczne, w tym "ł"/"Ł" — do wyszukiwania bez ogonków. */
export function foldPolish(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L");
}

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  initCorpusSchema(db);
  return db;
}

export function initCorpusSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      publisher TEXT NOT NULL,
      published_at TEXT,
      fetched_at TEXT NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      level INTEGER NOT NULL,
      independence_group TEXT NOT NULL,
      licence TEXT NOT NULL,
      claim_reviewed TEXT,
      rating_json TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      period TEXT,
      superseded_at TEXT,
      origin TEXT NOT NULL DEFAULT 'corpus'
    );
    CREATE INDEX IF NOT EXISTS idx_records_source ON records(source_id);
    CREATE INDEX IF NOT EXISTS idx_records_role ON records(role);
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      title, text, claim_reviewed,
      content='records', content_rowid='rowid',
      tokenize='${FTS_TOKENIZE}'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fold USING fts5(
      title, text, claim_reviewed,
      tokenize='${FTS_TOKENIZE}'
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      url TEXT NOT NULL,
      domains_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT,
      record_id TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(
      title, summary,
      content='incidents', content_rowid='rowid',
      tokenize='${FTS_TOKENIZE}'
    );
    CREATE TABLE IF NOT EXISTS corpus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS record_embeddings (record_id TEXT PRIMARY KEY, vector BLOB NOT NULL);
  `);
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('records') WHERE name = 'superseded_at'").get()) {
      db.exec("ALTER TABLE records ADD COLUMN superseded_at TEXT");
      db.prepare("DELETE FROM corpus_meta WHERE key = 'snapshot_id'").run();
    }
  }).immediate();
}

// ───────────────────────────── Migawka ─────────────────────────────

/** A catalogue policy change also invalidates cached verification results. */
export function computeSnapshotId(dataDir?: string, catalog = loadCatalog(dataDir)): string {
  const h = createHash("sha256");
  const parts: { name: string; lines: string[] }[] = [
    { name: "sources", lines: catalog.map(s => JSON.stringify(s)) },
    ...corpusFiles(dataDir).map((f) => ({ name: `corpus/${f.name}`, lines: f.lines })),
    ...incidentFiles(dataDir).map((f) => ({ name: `incidents/${f.name}`, lines: f.lines })),
  ];
  const links = publicationLinks(dataDir);
  if (links.length) parts.push({ name: "publication-links", lines: links.map(link => JSON.stringify(link)) });
  parts.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const p of parts) {
    h.update(`#${p.name}\n`);
    for (const l of [...p.lines].sort()) h.update(l + "\n");
  }
  return h.digest("hex");
}

function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM corpus_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO corpus_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function contentHash(r: { title: string; text: string; claimReviewed?: string | null }): string {
  return createHash("sha1").update(`${r.title}\u0000${r.text}\u0000${r.claimReviewed ?? ""}`).digest("hex");
}

export interface LoadOptions {
  dataDir?: string;
  /** Wymuś przeładowanie mimo zgodnej migawki. */
  force?: boolean;
  /** Komunikaty o pominiętych/uszkodzonych liniach. */
  onWarning?: (msg: string) => void;
}

/**
 * Ładuje data/corpus/*.jsonl i data/incidents/*.jsonl do bazy. Idempotentne: gdy migawka się nie zmieniła
 * (a tabele są kompletne), nic nie robi. Przy zmianie: przeładowuje rekordy, przebudowuje FTS i usuwa wektory
 * rekordów usuniętych lub o zmienionej treści (wektory pozostałych zostają).
 */
export function ensureCorpusLoaded(db: Db, opts: LoadOptions = {}): { snapshotId: string; records: number } {
  initCorpusSchema(db);
  clearCatalogCache();
  const catalog = loadCatalog(opts.dataDir);
  const snapshotId = computeSnapshotId(opts.dataDir, catalog);
  const loaded = readCorpus(opts.dataDir, catalog);
  if (loaded.errors.length) {
    (opts.onWarning ?? ((m) => console.warn(m)))(`corpus: pominięto ${loaded.errors.length} nieprawidłowych linii (np. ${loaded.errors[0]})`);
  }
  const recordsCount = (db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n;
  const incidentsCount = (db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n;
  const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM records_fold").get() as { n: number }).n;
  if (
    !opts.force &&
    getMeta(db, "snapshot_id") === snapshotId &&
    getMeta(db, "fts_snapshot_id") === snapshotId &&
    recordsCount === loaded.records.length &&
    incidentsCount === loaded.incidents.length &&
    ftsCount === loaded.records.length
  ) {
    activeCatalogs.set(db, catalog);
    return { snapshotId, records: recordsCount };
  }

  const tx = db.transaction(() => {
    const oldHashes = new Map<string, string>();
    for (const row of db.prepare("SELECT id, title, text, claim_reviewed FROM records").all() as {
      id: string;
      title: string;
      text: string;
      claim_reviewed: string | null;
    }[]) {
      oldHashes.set(row.id, contentHash({ title: row.title, text: row.text, claimReviewed: row.claim_reviewed }));
    }

    db.exec("DELETE FROM records; DELETE FROM incidents; DELETE FROM records_fold;");

    const insRec = db.prepare(
      `INSERT INTO records(id, source_id, url, title, publisher, published_at, fetched_at, lang, text, role, type, level,
         independence_group, licence, claim_reviewed, rating_json, topics_json, period, superseded_at, origin)
       VALUES(@id, @source_id, @url, @title, @publisher, @published_at, @fetched_at, @lang, @text, @role, @type, @level,
         @independence_group, @licence, @claim_reviewed, @rating_json, @topics_json, @period, @superseded_at, @origin)`,
    );
    const insFold = db.prepare("INSERT INTO records_fold(rowid, title, text, claim_reviewed) VALUES(?, ?, ?, ?)");
    const rowidOf = db.prepare("SELECT rowid FROM records WHERE id = ?");
    for (const r of loaded.records) {
      insRec.run({
        id: r.id,
        source_id: r.sourceId,
        url: r.url,
        title: r.title,
        publisher: r.publisher,
        published_at: r.publishedAt,
        fetched_at: r.fetchedAt,
        lang: r.lang,
        text: r.text,
        role: r.role,
        type: r.type,
        level: r.level,
        independence_group: r.independenceGroup,
        licence: r.licence,
        claim_reviewed: r.claimReviewed ?? null,
        rating_json: r.rating ? JSON.stringify(r.rating) : null,
        topics_json: JSON.stringify(r.topics),
        period: r.period ?? null,
        superseded_at: r.supersededAt ?? null,
        origin: r.origin,
      });
      const rowid = (rowidOf.get(r.id) as { rowid: number }).rowid;
      insFold.run(rowid, foldPolish(r.title), foldPolish(r.text), foldPolish(r.claimReviewed ?? ""));
    }

    const insInc = db.prepare(
      "INSERT INTO incidents(id, title, summary, url, domains_json, published_at, record_id) VALUES(?, ?, ?, ?, ?, ?, ?)",
    );
    for (const i of loaded.incidents as IncidentRecord[]) {
      const outlets = [...i.domains, ...(i.channels ?? []).map(channel => ({ channel }))];
      insInc.run(i.id, i.title, i.summary, i.url, JSON.stringify(outlets), i.publishedAt, i.recordId);
    }

    db.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild'); INSERT INTO incidents_fts(incidents_fts) VALUES('rebuild');");

    // Wektory: zostają tylko dla rekordów istniejących i o niezmienionej treści.
    const keep = new Set<string>();
    for (const r of loaded.records) {
      if (oldHashes.get(r.id) === contentHash(r)) keep.add(r.id);
    }
    const embIds = db.prepare("SELECT record_id FROM record_embeddings").all() as { record_id: string }[];
    const delEmb = db.prepare("DELETE FROM record_embeddings WHERE record_id = ?");
    for (const e of embIds) if (!keep.has(e.record_id)) delEmb.run(e.record_id);

    setMeta(db, "snapshot_id", snapshotId);
    setMeta(db, "fts_snapshot_id", snapshotId);
    setMeta(db, "corpus_records", String(loaded.records.length));
    setMeta(db, "corpus_incidents", String(loaded.incidents.length));
    setMeta(db, "corpus_loaded_at", new Date().toISOString());
  });
  tx();
  activeCatalogs.set(db, catalog);
  return { snapshotId, records: loaded.records.length };
}

// ───────────────────────────── CorpusStore ─────────────────────────────

interface RecordRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  publisher: string;
  published_at: string | null;
  fetched_at: string;
  lang: string;
  text: string;
  role: string;
  type: string;
  level: number;
  independence_group: string;
  licence: string;
  claim_reviewed: string | null;
  rating_json: string | null;
  topics_json: string;
  period: string | null;
  superseded_at: string | null;
  origin: string;
}

export function rowToRecord(row: RecordRow): CorpusRecord {
  const rec: Record<string, unknown> = {
    id: row.id,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    lang: row.lang,
    text: row.text,
    role: row.role,
    type: row.type,
    level: row.level,
    independenceGroup: row.independence_group,
    licence: row.licence,
    topics: JSON.parse(row.topics_json) as string[],
    origin: row.origin,
  };
  if (row.claim_reviewed !== null) rec.claimReviewed = row.claim_reviewed;
  if (row.rating_json) rec.rating = JSON.parse(row.rating_json) as FixedRating;
  if (row.period !== null) rec.period = row.period;
  if (row.superseded_at) rec.supersededAt = row.superseded_at;
  return CorpusRecord.parse(rec);
}

/** Prefiks identyfikatorów rekordów z migawek wyszukiwania na żywo (tabela live_snapshots, poza migawką korpusu). */
export const LIVE_ID_PREFIX = "live:";

interface LiveSnapshotRow {
  record_json: string;
  expires_at: string | number | null;
}

/**
 * Moment wygaśnięcia wiersza live_snapshots jako milisekundy (UTC) albo null = brak terminu (nie wygasa).
 * Przyjmuje ISO-8601, "RRRR-MM-DD GG:MM:SS" (SQLite datetime, UTC) oraz liczby (sekundy lub milisekundy epoki).
 * Wartość nieczytelna daje NaN — wiersz jest wtedy traktowany jak wygasły (nie serwujemy dowodu o nieznanym TTL).
 */
export function liveExpiryMs(v: string | number | null): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }
  let t = v.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t)) t = t.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += "Z"; // bez strefy = UTC
  return Date.parse(t);
}

/**
 * Odczyt rekordu z tabeli `live_snapshots(id, run_id, record_json, created_at, expires_at)` — tylko dla identyfikatorów
 * "live:…". Wiersze po `expires_at` są ignorowane. Gdy tabela nie istnieje (silnik jeszcze jej nie utworzył), JSON jest
 * uszkodzony albo nie przechodzi walidacji CorpusRecord — zwraca undefined. Rekord zawsze dostaje id wiersza i origin
 * "live_snapshot" (magazyn jest źródłem prawdy o pochodzeniu).
 */
function readLiveSnapshot(db: Db, recordId: string, nowMs: number): CorpusRecord | undefined {
  if (!recordId.startsWith(LIVE_ID_PREFIX)) return undefined;
  let row: LiveSnapshotRow | undefined;
  try {
    row = db.prepare("SELECT record_json, expires_at FROM live_snapshots WHERE id = ?").get(recordId) as LiveSnapshotRow | undefined;
  } catch {
    return undefined; // brak tabeli live_snapshots (lub inny błąd odczytu) — to nie jest błąd korpusu
  }
  if (!row) return undefined;
  const expiry = liveExpiryMs(row.expires_at);
  if (expiry !== null && !(expiry > nowMs)) return undefined; // wygasły albo nieczytelny termin
  try {
    const parsed = CorpusRecord.safeParse({ ...(JSON.parse(row.record_json) as Record<string, unknown>), id: recordId, origin: "live_snapshot" });
    if (!parsed.success) return undefined;
    const policy = activeCatalogs.get(db);
    if (!policy) return parsed.data;
    const source = sourceAtUrl(policy, parsed.data.url);
    if (source?.id !== parsed.data.sourceId || source.role !== parsed.data.role) return undefined;
    return { ...parsed.data, type: source.type, level: source.level, independenceGroup: source.independenceGroup, licence: source.licence };
  } catch {
    return undefined;
  }
}

export function createCorpusStore(db: Db, opts: { now?: () => Date } = {}): CorpusStore {
  const getStmt = db.prepare("SELECT * FROM records WHERE id = ?");
  const pageStmt = db.prepare("SELECT * FROM records WHERE url = ? AND origin IN ('corpus', 'organizer') ORDER BY id LIMIT 64");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM records");
  const snapStmt = db.prepare("SELECT value FROM corpus_meta WHERE key = 'snapshot_id'");
  const now = opts.now ?? (() => new Date());
  const lookup = (recordId: string): CorpusRecord | undefined => {
    const row = getStmt.get(recordId) as RecordRow | undefined;
    if (row) return rowToRecord(row);
    return readLiveSnapshot(db, recordId, now().getTime());
  };
  return {
    catalogPage(url) {
      return (pageStmt.all(url) as RecordRow[]).map(rowToRecord);
    },
    get(recordId: string): CorpusRecord | undefined {
      return lookup(recordId);
    },
    getMany(recordIds: string[]): CorpusRecord[] {
      const out: CorpusRecord[] = [];
      for (const id of recordIds) {
        const rec = lookup(id);
        if (rec) out.push(rec);
      }
      return out;
    },
    snapshotId(): string {
      return (snapStmt.get() as { value: string } | undefined)?.value ?? "";
    },
    count(): number {
      return (countStmt.get() as { n: number }).n;
    },
  };
}
