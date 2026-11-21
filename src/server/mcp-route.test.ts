import { beforeAll, describe, expect, it, vi } from "vitest";
import { chat, makeApiToken, makeEnv } from "./testkit";

const bearer = (t: string, extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { authorization: `Bearer ${t}`, ...(extra.headers as Record<string, string> | undefined) },
});

describe("trasa /mcp", () => {
  // Prawdziwy moduł ../mcp/http ciągnie SDK MCP i silnik: pierwszy import trwa pod pełnym obciążeniem równoległym
  // nawet >5 s. Rozgrzewamy go raz (z długim limitem), żeby test domyślnego loadera mierzył zachowanie trasy,
  // a nie czas kompilacji. Błąd importu jest tu ignorowany — test i tak akceptuje 501 dla braku modułu.
  beforeAll(async () => {
    const spec = "../mcp/http";
    await import(spec).catch(() => undefined);
  }, 120_000);

  it("bez tokenu 401 (z WWW-Authenticate), ze złym tokenem 401, moduł nie jest nawet ładowany", async () => {
    const loader = vi.fn(async () => ({ createMcpHttpHandler: () => async () => new Response("ok") }));
    const env = makeEnv({ options: { mcpLoader: loader } });
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await env.app.request("/mcp", { method });
      expect(res.status, method).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect((await env.app.request("/mcp", bearer("fons_zly", { method: "POST" }))).status).toBe(401);
    expect((await env.app.request("/mcp", { method: "POST", headers: { cookie: "pw_admin=x" } })).status).toBe(401);
    expect(loader).not.toHaveBeenCalled();
  });

  it("501 z błędem JSON, gdy modułu MCP nie da się załadować (serwer i reszta API działają)", async () => {
    const env = makeEnv({
      options: {
        mcpLoader: async () => {
          throw new Error("Cannot find module '../mcp/http'");
        },
      },
    });
    const token = makeApiToken(env);
    const res = await env.app.request("/mcp", bearer(token, { method: "POST", body: "{}" }));
    expect(res.status).toBe(501);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.error).toBe("mcp_unavailable");
    expect(JSON.stringify(body)).not.toContain("Cannot find module"); // treść błędu nie wycieka
    expect((await env.app.request("/api/health")).status).toBe(200);
    expect((await chat(env, { text: "Pytanie" })).status).toBe(200);
  });

  it("501 także, gdy moduł nie eksportuje createMcpHttpHandler albo fabryka rzuca", async () => {
    const a = makeEnv({ options: { mcpLoader: async () => ({}) } });
    expect((await a.app.request("/mcp", bearer(makeApiToken(a), { method: "POST" }))).status).toBe(501);
    const b = makeEnv({ options: { mcpLoader: async () => ({ createMcpHttpHandler: () => { throw new Error("boom"); } }) } });
    expect((await b.app.request("/mcp", bearer(makeApiToken(b), { method: "POST" }))).status).toBe(501);
  });

  it("domyślny loader (prawdziwy import ../mcp/http): token API jest akceptowany przez moduł, nic nie kończy się błędem 500", async () => {
    const env = makeEnv();
    const token = makeApiToken(env);
    const res = await env.app.request("/mcp", bearer(token, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(401); // token przeszedł też autoryzację wewnątrz modułu (albo moduł jeszcze nie istnieje: 501)
    expect([200, 202, 400, 406, 415, 501]).toContain(res.status);
    // GET/DELETE nie są częścią trybu bezstanowego modułu; serwer nie może ich zamienić w 500
    expect((await env.app.request("/mcp", bearer(token, { method: "GET" }))).status).not.toBe(500);
  }, 30_000);

  it("z poprawnym tokenem żądanie trafia do handlera: db, deps i authorize są przekazane, wszystkie metody i podścieżki", async () => {
    const seen: any[] = [];
    const factory = vi.fn((opts: any) => async (req: Request) => {
      const raw = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
      seen.push({ method: req.method, url: new URL(req.url).pathname, authorized: opts.authorize(raw), body: await req.text() });
      return new Response(JSON.stringify({ handled: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const env = makeEnv({ options: { mcpLoader: async () => ({ createMcpHttpHandler: factory }) } });
    const token = makeApiToken(env);
    const post = await env.app.request("/mcp", bearer(token, { method: "POST", body: '{"jsonrpc":"2.0"}', headers: { "content-type": "application/json" } }));
    expect(post.status).toBe(200);
    expect(((await post.json()) as any).handled).toBe(true);
    expect(post.headers.get("x-request-id")).toMatch(/^req_/);
    expect(post.headers.get("x-content-type-options")).toBe("nosniff");
    await env.app.request("/mcp", bearer(token, { method: "GET" }));
    await env.app.request("/mcp/sse", bearer(token, { method: "DELETE" }));
    expect(factory).toHaveBeenCalledTimes(1); // handler budowany raz
    expect(factory.mock.calls[0]![0].db).toBe(env.db);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /mcp", "GET /mcp", "DELETE /mcp/sse"]);
    expect(seen.every((s) => s.authorized.ok === true && s.authorized.role === "analyst")).toBe(true);
    expect(seen[0].body).toBe('{"jsonrpc":"2.0"}');
    // authorize przekazane do modułu odrzuca żądania bez tokenu
    const authorize = factory.mock.calls[0]![0].authorize as (b: string | undefined) => { ok: boolean };
    expect(authorize(undefined)).toEqual({ ok: false });
    expect(authorize("fons_zly")).toEqual({ ok: false });
    expect(authorize(token).ok).toBe(true);
    expect(factory.mock.calls[0]![0].cfg).toBe(env.ctx.cfg);
  });

  it("odwołany token przestaje działać także w /mcp; zbyt duże ciało to 413", async () => {
    const env = makeEnv({ options: { mcpLoader: async () => ({ createMcpHttpHandler: () => async () => new Response("ok") }) } });
    const token = makeApiToken(env);
    expect((await env.app.request("/mcp", bearer(token, { method: "POST", body: "{}" }))).status).toBe(200);
    const big = "x".repeat(1024 * 1024 + 10);
    expect((await env.app.request("/mcp", bearer(token, { method: "POST", body: big }))).status).toBe(413);
    env.ctx.auth.tokens.revoke(env.ctx.auth.tokens.list()[0]!.id);
    expect((await env.app.request("/mcp", bearer(token, { method: "POST", body: "{}" }))).status).toBe(401);
  });
});
