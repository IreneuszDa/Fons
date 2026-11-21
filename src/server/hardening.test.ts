import { describe, expect, it } from "vitest";
import { addClientTokens, clientBudgetExceeded } from "./budget";
import { clientKey } from "./http";
import { adminLogin, chat, loginAs, makeEnv } from "./testkit";

describe("ochrona /api/chat przed żądaniami z obcych stron (SEC-05)", () => {
  it("POST text/plain (proste żądanie bez preflightu) → 415, silnik niewołany", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/chat", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "x" }) });
    expect(res.status).toBe(415);
    const none = await env.app.request("/api/chat", { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(none.status).toBe(415);
    expect(env.calls).toHaveLength(0);
  });

  it("obcy Origin albo Sec-Fetch-Site: cross-site → 403; ta sama strona → 200", async () => {
    const env = makeEnv();
    const send = (headers: Record<string, string>) =>
      env.app.request("http://localhost:8787/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ text: "Ziemia jest okrągła" }),
      });
    expect((await send({ origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(env.calls).toHaveLength(0);
    expect((await send({ origin: "http://localhost:8787", "sec-fetch-site": "same-origin" })).status).toBe(200);
    // proxy Vite (dev): Origin = Host żądania
    expect((await send({ origin: "http://localhost:5173", host: "localhost:5173" })).status).toBe(200);
  });

  it("DELETE /api/session z obcej strony → 403", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/session", { method: "DELETE", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("udział jednego klienta w dobowym budżecie (SEC-04)", () => {
  it("klucz klienta: IPv6 przycięte do /64, IPv4-mapped jako IPv4", () => {
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::1")).toBe(clientKey("2001:db8:1:2:ffff::9"));
    expect(clientKey("2001:db8:1:3::1")).not.toBe(clientKey("2001:db8:1:2::1"));
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("unknown")).toBe("unknown");
  });

  it("licznik per klient i doba", () => {
    const usage = new Map();
    const cfg = { dailyTokenBudget: 1000, ipDailyTokenShare: 0.1 };
    const day1 = new Date("2026-11-21T10:00:00Z");
    addClientTokens(usage, "a", day1, 99);
    expect(clientBudgetExceeded(usage, cfg, "a", day1)).toBe(false);
    addClientTokens(usage, "a", day1, 1);
    expect(clientBudgetExceeded(usage, cfg, "a", day1)).toBe(true);
    expect(clientBudgetExceeded(usage, cfg, "b", day1)).toBe(false);
    expect(clientBudgetExceeded(usage, cfg, "a", new Date("2026-11-22T10:00:00Z"))).toBe(false);
  });

  it("po wyczerpaniu udziału klient dostaje komunikat o budżecie (bez werdyktu), cache dalej działa, bezpiecznik globalny nietknięty", async () => {
    const env = makeEnv({ cfg: { dailyTokenBudget: 10_000, ipDailyTokenShare: 0.01 } }); // udział 100 tokenów, przebieg = 150
    const a = await chat(env, { text: "Pierwsze pytanie" });
    expect(a.json.reply.kind).toBe("verdict");
    const b = await chat(env, { text: "Drugie, nowe pytanie" });
    expect(b.json.reply.kind).toBe("status");
    expect(b.json.reply.textPl).toContain("limit");
    expect(env.calls).toHaveLength(1);
    const cached = await chat(env, { text: "Pierwsze pytanie" });
    expect(cached.json.reply.report.cacheHit).toBe(true);
  });
});

describe("tokeny API: analityk odwołuje tylko własne (SEC-12)", () => {
  const req = (cookie: string, method: string, csrf: string, body?: unknown) => ({
    method,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  it("token administratora: analityk 403, administrator 200; własny token analityk odwołuje", async () => {
    const env = makeEnv();
    const admin = await adminLogin(env);
    const adminTok = (await (await env.app.request("/api/admin/tokens", req(admin.cookie, "POST", admin.csrf, { label: "integracja" }))).json()) as { id: string };
    const analyst = await loginAs(env, "analityk");
    expect((await env.app.request(`/api/admin/tokens/${adminTok.id}`, req(analyst.cookie, "DELETE", analyst.csrf))).status).toBe(403);
    const own = (await (await env.app.request("/api/admin/tokens", req(analyst.cookie, "POST", analyst.csrf, { label: "moj" }))).json()) as { id: string };
    expect((await env.app.request(`/api/admin/tokens/${own.id}`, req(analyst.cookie, "DELETE", analyst.csrf))).status).toBe(200);
    const admin2 = await adminLogin(env);
    expect((await env.app.request(`/api/admin/tokens/${adminTok.id}`, req(admin2.cookie, "DELETE", admin2.csrf))).status).toBe(200);
  });
});
