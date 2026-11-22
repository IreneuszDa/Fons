/**
 * Tabela `live_snapshots` — migawki stron pobranych przez wyszukiwanie na żywo (PLAN §3.4).
 * To NIE jest korpus: rekordy mają id `live:<sha>`, TTL 48 h i identyfikator przebiegu. CorpusStore
 * (src/corpus/store.ts) odczytuje je zapasowo dla id zaczynających się od "live:".
 *
 *   live_snapshots(id TEXT PRIMARY KEY, run_id TEXT, record_json TEXT, created_at TEXT, expires_at TEXT)
 */
import type { Database } from "better-sqlite3";
import { CorpusRecord } from "../../shared/contracts";
export { findLiveDocuments, getLiveDocument, invalidateLiveDocument, requiresFreshDocument, saveLiveDocument, type LiveDocument } from "./live-documents";

export const LIVE_TTL_MS = 48 * 3_600_000;
export const LIVE_ID_PREFIX = "live:";

/** A single UTC-day counter shared by workers and restarts. Failed requests keep their reservation. */
export function reserveLiveRequest(db: Database, now: Date, cap = 200): boolean {
  if (!Number.isSafeInteger(cap) || cap <= 0) return false;
  db.exec("CREATE TABLE IF NOT EXISTS web_search_quota (id INTEGER PRIMARY KEY CHECK(id = 1), day TEXT NOT NULL, requests INTEGER NOT NULL)");
  return db.prepare(`INSERT INTO web_search_quota (id, day, requests) VALUES (1, ?, 1)
    ON CONFLICT(id) DO UPDATE SET day = excluded.day,
      requests = CASE WHEN day < excluded.day THEN 1 ELSE requests + 1 END
    WHERE day < excluded.day OR (day = excluded.day AND requests < ?)`).run(now.toISOString().slice(0, 10), cap).changes === 1;
}

/** Tworzy tabelę idempotentnie. */
export function ensureLiveSnapshotsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_snapshots_expires ON live_snapshots(expires_at);
  `);
}

/** Usuwa wygasłe migawki; zwraca liczbę usuniętych wierszy. */
export function purgeExpiredLiveSnapshots(db: Database, now: Date): number {
  return db.prepare("DELETE FROM live_snapshots WHERE expires_at <= ?").run(now.toISOString()).changes;
}

/**
 * Zapisuje rekordy (walidowane schematem CorpusRecord, origin musi być "live_snapshot"). Ten sam id (ten sam adres
 * i ta sama treść) odświeża TTL i przebieg. Zwraca liczbę zapisanych rekordów.
 */
export function saveLiveSnapshots(
  db: Database,
  runId: string,
  records: CorpusRecord[],
  now: Date,
  ttlMs: number = LIVE_TTL_MS,
): number {
  ensureLiveSnapshotsTable(db);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const ins = db.prepare(
    `INSERT INTO live_snapshots (id, run_id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, record_json = excluded.record_json,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  );
  const tx = db.transaction(() => {
    purgeExpiredLiveSnapshots(db, now);
    let n = 0;
    for (const r of records) {
      const rec = CorpusRecord.parse(r);
      if (rec.origin !== "live_snapshot" || !rec.id.startsWith(LIVE_ID_PREFIX)) {
        throw new Error("live snapshot must have origin live_snapshot and an id starting with live:");
      }
      ins.run(rec.id, runId, JSON.stringify(rec), createdAt, expiresAt);
      n++;
    }
    return n;
  });
  return tx();
}

/** Odczyt jednej migawki (nie zwraca wygasłych ani uszkodzonych). */
export function getLiveSnapshot(db: Database, id: string, now: Date): CorpusRecord | undefined {
  if (!id.startsWith(LIVE_ID_PREFIX)) return undefined;
  let row: { record_json: string; expires_at: string } | undefined;
  try {
    row = db.prepare("SELECT record_json, expires_at FROM live_snapshots WHERE id = ?").get(id) as typeof row;
  } catch {
    return undefined; // tabela jeszcze nie istnieje
  }
  if (!row || row.expires_at <= now.toISOString()) return undefined;
  const parsed = CorpusRecord.safeParse(safeJson(row.record_json));
  return parsed.success ? parsed.data : undefined;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
