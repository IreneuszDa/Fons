/**
 * Demonstracyjny adapter SMS (warunek brzegowy zadania: „jeden kanał i adapter demonstracyjny”).
 *
 * Działa dokładnie jak prawdziwa bramka SMS (np. operator / Twilio), tylko bez operatora i bez kosztów (0 USD):
 *  - wiadomość przychodzi webhookiem POST /api/channels/sms/webhook, podpisanym HMAC-SHA256
 *    (nagłówki `x-fons-timestamp` i `x-fons-signature: sha256=HMAC(sekret, "{timestamp}.{surowe ciało}")`,
 *    okno 5 min) — ta sama ścieżka co każdy kanał: podpis → parseInbound → deduplikacja → handleInbound → send;
 *  - numer nadawcy nigdy nie jest zapisywany: senderId = HMAC z pepperem („sms:{numer}”), sesja z tego skrótu;
 *  - odpowiedź jest renderowana szablonem (bez LLM) do 1–2 SMS-ów (≤ 320 znaków) z odnośnikiem do pełnego wyniku
 *    /w/{token} i trafia do skrzynki nadawczej symulatora (zamiast do operatora).
 * Strona /telefon (src/web) wysyła wiadomości przez serwerowy podpisujący endpoint POST /api/sim/sms — sekret nigdy
 * nie trafia do przeglądarki.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ConversationReply, InboundMessage, OutboundMessage } from "../../shared/contracts";
import { verifyHmacSha256, withinWindow } from "./signature";

export const SMS_MAX_CHARS = 320;
export const SMS_SIGNATURE_HEADER = "x-fons-signature";
export const SMS_TIMESTAMP_HEADER = "x-fons-timestamp";

const MAX_OUTBOX_SESSIONS = 500;
const MAX_OUTBOX_MESSAGES = 10;

const SmsInbound = z.object({
  /** Numer nadawcy (w symulatorze: identyfikator „sim:{losowy}”). */
  from: z.string().min(1).max(64),
  messageId: z.string().min(1).max(128),
  text: z.string().max(4000),
});

export interface SmsSimAdapter extends ChannelAdapter {
  /** Odbiera (i usuwa) SMS-y wysłane do danej sesji. */
  takeOutbox(sessionId: string): string[];
  /** Identyfikator sesji dla numeru nadawcy (ten sam, który nada parseInbound). */
  sessionIdFor(from: string): string;
  /** Podpisuje surowe ciało jak bramka SMS (dla symulatora po stronie serwera i testów). */
  sign(rawBody: string, timestampSec: number): Record<string, string>;
}

export interface SmsSimOptions {
  secret: string;
  pseudonymize(rawId: string): string;
  now(): Date;
}

/** Sekret webhooka symulatora wyprowadzony z pepperu identyfikatorów (bez nowej konfiguracji, różny od pepperu). */
export function deriveSmsSimSecret(pepper: string): string {
  return createHmac("sha256", pepper).update("fons:sms-sim:webhook", "utf8").digest("hex");
}

function fitSms(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1));
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:–—-]\s*$/, "")}…`;
}

/** Renderer SMS (bez LLM): treść skrócona tak, by odnośnik do pełnego wyniku zawsze się zmieścił. */
export function renderSms(reply: ConversationReply, maxChars = SMS_MAX_CHARS): string {
  const link = reply.resultUrl ? `\nWynik i źródła: ${reply.resultUrl}` : "";
  const hint =
    reply.kind === "verdict" || reply.kind === "answer" ? "\nOdpisz: ŹRÓDŁA, DLACZEGO lub USUŃ MOJE DANE" : reply.kind === "confirm_delete" || reply.kind === "confirm_report" ? "\nOdpisz TAK albo NIE" : "";
  const room = maxChars - link.length - hint.length;
  if (room < 40) return fitSms(`${reply.textPl}${link}`, maxChars);
  return `${fitSms(reply.textPl, room)}${hint}${link}`;
}

export function createSmsSimAdapter(opts: SmsSimOptions): SmsSimAdapter {
  const outbox = new Map<string, string[]>();
  const sessionIdFor = (from: string) => `sms_${opts.pseudonymize(`sms:${from}`).slice(0, 32)}`;

  const adapter: SmsSimAdapter = {
    id: "sms",
    capabilities: { maxChars: SMS_MAX_CHARS, supportsImagesIn: false, supportsButtons: false, supportsMarkdown: false },
    verifySignature(rawBody, headers) {
      const ts = headers[SMS_TIMESTAMP_HEADER];
      if (!withinWindow(ts, opts.now().getTime())) return false;
      return verifyHmacSha256(opts.secret, `${ts}.${rawBody}`, headers[SMS_SIGNATURE_HEADER]);
    },
    parseInbound(rawBody): InboundMessage | null {
      const parsed = SmsInbound.safeParse(JSON.parse(rawBody));
      if (!parsed.success) throw new Error("bad_sms");
      const { from, messageId, text } = parsed.data;
      return {
        channel: "sms",
        senderId: opts.pseudonymize(`sms:${from}`),
        sessionId: sessionIdFor(from),
        messageId: `sms_${messageId}`,
        receivedAt: opts.now().toISOString(),
        text,
        images: [],
      };
    },
    render(reply) {
      return renderSms(reply);
    },
    async send(out: OutboundMessage): Promise<void> {
      const list = outbox.get(out.sessionId) ?? [];
      list.push(adapter.render(out.reply));
      outbox.delete(out.sessionId); // odśwież kolejność (najstarsze sesje wypadają pierwsze)
      outbox.set(out.sessionId, list.slice(-MAX_OUTBOX_MESSAGES));
      while (outbox.size > MAX_OUTBOX_SESSIONS) outbox.delete(outbox.keys().next().value!);
    },
    takeOutbox(sessionId) {
      const list = outbox.get(sessionId) ?? [];
      outbox.delete(sessionId);
      return list;
    },
    sessionIdFor,
    sign(rawBody, timestampSec) {
      const ts = String(timestampSec);
      const sig = createHmac("sha256", opts.secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
      return { [SMS_TIMESTAMP_HEADER]: ts, [SMS_SIGNATURE_HEADER]: `sha256=${sig}` };
    },
  };
  return adapter;
}
