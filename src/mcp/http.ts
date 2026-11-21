/**
 * Transport HTTP (Streamable HTTP, tryb bezstanowy) dla serwera MCP — do zamontowania przez serwer pod /mcp:
 *
 *   const handler = createMcpHttpHandler({ db, deps, authorize });
 *   app.all("/mcp", (c) => handler(c.req.raw));
 *
 * Zasady:
 *  - tylko POST z nagłówkiem `Authorization: Bearer <token>`; `authorize(bearer)` decyduje o dostępie i roli
 *    (brak/zły token → 401, bez ujawniania powodu); GET/DELETE → 405 (bez sesji i strumieni serwera);
 *  - limit zapytań na token (HTTP: domyślnie 120/min; verify_claim: 6/min; pozostałe narzędzia: 60/min) → 429;
 *  - treść żądania ≤ 64 KB; żadnych nagłówków CORS (klienci MCP to nie przeglądarki); odpowiedzi `no-store`;
 *  - nowy McpServer + transport na żądanie (bezstanowo), więc nic nie przecieka między klientami.
 */
import { createHash } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Database } from "better-sqlite3";
import type { EngineDeps, VerifyRequest } from "../engine/verify";
import { createRateLimiter, type RateLimiter } from "../security/ratelimit";
import type { VerdictReport } from "../shared/contracts";
import { createFonsMcpServer, DEFAULT_TOOL_PER_MINUTE, DEFAULT_VERIFY_PER_MINUTE } from "./server";
import type { McpCfg } from "./runner";

export interface McpAuthResult {
  ok: boolean;
  /** "analyst" (domyślnie wszystkie narzędzia) albo "reader" (bez verify_claim). */
  role?: string;
}

export interface McpHttpHandlerOptions {
  db: Database;
  deps: EngineDeps;
  authorize: (bearer: string | undefined) => McpAuthResult;
  cfg?: McpCfg;
  verify?: (req: VerifyRequest) => Promise<VerdictReport>;
  /** Limit wszystkich żądań HTTP na token (domyślnie 120/min). */
  requestsPerMinute?: number;
  verifyPerMinute?: number;
  toolPerMinute?: number;
  maxInputChars?: number;
  now?: () => Date;
}

export const MAX_MCP_BODY_BYTES = 64 * 1024;
/** Wspólny limit verify_claim (wszystkie tokeny) = tyle razy limit jednego tokenu. */
export const GLOBAL_VERIFY_FACTOR = 3;

const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function jsonError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra },
  });
}

/** Wyciąga token z nagłówka Authorization (schemat Bearer, bez rozróżniania wielkości liter w nazwie schematu). */
export function bearerOf(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1];
}

/** Stabilny identyfikator tokenu bez ujawniania go (klucz limitów i pseudonimu nadawcy). */
export function principalIdFor(bearer: string): string {
  return `t_${createHash("sha256").update(bearer).digest("hex").slice(0, 16)}`;
}

export function createMcpHttpHandler(opts: McpHttpHandlerOptions): (req: Request) => Promise<Response> {
  const httpLimiter = createRateLimiter({ perMinute: opts.requestsPerMinute ?? 120 });
  const perTokenVerify = createRateLimiter({ perMinute: opts.verifyPerMinute ?? DEFAULT_VERIFY_PER_MINUTE });
  // Wspólny limit verify_claim dla wszystkich tokenów (SEC-12): wiele tokenów jednego konta nie mnoży limitu.
  const globalVerify = createRateLimiter({ perMinute: (opts.verifyPerMinute ?? DEFAULT_VERIFY_PER_MINUTE) * GLOBAL_VERIFY_FACTOR });
  const verifyLimiter: RateLimiter = {
    check: (key) => perTokenVerify.remaining(key) > 0 && globalVerify.check("all") && perTokenVerify.check(key),
    remaining: (key) => Math.min(perTokenVerify.remaining(key), globalVerify.remaining("all")),
    reset: (key) => {
      perTokenVerify.reset(key);
      if (key === undefined) globalVerify.reset();
    },
  };
  const toolLimiter = createRateLimiter({ perMinute: opts.toolPerMinute ?? DEFAULT_TOOL_PER_MINUTE });

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return jsonError(405, -32000, "Method not allowed", { allow: "POST" });
    }
    const bearer = bearerOf(req);
    let auth: McpAuthResult = { ok: false };
    try {
      auth = bearer ? opts.authorize(bearer) : { ok: false };
    } catch {
      auth = { ok: false };
    }
    if (!bearer || !auth.ok) {
      return jsonError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="fons-mcp"' });
    }
    const principal = { id: principalIdFor(bearer), role: auth.role };
    if (!httpLimiter.check(principal.id)) {
      return jsonError(429, -32002, "Too many requests", { "retry-after": "60" });
    }
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
      return jsonError(413, -32003, "Request too large");
    }

    const server = createFonsMcpServer({
      db: opts.db,
      deps: opts.deps,
      principal,
      cfg: opts.cfg,
      verify: opts.verify,
      verifyLimiter,
      toolLimiter,
      maxInputChars: opts.maxInputChars,
      now: opts.now,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req, { authInfo: { token: principal.id, clientId: principal.id, scopes: [principal.role ?? "analyst"] } });
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch {
      return jsonError(500, -32603, "Internal error");
    } finally {
      // Odpowiedź JSON jest już kompletna — zamykamy serwer tego żądania.
      void server.close().catch(() => {});
    }
  };
}
