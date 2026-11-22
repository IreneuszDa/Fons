import type { Context } from "hono";
import { z } from "zod";
import { isWhatsAppSignupStatus, normalizeWhatsAppPhone } from "../../shared/whatsapp";
import type { ServerContext } from "../context";
import { clientIp, clientKey } from "../http";

export const WHATSAPP_SIGNUP_PATH = "/api/signup/whatsapp";
const DEFAULT_SIGNUP_ORIGIN = "https://fons.siuda.dev";
const FORWARDED_HEADER = "X-Fons-Signup-Forwarded";
const signupBody = z.object({ phone: z.string().max(40), consent: z.literal(true) });
const unavailable = { error: "signup_unavailable", messagePl: "Nie udało się potwierdzić zapisu. Spróbuj ponownie za chwilę." };
const rateLimited = { error: "rate_limited", messagePl: "Zbyt wiele prób. Spróbuj ponownie za chwilę." };

/** The operator service owns the welcome-message queue and deduplicates requests. */
export async function forwardWhatsAppSignup(c: Context, ctx: ServerContext): Promise<Response> {
  if (!ctx.limiters.ip.check(`whatsapp-signup:${clientKey(clientIp(c, ctx))}`)) {
    c.header("Retry-After", "60");
    return c.json(rateLimited, 429);
  }
  const parsed = signupBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request", messagePl: "Podaj numer telefonu i zaznacz zgodę na wiadomość." }, 400);
  const phone = normalizeWhatsAppPhone(parsed.data.phone);
  if (!phone) return c.json({ error: "invalid_phone", messagePl: "Sprawdź numer telefonu i kierunkowy kraju." }, 400);

  try {
    const upstream = new URL(ctx.cfg.whatsappSignupOrigin ?? DEFAULT_SIGNUP_ORIGIN);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
      return c.json(unavailable, 503);
    }
    // Compare the public and request hosts, and stop loops through aliases or reverse proxies.
    if (c.req.header(FORWARDED_HEADER) || [new URL(ctx.cfg.publicBaseUrl).host, new URL(c.req.url).host, c.req.header("host")].includes(upstream.host)) {
      return c.json(unavailable, 503);
    }
    const response = await ctx.fetch(new URL(WHATSAPP_SIGNUP_PATH, upstream), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", [FORWARDED_HEADER]: "1" },
      body: JSON.stringify({ phone, consent: true }),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const delay = response.headers.get("Retry-After") ?? "";
        c.header("Retry-After", /^\d{1,6}$/.test(delay) ? delay : "60");
        return c.json(rateLimited, 429);
      }
      if (response.status === 400 || response.status === 422) {
        return c.json({ error: "signup_rejected", messagePl: "Usługa zapisów odrzuciła zgłoszenie. Sprawdź numer telefonu." }, response.status);
      }
      return c.json(unavailable, 503);
    }
    const result = await response.json();
    if (!isWhatsAppSignupStatus(result?.status)) return c.json(unavailable, 502);
    return c.json({ status: result.status }, response.status === 202 ? 202 : 200);
  } catch {
    return c.json(unavailable, 503);
  }
}
