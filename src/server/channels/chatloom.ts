import type { Handler } from "hono";
import { z } from "zod";
import { reactionFor } from "../../shared/message-reaction";
import type { ServerContext } from "../context";
import { handleInbound } from "../conversation";
import { SESSION_RETENTION_DAYS } from "../db";
import { renderReplyText } from "./render";
import { verifyHmacSha256, withinWindow } from "./signature";

const eventId = z.string().startsWith("$").min(2).max(1024);
const matrixEvent = z.object({
  event_id: eventId,
  room_id: z.string().startsWith("!").min(2).max(1024),
  sender: z.string().startsWith("@").min(2).max(1024),
  origin_server_ts: z.number().int().nonnegative().max(8.64e15),
  type: z.string().min(1).max(255),
  content: z.record(z.string(), z.unknown()),
  redacts: eventId.optional(),
});
const relation = z.object({
  rel_type: z.literal("m.annotation"),
  event_id: eventId,
  key: z.string().min(1).max(128),
});
const messageRelation = z.object({
  rel_type: z.string().optional(),
  "m.in_reply_to": z.object({ event_id: eventId }).optional(),
});
type MatrixEvent = z.infer<typeof matrixEvent>;

interface Receipt {
  reply: string | null;
  emoji: string | null;
}

const LEASE_MS = 120_000;
const MAX_EVENT_AGE = SESSION_RETENTION_DAYS * 86_400_000;

function actions(receipt: Receipt, key: string, target: string) {
  if (!receipt.reply) return [];
  return [
    { txn_id: `fons-${key}-text`, type: "m.room.message", content: { msgtype: "m.text", body: receipt.reply } },
    { txn_id: `fons-${key}-reaction`, type: "m.reaction", content: {
      "m.relates_to": { rel_type: "m.annotation", event_id: target, key: receipt.emoji },
    } },
  ];
}

/** The signed private client owns Matrix delivery. Replays must return the original answer and transaction IDs. */
export function createChatLoomWebhook(ctx: ServerContext): Handler {
  const secret = ctx.cfg.chatloomWebhookSecret;
  if (!secret) return c => c.json({ error: "not_configured" }, 501);
  const { db, security } = ctx;
  const key = (...parts: string[]) => security.pseudonymize(JSON.stringify(["chatloom", ...parts]));
  const receiptFor = db.prepare("SELECT reply, emoji FROM chatloom_replies WHERE event_key = ?");
  const reserve = db.prepare(`INSERT INTO chatloom_replies (event_key, session_id, sender_id, lease_until, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_key) DO UPDATE SET lease_until = excluded.lease_until
    WHERE chatloom_replies.reply IS NULL AND chatloom_replies.lease_until <= ?`);
  const renew = db.prepare("UPDATE chatloom_replies SET lease_until = ? WHERE event_key = ? AND lease_until = ? AND reply IS NULL");

  return async c => {
    const raw = await c.req.text();
    const ts = c.req.header("x-chatloom-timestamp");
    const now = ctx.now();
    if (!ts || !/^\d{1,10}$/.test(ts) || !withinWindow(ts, now.getTime()) ||
        !verifyHmacSha256(secret, ts + "." + raw, c.req.header("x-chatloom-signature"))) {
      return c.json({ error: "forbidden" }, 403);
    }

    let event: MatrixEvent;
    try {
      event = matrixEvent.parse(JSON.parse(raw));
    } catch {
      return c.json({ error: "bad_event" }, 400);
    }
    const { type, content } = event;
    if (event.origin_server_ts < now.getTime() - MAX_EVENT_AGE) return c.json({ actions: [] });
    const sender = key("sender", event.sender);
    const session = key("session", event.room_id, event.sender);
    const eventKey = (id: string) => key("event", session, id);
    const delivery = eventKey(event.event_id);

    if (type === "m.reaction") {
      const rel = relation.safeParse(content["m.relates_to"]);
      if (!rel.success) return c.json({ error: "bad_reaction" }, 400);
      db.prepare(`INSERT OR IGNORE INTO chatloom_reactions
        (event_key, sender_id, session_id, target_key, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(delivery, sender, session, key("target", event.room_id, rel.data.event_id), rel.data.key, now.toISOString());
      return c.json({ actions: [] });
    }
    if (type === "m.room.redaction") {
      const target = eventId.safeParse(content.redacts ?? event.redacts);
      if (!target.success) return c.json({ error: "bad_redaction" }, 400);
      // A removal can be delivered before its annotation. Retain a scoped tombstone for retries.
      db.prepare(`INSERT INTO chatloom_reactions (event_key, sender_id, session_id, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET target_key = NULL, emoji = NULL`)
        .run(eventKey(target.data), sender, session, now.toISOString());
      return c.json({ actions: [] });
    }
    if (type !== "m.room.message" || content.msgtype !== "m.text") return c.json({ actions: [] });
    const rel = messageRelation.safeParse(content["m.relates_to"] ?? {});
    if (!rel.success) return c.json({ error: "bad_relation" }, 400);
    if (rel.data.rel_type === "m.replace") return c.json({ actions: [] });
    if (typeof content.body !== "string") return c.json({ error: "bad_message" }, 400);
    // A Matrix reply may include the quoted message as a plain-text fallback.
    const text = (rel.data["m.in_reply_to"] ? content.body.replace(/^(?:>[^\n]*\r?\n)+\r?\n/, "") : content.body).trim();
    if (!text) return c.json({ actions: [] });

    const busy = () => {
      c.header("Retry-After", "2");
      return c.json({ error: "processing" }, 503);
    };
    let lease = now.getTime() + LEASE_MS;
    if (!reserve.run(delivery, session, sender, lease, now.toISOString(), now.getTime()).changes) {
      const saved = receiptFor.get(delivery) as Receipt | undefined;
      return saved?.reply == null ? busy() : c.json({ actions: actions(saved, delivery, event.event_id) });
    }

    // Release a crashed worker's claim after expiry while allowing long verifications to finish.
    const heartbeat = setInterval(() => {
      const extended = ctx.now().getTime() + LEASE_MS;
      try {
        if (renew.run(extended, delivery, lease).changes) lease = extended;
      } catch {
        ctx.log.warn({ event: "chatloom_lease_renewal_failed" });
      }
    }, LEASE_MS / 4);
    heartbeat.unref();
    try {
      const reply = await handleInbound({
        channel: "chatloom", senderId: sender, sessionId: session, messageId: delivery,
        receivedAt: new Date(event.origin_server_ts).toISOString(), text, images: [],
      }, ctx);
      const rendered = renderReplyText(reply, { buttons: false });
      const emoji = reactionFor(reply).emoji;
      const saved = db.prepare(`UPDATE chatloom_replies SET reply = ?, emoji = ?, lease_until = 0
        WHERE event_key = ? AND lease_until = ? AND (reply IS NULL OR ? = 'deleted')`)
        .run(rendered, emoji, delivery, lease, reply.kind);
      if (saved.changes) return c.json({ actions: actions({ reply: rendered, emoji }, delivery, event.event_id) });
      const current = receiptFor.get(delivery) as Receipt | undefined;
      return current?.reply != null ? c.json({ actions: actions(current, delivery, event.event_id) }) : busy();
    } finally {
      clearInterval(heartbeat);
      renew.run(0, delivery, lease);
    }
  };
}
