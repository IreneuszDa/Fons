import type { Handler } from "hono";
import { z } from "zod";
import { AUDIO_MIMES, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_RECORDING_BYTES } from "../../shared/attachments";
import type { InboundMessage } from "../../shared/contracts";
import { reactionFor } from "../../shared/message-reaction";
import { budgetExceeded } from "../budget";
import type { ServerContext } from "../context";
import { detectIntent, handleInbound } from "../conversation";
import { BUDGET_TEXT, RATE_LIMITED_TEXT } from "../conversation/templates";
import { SESSION_RETENTION_DAYS } from "../db";
import { attachmentBase64Ok, imageMagicOk, transcribeAudio } from "../media";
import { findSession } from "../sessions";
import { chatLoomPhotos } from "./chatloom-photos";
import { renderReplyText } from "./render";
import { verifyHmacSha256, withinWindow } from "./signature";

export const CHATLOOM_WEBHOOK_PATH = "/api/channels/chatloom/webhook";

const eventId = z.string().startsWith("$").min(2).max(1024);
const matrixEvent = z.object({
  event_id: eventId,
  room_id: z.string().startsWith("!").min(2).max(1024),
  sender: z.string().startsWith("@").min(2).max(1024),
  origin_server_ts: z.number().int().nonnegative().max(8.64e15),
  type: z.string().min(1).max(255),
  content: z.record(z.string(), z.unknown()),
  redacts: eventId.optional(),
  media_context: z.boolean().optional(),
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
const mediaPayload = z.object({
  mime: z.string().max(128).transform(mime => mime.split(";")[0]!.trim().toLowerCase())
    .transform(mime => mime === "application/ogg" || mime === "audio/opus" ? "audio/ogg" : mime),
  base64: z.string().max(Math.ceil(MAX_RECORDING_BYTES / 3) * 4),
});
type MatrixEvent = z.infer<typeof matrixEvent>;

interface Receipt {
  reply: string | null;
  emoji: string | null;
}

const LEASE_MS = 120_000;
const MAX_EVENT_AGE = SESSION_RETENTION_DAYS * 86_400_000;
const PHOTO_ERROR = "Nie udało się odebrać zdjęcia. Wyślij je ponownie w formacie JPG, PNG lub WebP do 5 MB.";
const VOICE_ERROR = "Nie udało się odczytać głosówki. Nagraj ją ponownie lub wpisz pytanie.";

function actions(receipt: Receipt, key: string, target: string) {
  if (!receipt.reply) return [];
  return [
    { txn_id: `fons-${key}-text`, type: "m.room.message", content: { msgtype: "m.text", body: receipt.reply } },
    ...(receipt.emoji ? [{ txn_id: `fons-${key}-reaction`, type: "m.reaction", content: {
      "m.relates_to": { rel_type: "m.annotation", event_id: target, key: receipt.emoji },
    } }] : []),
  ];
}

/** The signed private client owns Matrix delivery. Replays must return the original answer and transaction IDs. */
export function createChatLoomWebhook(ctx: ServerContext): Handler {
  const secret = ctx.cfg.chatloomWebhookSecret;
  if (!secret) return c => c.json({ error: "not_configured" }, 501);
  const { db, security } = ctx;
  const photos = chatLoomPhotos(() => ctx.now().getTime());
  let activeVoiceNotes = 0;
  const key = (...parts: string[]) => security.pseudonymize(JSON.stringify(["chatloom", ...parts]));
  const receiptFor = db.prepare("SELECT reply, emoji FROM chatloom_replies WHERE event_key = ?");
  const reserve = db.prepare(`INSERT INTO chatloom_replies (event_key, session_id, sender_id, lease_until, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_key) DO UPDATE SET lease_until = excluded.lease_until
    WHERE chatloom_replies.reply IS NULL AND chatloom_replies.lease_until <= ?`);
  const renew = db.prepare("UPDATE chatloom_replies SET lease_until = ? WHERE event_key = ? AND lease_until = ? AND reply IS NULL");
  const finish = db.prepare(`UPDATE chatloom_replies SET reply = ?, emoji = ?, lease_until = 0
    WHERE event_key = ? AND lease_until = ? AND (reply IS NULL OR ?)`);
  const redacted = db.prepare("SELECT 1 FROM chatloom_reactions WHERE event_key = ? AND target_key IS NULL");

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
      const targetKey = eventKey(target.data);
      db.prepare(`INSERT INTO chatloom_reactions (event_key, sender_id, session_id, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET target_key = NULL, emoji = NULL`)
        .run(targetKey, sender, session, now.toISOString());
      photos.remove(targetKey);
      return c.json({ actions: [] });
    }
    const isImage = content.msgtype === "m.image";
    const isVoice = content.msgtype === "m.audio" || content.msgtype === "m.voice";
    if (type !== "m.room.message" || (content.msgtype !== "m.text" && !isImage && !isVoice)) return c.json({ actions: [] });
    const rel = messageRelation.safeParse(content["m.relates_to"] ?? {});
    if (!rel.success) return c.json({ error: "bad_relation" }, 400);
    if (rel.data.rel_type === "m.replace") return c.json({ actions: [] });
    if (!isImage && !isVoice && typeof content.body !== "string") return c.json({ error: "bad_message" }, 400);
    const replyTo = rel.data["m.in_reply_to"]?.event_id;
    const body = isImage ? content.caption : isVoice ? undefined : content.body;
    // A Matrix reply may include the quoted message as a plain-text fallback.
    let text = typeof body === "string" ? (replyTo ? body.replace(/^(?:>[^\n]*\r?\n)+\r?\n/, "") : body).trim() : "";
    if (!text && !isImage && !isVoice) return c.json({ actions: [] });

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
      const complete = (reply: string, emoji: string | null = null, deleted = false) => {
        const saved = finish.run(reply, emoji, delivery, lease, Number(deleted));
        if (saved.changes) return c.json({ actions: actions({ reply, emoji }, delivery, event.event_id) });
        const current = receiptFor.get(delivery) as Receipt | undefined;
        return current?.reply != null ? c.json({ actions: actions(current, delivery, event.event_id) }) : busy();
      };

      let image;
      if (isImage || isVoice) {
        if (redacted.get(delivery)) return complete("");
        if (!ctx.limiters.sender.check(`chatloom-media:${sender}`)) return complete(RATE_LIMITED_TEXT);
        const parsed = mediaPayload.safeParse(content.attachment);
        const media = parsed.data;
        if (!media || !attachmentBase64Ok(media.base64, isImage ? MAX_ATTACHMENT_BYTES : MAX_RECORDING_BYTES)) {
          return complete(isImage ? PHOTO_ERROR : VOICE_ERROR);
        }
        if (isImage) {
          if (!IMAGE_MIMES.some(mime => mime === media.mime) || !imageMagicOk(media.mime, media.base64)) return complete(PHOTO_ERROR);
          image = media;
          const paired = photos.add(delivery, { session, sender, sentAt: event.origin_server_ts, image });
          if (paired) return complete("");
          if (!text) return complete("Mam zdjęcie. Co mam na nim sprawdzić?");
        } else {
          if (!AUDIO_MIMES.some(mime => mime === media.mime)) return complete(VOICE_ERROR);
          if (!ctx.cfg.openaiApiKey) return complete("Transkrypcja głosówek jest chwilowo niedostępna. Wpisz pytanie.");
          if (budgetExceeded(ctx.db, ctx.cfg, now)) return complete(BUDGET_TEXT);
          if (activeVoiceNotes >= 3) return busy();
          activeVoiceNotes++;
          try {
            text = (await transcribeAudio(ctx, media, c.req.raw.signal)).trim();
            if (!text) return complete(VOICE_ERROR);
          } catch {
            return complete(VOICE_ERROR);
          } finally {
            activeVoiceNotes--;
          }
          if (redacted.get(delivery) || (receiptFor.get(delivery) as Receipt | undefined)?.reply != null) return complete("");
        }
      }

      if (!image && text.length <= ctx.options.maxInputChars) {
        const pending = findSession(db, session)?.state.pending;
        const intent = detectIntent({ text, images: [] }, pending && pending.expiresAt > ctx.now().getTime() ? pending.type : undefined);
        if (intent.type === "verify") {
          image = await photos.forQuestion({
            session, sender, text, sentAt: event.origin_server_ts, replyTo: replyTo && eventKey(replyTo),
          }, event.media_context === true);
          if ((receiptFor.get(delivery) as Receipt | undefined)?.reply != null) return complete("");
        }
      }

      const images: InboundMessage["images"] = [];
      if (image) {
        const dataRef = `chatloom_${delivery}_${lease}`;
        ctx.media.set(dataRef, image);
        images.push({ mime: image.mime, dataRef });
      }
      const reply = await handleInbound({
        channel: "chatloom", senderId: sender, sessionId: session, messageId: delivery,
        receivedAt: new Date(event.origin_server_ts).toISOString(), text, images,
      }, ctx);
      if (reply.kind === "deleted") photos.forget(sender);
      return complete(renderReplyText(reply, { buttons: false }), reactionFor(reply).emoji, reply.kind === "deleted");
    } finally {
      clearInterval(heartbeat);
      renew.run(0, delivery, lease);
    }
  };
}
