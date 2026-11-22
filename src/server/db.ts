/**
 * Tabele należące do serwera (tworzone idempotentnie na wspólnej bazie z korpusem).
 */
import type { Db } from "./context";
import { dayKey } from "./util";

export const RUN_RETENTION_DAYS = 30;
export const SESSION_RETENTION_DAYS = 7;
/** WhatsApp signup rows live this long after their last change (this also blocks a repeated welcome to the same number). */
export const WHATSAPP_SIGNUP_RETENTION_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_sender ON sessions(sender_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);

CREATE TABLE IF NOT EXISTS chatloom_replies (
  event_key TEXT PRIMARY KEY,
  sender_id TEXT,
  session_id TEXT,
  reply TEXT,
  emoji TEXT,
  lease_until INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chatloom_replies_sender ON chatloom_replies(sender_id);

CREATE TABLE IF NOT EXISTS chatloom_reactions (
  event_key TEXT PRIMARY KEY,
  sender_id TEXT,
  session_id TEXT,
  target_key TEXT,
  emoji TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chatloom_reactions_sender ON chatloom_reactions(sender_id);

CREATE TABLE IF NOT EXISTS web_chats (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS web_chat_turns (
  seq INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES web_chats(session_id) ON DELETE CASCADE,
  user_text TEXT NOT NULL,
  file_name TEXT,
  reply_json TEXT NOT NULL,
  report_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_web_chat_turns_session ON web_chat_turns(session_id, seq);

CREATE TABLE IF NOT EXISTS reports (
  token TEXT NOT NULL UNIQUE,
  report_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  session_id TEXT,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_sender ON reports(sender_id);
CREATE INDEX IF NOT EXISTS idx_reports_expires ON reports(expires_at);

-- Dziennik audytu (append-only, łańcuch SHA-256). Usunięcie danych użytkownika czyści pola osobowe
-- (erased=1), ale zostawia wiersz i skrót, więc łańcuch nadal się weryfikuje.
CREATE TABLE IF NOT EXISTS runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  models_json TEXT NOT NULL,
  timings_json TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  cache_hit INTEGER NOT NULL,
  security_event_count INTEGER NOT NULL,
  unavailable_json TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  -- pola osobowe (czyszczone przy "usuń moje dane")
  input_masked TEXT NOT NULL,
  sender_id TEXT,
  session_id TEXT,
  record_ids_json TEXT NOT NULL,
  salt TEXT NOT NULL,
  erased INTEGER NOT NULL DEFAULT 0,
  personal_digest TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_sender ON runs(sender_id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  sender_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  location TEXT NOT NULL,
  record_id TEXT,
  pattern TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  severity TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secev_request ON security_events(request_id);
CREATE INDEX IF NOT EXISTS idx_secev_sender ON security_events(sender_id);

CREATE TABLE IF NOT EXISTS computation_cache (
  cache_key TEXT PRIMARY KEY,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sender_id TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_cache_sender ON computation_cache(sender_id);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON computation_cache(expires_at);

-- Klucze cache usunięte przez „usuń moje dane”: do końca pierwotnego TTL wynik dla tego klucza nie jest
-- ponownie zapisywany, więc kasowanie i ponowne wysłanie nie pozwala „wylosować” werdyktu dla innych (SEC-02).
CREATE TABLE IF NOT EXISTS cache_tombstones (
  cache_key TEXT PRIMARY KEY,
  until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderator_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  representative_text TEXT NOT NULL,
  claim_norm TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  sender_count INTEGER NOT NULL DEFAULT 0,
  channels_json TEXT NOT NULL DEFAULT '[]',
  alert_state TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON moderator_cases(status, updated_at);

CREATE TABLE IF NOT EXISTS case_senders (
  case_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  PRIMARY KEY (case_id, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_case_senders_sender ON case_senders(sender_id);

CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_day ON alerts_log(day, outcome);

CREATE TABLE IF NOT EXISTS image_search_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
  day TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0
);

-- Tokeny API integracji (MCP, HTTP). Przechowujemy wyłącznie SHA-256 tokenu; sam token widać raz, przy tworzeniu.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- WhatsApp signups from the landing page. The number is personal data used only to send the operator's welcome
-- message; the row is removed after WHATSAPP_SIGNUP_RETENTION_DAYS or on "usuń moje dane".
-- lease_until (ms) hides a row handed to the operator relay so concurrent polls do not send it twice.
CREATE TABLE IF NOT EXISTS whatsapp_signups (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  error TEXT,
  ip_hash TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_signups_outbox ON whatsapp_signups(status, created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_signups_updated ON whatsapp_signups(updated_at);

-- Dziennik działań administratorów (append-only, łańcuch SHA-256 jak w runs). Bez treści wiadomości i danych osobowych.
CREATE TABLE IF NOT EXISTS admin_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

export function migrate(db: Db): void {
  db.exec(SCHEMA);
  // Starsze bazy: kolumna notatki moderatora.
  const cols = db.prepare("PRAGMA table_info(moderator_cases)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "note")) {
    db.exec("ALTER TABLE moderator_cases ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }
  // Wektor twierdzenia (lokalny e5) do deduplikacji parafraz.
  if (!cols.some((c) => c.name === "vec")) {
    db.exec("ALTER TABLE moderator_cases ADD COLUMN vec BLOB");
  }
}

export interface PurgeResult {
  runs: number;
  sessions: number;
  reports: number;
  cache: number;
  securityEvents: number;
  /** Wygasłe migawki wyszukiwania na żywo (tabela live_snapshots, jeśli istnieje). */
  liveSnapshots: number;
}

/** Usuwa wygasłe wiersze live_snapshots. Tabela należy do modułu wyszukiwania i może nie istnieć. */
function purgeLiveSnapshots(db: Db, now: Date): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_snapshots'").get();
  if (!exists) return 0;
  const col = (db.prepare("PRAGMA table_info(live_snapshots)").all() as { name: string; type: string }[]).find((c) => c.name === "expires_at");
  if (!col) return 0;
  // Znacznik czasu może być tekstem ISO albo liczbą (sekundy/milisekundy): porównujemy zgodnie z typem kolumny,
  // żeby porównanie liczby z tekstem nie usunęło wszystkiego.
  if (/INT|REAL|NUM|FLOA|DOUB/i.test(col.type)) {
    return db
      .prepare("DELETE FROM live_snapshots WHERE (CASE WHEN expires_at < 100000000000 THEN expires_at * 1000 ELSE expires_at END) < ?")
      .run(now.getTime()).changes;
  }
  return db.prepare("DELETE FROM live_snapshots WHERE expires_at < ?").run(now.toISOString()).changes;
}

/** Retencja: przebiegi 30 dni, sesje 7 dni (PLAN §6); wygasłe raporty i wpisy cache. */
export function purgeRetention(db: Db, now: Date): PurgeResult {
  const iso = now.toISOString();
  const runsCut = new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString();
  const sessCut = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();
  const tokensCut = dayKey(new Date(now.getTime() - 90 * 86_400_000));
  const tx = db.transaction(() => {
    const runs = db.prepare("DELETE FROM runs WHERE created_at < ?").run(runsCut).changes;
    const sessions = db.prepare("DELETE FROM sessions WHERE last_seen < ?").run(sessCut).changes;
    db.prepare("DELETE FROM chatloom_replies WHERE created_at < ?").run(sessCut);
    db.prepare("DELETE FROM chatloom_reactions WHERE created_at < ?").run(sessCut);
    const signupCut = new Date(now.getTime() - WHATSAPP_SIGNUP_RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare("DELETE FROM whatsapp_signups WHERE updated_at < ?").run(signupCut);
    const reports = db.prepare("DELETE FROM reports WHERE expires_at < ?").run(iso).changes;
    const cache = db.prepare("DELETE FROM computation_cache WHERE expires_at < ?").run(iso).changes;
    db.prepare("DELETE FROM cache_tombstones WHERE until < ?").run(iso);
    const securityEvents = db.prepare("DELETE FROM security_events WHERE created_at < ?").run(runsCut).changes;
    db.prepare("DELETE FROM token_usage WHERE day < ?").run(tokensCut);
    db.prepare("DELETE FROM image_search_usage WHERE day < ?").run(tokensCut);
    const liveSnapshots = purgeLiveSnapshots(db, now);
    return { runs, sessions, reports, cache, securityEvents, liveSnapshots };
  });
  return tx();
}
