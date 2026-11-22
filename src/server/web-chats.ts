import { timingSafeEqual } from "node:crypto";
import type { ChatDetail, ChatSummary, StoredChatEntry } from "../shared/chat";
import type { ConversationReply, InboundMessage } from "../shared/contracts";
import type { ServerContext } from "./context";
import { linksIn, maskedConversationText, visibleLink } from "./conversation/history";
import { QR } from "./conversation/templates";
import { SESSION_RETENTION_DAYS } from "./db";
import { getReportForSender } from "./reports";
import { createSession, findSession, newSessionId, type SessionRow } from "./sessions";
import { truncate } from "./util";

const UNTITLED = "Nowy czat";
const cutoff = (ctx: ServerContext) => new Date(ctx.now().getTime() - SESSION_RETENTION_DAYS * 86_400_000).toISOString();

interface ChatOwner {
  senderId: string;
  cookie: string;
}

function signedOwner(ctx: ServerContext, nonce: string): ChatOwner {
  const signature = ctx.security.pseudonymize(`web-history-cookie:${nonce}`);
  return { senderId: ctx.security.pseudonymize(`web:${nonce}`), cookie: `${nonce}.${signature}` };
}

export function newChatOwner(ctx: ServerContext): ChatOwner {
  return signedOwner(ctx, newSessionId());
}

/** Thread IDs are public selectors. Only an HttpOnly cookie authenticates their owner. */
export function readChatOwner(ctx: ServerContext, cookie?: string): ChatOwner | undefined {
  if (!cookie) return;
  const signed = /^([a-f0-9]{32})\.[a-f0-9]{32}$/.exec(cookie);
  if (signed) {
    const owner = signedOwner(ctx, signed[1]!);
    return timingSafeEqual(Buffer.from(cookie), Buffer.from(owner.cookie)) ? owner : undefined;
  }
  if (!/^[a-f0-9]{32}$/.test(cookie)) return;
  const legacy = findSession(ctx.db, cookie);
  const owner = signedOwner(ctx, cookie);
  // Before history existed pw_sid was the session credential. Accept it once, only
  // for an original web session, then issue a signed cookie independent of thread IDs.
  if (!legacy || legacy.channel !== "web" || legacy.lastSeen < cutoff(ctx) || legacy.senderId !== owner.senderId) return;
  if (ctx.db.prepare("SELECT 1 FROM web_chats WHERE session_id = ?").get(legacy.id)) return;
  importLegacyChat(ctx, legacy);
  return owner;
}

function importLegacyChat(ctx: ServerContext, session: SessionRow): void {
  const history = session.state.history ?? [];
  ctx.db.transaction(() => {
    ctx.db.prepare("INSERT INTO web_chats (session_id) VALUES (?)").run(session.id);
    // Older sessions retained only a bounded transcript. Restore only turns that exist.
    for (let i = 0; i + 1 < history.length; i++) {
      const user = history[i]!;
      const assistant = history[i + 1]!;
      if (user.role !== "user" || assistant.role !== "assistant") continue;
      const reply: ConversationReply = { kind: "help", textPl: assistant.text, quickReplies: [] };
      writeTurn(ctx, session.id, maskedConversationText(ctx, user.text), null, reply);
    }
  })();
}

export function createWebChat(ctx: ServerContext, senderId: string): SessionRow {
  return ctx.db.transaction(() => {
    const session = createSession(ctx, { senderId, channel: "web" });
    ctx.db.prepare("INSERT INTO web_chats (session_id) VALUES (?)").run(session.id);
    return session;
  })();
}

const SELECT_SUMMARY = `SELECT s.id, COALESCE(NULLIF(c.title, ''), ?) AS title, s.last_seen AS updatedAt
  FROM web_chats c JOIN sessions s ON s.id = c.session_id
  WHERE s.channel = 'web' AND s.sender_id = ? AND s.last_seen >= ?`;
const NEWEST_FIRST = " ORDER BY s.last_seen DESC, s.rowid DESC";

export function listWebChats(ctx: ServerContext, senderId: string): ChatSummary[] {
  return ctx.db.prepare(SELECT_SUMMARY + NEWEST_FIRST).all(UNTITLED, senderId, cutoff(ctx)) as ChatSummary[];
}

export function chatSummary(ctx: ServerContext, senderId: string, id?: string): ChatSummary | undefined {
  return ctx.db.prepare(SELECT_SUMMARY + (id === undefined ? NEWEST_FIRST + " LIMIT 1" : " AND s.id = ?"))
    .get(UNTITLED, senderId, cutoff(ctx), ...(id === undefined ? [] : [id])) as ChatSummary | undefined;
}

const actionLabels: Record<string, string> = {
  ...Object.fromEntries(Object.values(QR).map(item => [item.id, item.labelPl])),
  delete: "Usuń moje dane", delete_confirm: "Tak, usuń", delete_cancel: "Nie, zostaw",
  report_confirm: "Tak, zgłoś", report_cancel: "Nie",
};

function writeTurn(ctx: ServerContext, id: string, text: string, fileName: string | null, reply: ConversationReply): void {
  const { report, ...message } = reply;
  ctx.db.prepare(`INSERT INTO web_chat_turns (session_id, user_text, file_name, reply_json, report_token)
    VALUES (?, ?, ?, ?, ?)`).run(id, text, fileName, JSON.stringify(message), report?.token ?? null);
  const title = truncate((text || fileName || "").replace(/\s+/gu, " ").trim(), 80);
  if (title) ctx.db.prepare("UPDATE web_chats SET title = ? WHERE session_id = ? AND title = ''").run(title, id);
}

// An existing report can repeat a submitted private URL in its input echo, claims,
// or findings. Redact those same URLs wherever they appear in the history copy.
function maskSubmittedLinks<T>(value: T, input: string): T {
  const replacements = [...new Set(linksIn(input))]
    .map(raw => [raw, visibleLink(raw)] as const)
    .filter(([raw, visible]) => raw !== visible && (/[?#]/u.test(raw) || visible.endsWith("?…") || visible.startsWith("[")))
    .sort(([a], [b]) => b.length - a.length);
  if (!replacements.length) return value;
  return JSON.parse(JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part !== "string") return part;
    return replacements.reduce((text, [raw, visible]) => text.replaceAll(raw, visible), part);
  })) as T;
}

export function recordWebTurn(ctx: ServerContext, msg: InboundMessage, reply: ConversationReply, attachmentName?: string): void {
  const hasFile = msg.images.length > 0 || !!msg.document || !!msg.recording;
  const label = attachmentName?.split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const fileName = hasFile ? (label ? maskedConversationText(ctx, label) : msg.document ? "Dokument" : msg.recording ? "Nagranie" : "Obraz") : null;
  const text = maskedConversationText(ctx, msg.text.trim() || (msg.action ? actionLabels[msg.action] ?? msg.action : ""));
  // File bytes and unredacted user text never enter the transcript. Report content
  // stays in its existing private row and is rehydrated for this owner on open.
  const { report, ...message } = reply;
  const storedReply = { ...message, textPl: maskedConversationText(ctx, reply.textPl) };
  if (reply.shortAnswer) storedReply.shortAnswer = { ...reply.shortAnswer, bodyPl: maskedConversationText(ctx, reply.shortAnswer.bodyPl) };
  ctx.db.transaction(() => {
    writeTurn(ctx, msg.sessionId, text, fileName, { ...maskSubmittedLinks(storedReply, msg.text), report });
    ctx.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(ctx.now().toISOString(), msg.sessionId);
  })();
}

export function readWebChat(ctx: ServerContext, senderId: string, id: string): ChatDetail | undefined {
  const chat = chatSummary(ctx, senderId, id);
  if (!chat) return;
  const rows = ctx.db.prepare("SELECT * FROM web_chat_turns WHERE session_id = ? ORDER BY seq").all(id) as {
    seq: number; user_text: string; file_name: string | null; reply_json: string; report_token: string | null;
  }[];
  const entries: StoredChatEntry[] = [];
  for (const row of rows) {
    const reply = JSON.parse(row.reply_json) as ConversationReply;
    if (row.report_token) {
      const report = getReportForSender(ctx.db, row.report_token, senderId, ctx.now());
      if (report) reply.report = maskSubmittedLinks(report, report.inputEchoMasked);
    }
    entries.push({ id: `turn-${row.seq}-user`, role: "user", text: row.user_text, ...(row.file_name && { fileName: row.file_name }) },
      { id: `turn-${row.seq}-assistant`, role: "assistant", reply });
  }
  return { chat, entries };
}
