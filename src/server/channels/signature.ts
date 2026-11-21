/** Pomocnicze funkcje dla adapterów webhookowych: podpis HMAC na surowym ciele i okno czasowe. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_WINDOW_MS = 5 * 60_000;

/** Porównuje podpis hex (opcjonalnie z prefiksem "sha256=") z HMAC-SHA256 surowego ciała. */
export function verifyHmacSha256(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const given = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/** Znacznik czasu (sekundy lub ms) musi mieścić się w oknie 5 minut. */
export function withinWindow(timestamp: string | undefined, nowMs: number, windowMs = WEBHOOK_WINDOW_MS): boolean {
  if (!timestamp) return false;
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return false;
  const ms = n < 1e12 ? n * 1000 : n;
  return Math.abs(nowMs - ms) <= windowMs;
}
