import { randomBytes } from "node:crypto";
import type { ConversationTurn } from "../engine/llm/conversation";
import type { ChannelId } from "../shared/contracts";
import { eraseRunsForSender } from "./audit";
import type { Db, ServerContext } from "./context";

export interface SessionState {
  /** Oczekujące potwierdzenie „usuń”/„zgłoś” — powstaje tylko po jawnej prośbie. */
  pending?: { type: "delete" | "report"; expiresAt: number };
  lastReportToken?: string;
  history?: ConversationTurn[];
}

export interface SessionRow {
  id: string;
  senderId: string;
  channel: string;
  createdAt: string;
  lastSeen: string;
  state: SessionState;
}

function parseState(json: string): SessionState {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as SessionState) : {};
  } catch {
    return {};
  }
}

export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

export function findSession(db: Db, id: string): SessionRow | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | { id: string; sender_id: string; channel: string; created_at: string; last_seen: string; state_json: string }
    | undefined;
  if (!r) return undefined;
  return { id: r.id, senderId: r.sender_id, channel: r.channel, createdAt: r.created_at, lastSeen: r.last_seen, state: parseState(r.state_json) };
}

export function createSession(ctx: ServerContext, p: { id?: string; senderId: string; channel: ChannelId }): SessionRow {
  const id = p.id ?? newSessionId();
  const now = ctx.now().toISOString();
  ctx.db
    .prepare("INSERT OR IGNORE INTO sessions (id, sender_id, channel, created_at, last_seen, state_json) VALUES (?, ?, ?, ?, ?, '{}')")
    .run(id, p.senderId, p.channel, now, now);
  return findSession(ctx.db, id)!;
}

export function saveSessionState(ctx: ServerContext, id: string, state: SessionState): void {
  ctx.db
    .prepare("UPDATE sessions SET state_json = ?, last_seen = ? WHERE id = ?")
    .run(JSON.stringify(state), ctx.now().toISOString(), id);
}

/** Deletion covers every session of a sender, so it shares the same queue as incoming turns. */
export async function inTurnOrder<T>(ctx: ServerContext, senderId: string, run: () => T | Promise<T>): Promise<T> {
  const previous = ctx.activeTurns.get(senderId) ?? Promise.resolve();
  const turn = previous.then(run);
  const done = turn.then(() => {}, () => {});
  ctx.activeTurns.set(senderId, done);
  try {
    return await turn;
  } finally {
    if (ctx.activeTurns.get(senderId) === done) ctx.activeTurns.delete(senderId);
  }
}

export interface EraseResult {
  reports: number;
  runs: number;
  cache: number;
  caseSenders: number;
  sessions: number;
}

/**
 * „Usuń moje dane”: raporty, przebiegi (czyszczenie pól osobowych w dzienniku audytu), wpisy cache
 * utworzone przez nadawcę, jego wiersze w sprawach (sprawa bez nadawców znika) i sesje.
 * Zdarzenia bezpieczeństwa zostają jako zanonimizowane liczniki (bez fragmentu i powiązania).
 */
export function eraseSender(ctx: ServerContext, senderId: string): EraseResult {
  const db = ctx.db;
  const sessionIds = db.prepare("SELECT id FROM sessions WHERE sender_id = ?").all(senderId) as { id: string }[];
  const tx = db.transaction((): EraseResult => {
    const reports = db.prepare("DELETE FROM reports WHERE sender_id = ?").run(senderId).changes;
    const runs = eraseRunsForSender(db, senderId);
    db.prepare("UPDATE security_events SET excerpt = '', sender_id = NULL, session_id = NULL WHERE sender_id = ?").run(senderId);
    // Wpis cache jest współdzielony (klucz nie zależy od nadawcy): po usunięciu zostaje „nagrobek” do końca TTL,
    // żeby skasowanie danych i ponowne wysłanie nie otwierało klucza na nowy, być może inny wynik dla wszystkich.
    db.prepare(
      `INSERT OR REPLACE INTO cache_tombstones (cache_key, until)
       SELECT cache_key, expires_at FROM computation_cache WHERE sender_id = ?`,
    ).run(senderId);
    const cache = db.prepare("DELETE FROM computation_cache WHERE sender_id = ?").run(senderId).changes;

    const caseIds = (db.prepare("SELECT DISTINCT case_id FROM case_senders WHERE sender_id = ?").all(senderId) as { case_id: number }[]).map((r) => r.case_id);
    const caseSenders = db.prepare("DELETE FROM case_senders WHERE sender_id = ?").run(senderId).changes;
    for (const id of caseIds) {
      const left = (db.prepare("SELECT COUNT(*) AS n FROM case_senders WHERE case_id = ?").get(id) as { n: number }).n;
      if (left === 0) db.prepare("DELETE FROM moderator_cases WHERE id = ?").run(id);
      else db.prepare("UPDATE moderator_cases SET sender_count = ? WHERE id = ?").run(left, id);
    }
    const sessions = db.prepare("DELETE FROM sessions WHERE sender_id = ?").run(senderId).changes;
    return { reports, runs, cache, caseSenders, sessions };
  });
  const result = tx();
  for (const { id } of sessionIds) ctx.conversationLinks.forget(id);
  return result;
}
