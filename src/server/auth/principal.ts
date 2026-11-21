/** Ustalanie, kto wysyła żądanie: sesja panelu (ciasteczko) albo token API (Authorization: Bearer). */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { ServerContext } from "../context";
import { safeEqual } from "../util";
import type { Role } from "./permissions";
import { bearerFrom } from "./tokens";

export const ADMIN_COOKIE = "pw_admin";
export const ADMIN_SESSION_TTL_MS = 8 * 3_600_000;

export interface Principal {
  kind: "session" | "token";
  /** Login użytkownika albo `token:<etykieta>`. */
  username: string;
  role: Role;
  csrf?: string;
  tokenId?: string;
}

/** Nazwa do dziennika audytu (token → stabilny identyfikator, nie etykieta wpisana przez człowieka). */
export function actorName(p: Principal): string {
  return p.kind === "token" ? `token:${p.tokenId}` : p.username;
}

/** Sesja z ciasteczka; rola pochodzi z aktualnego rekordu użytkownika, więc zmiana/usunięcie działa od razu. */
function sessionPrincipal(ctx: ServerContext, c: Context): Principal | null {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token) return null;
  const sess = ctx.adminSessions.get(token);
  if (!sess) return null;
  if (sess.expiresAt <= ctx.now().getTime()) {
    ctx.adminSessions.delete(token);
    return null;
  }
  const user = ctx.auth.users.get(sess.username);
  if (!user) {
    ctx.adminSessions.delete(token);
    return null;
  }
  return { kind: "session", username: user.username, role: user.role, csrf: sess.csrf };
}

/** Jeśli jest nagłówek Authorization, liczy się tylko on (jawne poświadczenie wygrywa z ciasteczkiem). */
export function authenticateRequest(ctx: ServerContext, c: Context): Principal | null {
  const header = c.req.header("authorization");
  if (header) {
    const raw = bearerFrom(header);
    if (!raw) return null;
    const t = ctx.auth.tokens.authenticate(raw);
    return t ? { kind: "token", username: `token:${t.label}`, role: t.role, tokenId: t.id } : null;
  }
  return sessionPrincipal(ctx, c);
}

/** Token API analityka (dla /mcp i /metrics) — nie zależy od ciasteczek. */
export function authenticateBearerRequest(ctx: ServerContext, req: Request): Principal | null {
  const raw = bearerFrom(req.headers.get("authorization"));
  if (!raw) return null;
  const t = ctx.auth.tokens.authenticate(raw);
  return t ? { kind: "token", username: `token:${t.label}`, role: t.role, tokenId: t.id } : null;
}

/** /metrics: token API analityka albo statyczny METRICS_TOKEN (porównanie w stałym czasie). */
export function authorizeMetrics(ctx: ServerContext, req: Request): boolean {
  const raw = bearerFrom(req.headers.get("authorization"));
  if (!raw) return false;
  const configured = ctx.cfg.metricsToken;
  if (configured && safeEqual(raw, configured)) return true;
  return ctx.auth.tokens.authenticate(raw) !== null;
}
