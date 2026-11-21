import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { createMcpHttpHandler, GLOBAL_VERIFY_FACTOR, principalIdFor, type McpHttpHandlerOptions } from "./http";
import { makeTestDb, makeTestDeps, stubVerify, TEST_CFG } from "./testkit";

const TOKENS: Record<string, string> = { "tok-analyst": "analyst", "tok-reader": "reader", "tok-b": "analyst" };

function makeHandler(over: Partial<McpHttpHandlerOptions> = {}) {
  const db = makeTestDb();
  const verify = stubVerify();
  const handler = createMcpHttpHandler({
    db,
    deps: makeTestDeps(db),
    cfg: TEST_CFG,
    verify,
    authorize: (b) => (b && TOKENS[b] ? { ok: true, role: TOKENS[b] } : { ok: false }),
    ...over,
  });
  return { handler, db, verify };
}

const clients: Client[] = [];
async function connect(handler: (r: Request) => Promise<Response>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("https://fons.test/mcp"), {
    fetch: ((url: string | URL, init?: RequestInit) => handler(new Request(url, init))) as typeof fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => {});
});

const rpc = (token: string | undefined, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }, extra: Record<string, string> = {}) =>
  new Request("https://fons.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

describe("createMcpHttpHandler — dostęp", () => {
  it("bez tokenu i ze złym tokenem → 401 z WWW-Authenticate", async () => {
    const { handler } = makeHandler();
    for (const t of [undefined, "zly-token"]) {
      const res = await handler(rpc(t));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("authorize, które rzuca, daje 401 (nie 500)", async () => {
    const { handler } = makeHandler({
      authorize: () => {
        throw new Error("boom");
      },
    });
    expect((await handler(rpc("x"))).status).toBe(401);
  });

  it("GET i DELETE → 405 (tryb bezstanowy)", async () => {
    const { handler } = makeHandler();
    for (const method of ["GET", "DELETE"]) {
      const res = await handler(new Request("https://fons.test/mcp", { method, headers: { authorization: "Bearer tok-analyst" } }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("za duże żądanie → 413; odpowiedzi nie mają nagłówków CORS i są no-store", async () => {
    const { handler } = makeHandler();
    const big = await handler(rpc("tok-analyst", { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } }, { "content-length": "70100" }));
    expect(big.status).toBe(413);
    const ok = await handler(rpc("tok-analyst"));
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});

describe("createMcpHttpHandler — klient SDK przez HTTP", () => {
  it("analityk: lista narzędzi i verify_claim zwracają wynik", async () => {
    const { handler, verify } = makeHandler();
    const client = await connect(handler, "tok-analyst");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_report", "list_sources", "search_sources", "verify_claim"]);
    const out = (await client.callTool({ name: "verify_claim", arguments: { text: "PKB Polski wzrósł o 2,9 proc." } })) as any;
    expect(out.structuredContent.mainVerdict).toBe("POTWIERDZONE");
    expect(out.structuredContent.resultUrl).toMatch(/^https:\/\/fons\.test\/w\//);
    expect(verify.calls).toHaveLength(1);
  });

  it("czytelnik nie ma verify_claim, ale ma search_sources", async () => {
    const { handler } = makeHandler();
    const client = await connect(handler, "tok-reader");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("verify_claim");
    const out = (await client.callTool({ name: "search_sources", arguments: { query: "sankcje wobec Rosji" } })) as any;
    expect(out.structuredContent.count).toBeGreaterThan(0);
  });

  it("limit verify_claim działa na token: wyczerpanie jednego nie blokuje drugiego", async () => {
    const { handler, verify } = makeHandler({ verifyPerMinute: 1 });
    const a = await connect(handler, "tok-analyst");
    const b = await connect(handler, "tok-b");
    expect(((await a.callTool({ name: "verify_claim", arguments: { text: "pierwsze twierdzenie" } })) as any).isError).toBeFalsy();
    const second = (await a.callTool({ name: "verify_claim", arguments: { text: "drugie twierdzenie" } })) as any;
    expect(second.isError).toBe(true);
    expect(second.structuredContent.rateLimited).toBe(true);
    expect(((await b.callTool({ name: "verify_claim", arguments: { text: "twierdzenie drugiego tokenu" } })) as any).isError).toBeFalsy();
    expect(verify.calls).toHaveLength(2);
  });

  it("wspólny limit verify_claim: wiele tokenów nie mnoży limitu ponad GLOBAL_VERIFY_FACTOR × limit tokenu (SEC-12)", async () => {
    const many: Record<string, string> = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`tok-${i}`, "analyst"]));
    const { handler, verify } = makeHandler({ verifyPerMinute: 1, authorize: (b) => (b && many[b] ? { ok: true, role: "analyst" } : { ok: false }) });
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await connect(handler, `tok-${i}`);
      results.push(!((await c.callTool({ name: "verify_claim", arguments: { text: `twierdzenie numer ${i}` } })) as any).isError);
    }
    expect(results.filter(Boolean)).toHaveLength(GLOBAL_VERIFY_FACTOR);
    expect(verify.calls).toHaveLength(GLOBAL_VERIFY_FACTOR);
  });

  it("limit żądań HTTP na token → 429 z Retry-After", async () => {
    const { handler } = makeHandler({ requestsPerMinute: 2 });
    expect((await handler(rpc("tok-analyst"))).status).toBe(200);
    expect((await handler(rpc("tok-analyst"))).status).toBe(200);
    const third = await handler(rpc("tok-analyst"));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    expect((await handler(rpc("tok-b"))).status).toBe(200);
  });
});

describe("principalIdFor", () => {
  it("jest stabilny i nie zawiera tokenu", () => {
    expect(principalIdFor("tok-analyst")).toBe(principalIdFor("tok-analyst"));
    expect(principalIdFor("tok-analyst")).not.toContain("analyst");
    expect(principalIdFor("a")).not.toBe(principalIdFor("b"));
  });
});
