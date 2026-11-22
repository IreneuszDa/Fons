import type { MiddlewareHandler } from "hono";
import type { ServerContext } from "./context";

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // style-src 'unsafe-inline': atrybuty style generowane przez React/StyleX; skrypty pozostają ścisłe
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Nagłówki bezpieczeństwa na każdej odpowiedzi; noindex na stronach wyników i raportach. */
export function securityHeaders(ctx: ServerContext): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("Content-Security-Policy", CSP);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set("X-Frame-Options", "DENY");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=()");
    if (ctx.cfg.env === "production" && ctx.cfg.publicBaseUrl.startsWith("https://")) {
      h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    const p = c.req.path;
    if (p.startsWith("/w/") || p === "/w" || p.startsWith("/api/report/") || p.startsWith("/admin") || p.startsWith("/api/admin")) {
      h.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
  };
}
