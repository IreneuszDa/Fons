/**
 * WhatsApp signup from the landing page and the signed outbox polled by the operator relay.
 *
 * Flow: a citizen submits a number (POST /api/signup/whatsapp) → a `pending` row in whatsapp_signups →
 * the relay polls GET /api/channels/chatloom/outbox (signed like the ChatLoom webhook), sends the welcome message
 * from the operator's WhatsApp account and acknowledges with POST /api/channels/chatloom/outbox/:id.
 * Replies from that number reach the existing ChatLoom webhook.
 *
 * Phone numbers are personal data: they are never logged in full (maskPhone) and never leave the server
 * except in the signed outbox response.
 */
import type { Context, Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { maskPhone, normalizePhone } from "../shared/phone";
import { crossSiteRejection } from "./app";
import { verifyChatLoomRequest } from "./channels/signature";
import type { ServerContext } from "./context";
import { RATE_LIMITED_TEXT } from "./conversation/templates";
import { clientIp, clientKey } from "./http";

export type SignupStatus = "pending" | "sent" | "failed";

export const OUTBOX_LEASE_MS = 5 * 60_000;
export const OUTBOX_BATCH = 20;
/** Signup attempts per client IP (IPv6: /64) per minute. Stricter than chat: each one triggers a message. */
export const SIGNUP_PER_MINUTE = 5;
/** Minimum gap between welcomes to the same number when it is saved again (guards double submits). */
export const RESEND_COOLDOWN_MS = 60_000;
const MAX_ERROR_CHARS = 300;

const SignupBody = z.object({ phone: z.string().max(40), consent: z.literal(true) });
const AckBody = z.object({ status: z.enum(["sent", "failed"]), error: z.string().max(2000).optional() });

/** Plain-text welcome sent from the operator's account (no markdown: WhatsApp would show it literally). */
export function welcomeText(publicBaseUrl: string): string {
  const url = publicBaseUrl.replace(/\/+$/, "");
  return [
    "Cześć! Tu Fons, obywatelskie narzędzie do sprawdzania informacji u źródła.",
    "Wyślij mi twierdzenie, link albo pytanie, a sprawdzę je w oficjalnych źródłach.",
    "Odpowiedz „usuń moje dane”, a usunę Twoje dane.",
    `Więcej: ${url}`,
  ].join("\n\n");
}

/** Removes digit runs that look like phone numbers from relay error text before it is stored. */
function scrubError(error: string | undefined): string | null {
  if (!error) return null;
  return error.replace(/\+?\d[\d\s().-]{5,}\d/g, "[numer]").slice(0, MAX_ERROR_CHARS);
}

/**
 * "usuń moje dane" over ChatLoom: delete the signup whose number appears in the Matrix sender's localpart
 * (e.g. `@whatsapp_48500000000:relay` or `@+48500000000:relay`). Exact E.164 match only.
 */
export function eraseSignupForSender(ctx: ServerContext, sender: string): number {
  const local = sender.replace(/^@/, "").split(":")[0] ?? "";
  const candidates = [...new Set(local.match(/\d{7,15}/g) ?? [])].map(digits => `+${digits}`);
  if (!candidates.length) return 0;
  const removed = ctx.db.prepare(`DELETE FROM whatsapp_signups WHERE phone IN (${candidates.map(() => "?").join(", ")})`)
    .run(...candidates).changes;
  if (removed) ctx.log.info({ event: "whatsapp_signup_erased", count: removed });
  return removed;
}

export function registerWhatsAppSignup(app: Hono, ctx: ServerContext): void {
  const { db } = ctx;
  const limiter = ctx.security.createRateLimiter({ perMinute: SIGNUP_PER_MINUTE });
  const byPhone = db.prepare("SELECT id, status, updated_at FROM whatsapp_signups WHERE phone = ?");
  const insert = db.prepare(`INSERT INTO whatsapp_signups (id, phone, status, created_at, updated_at, ip_hash, lease_until)
    VALUES (?, ?, 'pending', ?, ?, ?, 0)`);
  // A repeat submission queues a fresh welcome under a new id (the relay de-duplicates greetings by item id).
  const requeue = db.prepare(`UPDATE whatsapp_signups SET id = ?, status = 'pending', error = NULL, updated_at = ?, ip_hash = ?,
    lease_until = 0, created_at = ? WHERE id = ? AND status IN ('sent', 'failed')`);

  app.post("/api/signup/whatsapp", async (c) => {
    const rejected = crossSiteRejection(c, ctx, { requireJson: true });
    if (rejected) return rejected;
    const ip = clientKey(clientIp(c, ctx));
    if (!limiter.check(`whatsapp-signup:${ip}`)) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited", messagePl: RATE_LIMITED_TEXT }, 429);
    }
    const body = SignupBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const consentMissing = body.error.issues.some(issue => issue.path[0] === "consent");
      return c.json(consentMissing
        ? { error: "consent_required", messagePl: "Zaznacz zgodę na wysyłanie wiadomości przez WhatsApp." }
        : { error: "bad_request", messagePl: "Nieprawidłowe żądanie." }, 400);
    }
    const phone = normalizePhone(body.data.phone);
    if (!phone) {
      return c.json({ error: "invalid_phone", messagePl: "Wpisz 9 cyfr polskiego numeru albo pełny numer z kodem kraju, np. +44…" }, 400);
    }

    const now = ctx.now().toISOString();
    const ipHash = ctx.security.pseudonymize(JSON.stringify(["whatsapp-signup-ip", ip]));
    const status = db.transaction((): SignupStatus => {
      const existing = byPhone.get(phone) as { id: string; status: SignupStatus; updated_at: string } | undefined;
      if (!existing) {
        insert.run(nanoid(), phone, now, now, ipHash);
        return "pending";
      }
      if (existing.status === "pending") return "pending";
      // Saving the number again asks Fons to write again, but not more often than the cooldown allows.
      const sinceLast = ctx.now().getTime() - Date.parse(existing.updated_at);
      if (existing.status === "sent" && sinceLast < RESEND_COOLDOWN_MS) return "sent";
      return requeue.run(nanoid(), now, ipHash, now, existing.id).changes ? "pending" : existing.status;
    })();
    ctx.log.info({ event: "whatsapp_signup", phone: maskPhone(phone), status });
    return c.json({ ok: true, status });
  });

  const secret = ctx.cfg.chatloomWebhookSecret;
  const notConfigured = (c: Context) => c.json({ error: "not_configured" }, 501);
  const signed = (c: Context, raw: string) => !!secret &&
    verifyChatLoomRequest(secret, c.req.header("x-chatloom-timestamp"), c.req.header("x-chatloom-signature"), raw, ctx.now().getTime());
  const forbidden = (c: Context) => c.json({ error: "forbidden" }, 403);

  const due = db.prepare(`SELECT id, phone FROM whatsapp_signups WHERE status = 'pending' AND lease_until <= ?
    ORDER BY created_at, rowid LIMIT ?`);
  const lease = db.prepare("UPDATE whatsapp_signups SET lease_until = ? WHERE id = ?");
  const takeBatch = db.transaction((nowMs: number, limit: number) => {
    const rows = due.all(nowMs, limit) as { id: string; phone: string }[];
    for (const row of rows) lease.run(nowMs + OUTBOX_LEASE_MS, row.id);
    return rows;
  });

  app.get("/api/channels/chatloom/outbox", (c) => {
    if (!secret) return notConfigured(c);
    if (!signed(c, "")) return forbidden(c);
    const requested = Number(c.req.query("limit") ?? OUTBOX_BATCH);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 0), OUTBOX_BATCH) : OUTBOX_BATCH;
    const rows = limit ? takeBatch(ctx.now().getTime(), limit) : [];
    if (rows.length) ctx.log.info({ event: "whatsapp_outbox_leased", count: rows.length });
    const text = welcomeText(ctx.cfg.publicBaseUrl);
    return c.json({ items: rows.map(row => ({ id: row.id, phone: row.phone, text })) });
  });

  const current = db.prepare("SELECT status FROM whatsapp_signups WHERE id = ?");
  const markSent = db.prepare(`UPDATE whatsapp_signups SET status = 'sent', sent_at = ?, updated_at = ?, error = NULL, lease_until = 0
    WHERE id = ? AND status IN ('pending', 'failed')`);
  const markFailed = db.prepare(`UPDATE whatsapp_signups SET status = 'failed', error = ?, updated_at = ?, lease_until = 0
    WHERE id = ? AND status = 'pending'`);

  app.post("/api/channels/chatloom/outbox/:id", async (c) => {
    if (!secret) return notConfigured(c);
    const raw = await c.req.text();
    if (!signed(c, raw)) return forbidden(c);
    let ack: z.infer<typeof AckBody>;
    try {
      ack = AckBody.parse(JSON.parse(raw));
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const id = c.req.param("id");
    const now = ctx.now().toISOString();
    const result = db.transaction((): 200 | 404 | 409 => {
      const row = current.get(id) as { status: SignupStatus } | undefined;
      if (!row) return 404;
      // A repeated acknowledgement is a no-op; a late success may override a failure, never the other way round.
      if (row.status === ack.status) return 200;
      const changes = ack.status === "sent" ? markSent.run(now, now, id).changes : markFailed.run(scrubError(ack.error), now, id).changes;
      return changes ? 200 : 409;
    })();
    if (result === 404) return c.json({ error: "not_found" }, 404);
    if (result === 409) return c.json({ error: "conflict" }, 409);
    ctx.log.info({ event: "whatsapp_outbox_ack", status: ack.status });
    return c.json({ ok: true });
  });
}
