import { describe, expect, it } from "vitest";
import { verifyChain } from "./audit";
import { chat, makeEnv, makeReport, type TestEnv } from "./testkit";

const n = (env: TestEnv, sql: string, ...a: unknown[]) => (env.db.prepare(sql).get(...a) as { n: number }).n;

describe("DELETE /api/session", () => {
  it("usuwa raporty, dane osobowe przebiegów, wiersze w sprawach i wpisy cache tej sesji — cudze dane zostają", async () => {
    const env = makeEnv({ engine: (r) => makeReport({ verdict: "BRAK_DOWODOW", claim: r.text }) });
    const a = await chat(env, { text: "Producent lodów dodaje szkło do waniliowych" });
    const b = await chat(env, { text: "producent lodów dodaje szkło do waniliowych" }); // cache z sesji A, sprawa wspólna
    const c = await chat(env, { text: "Zupełnie inna sprawa o bankach i opłatach" });
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = 1")).toBe(2);
    const tokenA = a.json.reply.report.token;
    const tokenB = b.json.reply.report.token;
    const tokenC = c.json.reply.report.token;

    const res = await env.app.request("/api/session", { method: "DELETE", headers: { cookie: a.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deleted).toMatchObject({ reports: 1, runs: 1, cache: 1, caseSenders: 1, sessions: 1 });
    expect(res.headers.get("set-cookie")).toMatch(/pw_sid=;|Max-Age=0/i);

    expect((await env.app.request(`/api/report/${tokenA}`)).status).toBe(404);
    expect((await env.app.request(`/api/report/${tokenB}`)).status).toBe(200); // własna kopia B nietknięta
    expect((await env.app.request(`/api/report/${tokenC}`)).status).toBe(200);
    expect(n(env, "SELECT COUNT(*) AS n FROM computation_cache")).toBe(1); // wpis sesji C; wpis A usunięty
    expect(n(env, "SELECT COUNT(*) AS n FROM sessions")).toBe(2);
    // sprawa przeżywa z jednym nadawcą (B), licznik zaktualizowany
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = 1")).toBe(1);
    // dziennik: pola osobowe wyczyszczone tylko dla A
    expect(n(env, "SELECT COUNT(*) AS n FROM runs WHERE erased = 1 AND input_masked = '' AND sender_id IS NULL")).toBe(1);
    expect(n(env, "SELECT COUNT(*) AS n FROM runs WHERE erased = 0 AND input_masked <> ''")).toBe(2);
    // łańcuch audytu nadal się weryfikuje
    expect(verifyChain(env.db)).toMatchObject({ ok: true, checked: 3 });
  });

  it("sprawa bez pozostałych nadawców znika; bez ciasteczka nic nie robi; ciasteczko cudzej sesji nie wystarczy do cudzych danych", async () => {
    const env = makeEnv({ engine: (r) => makeReport({ verdict: "BRAK_DOWODOW", claim: r.text }) });
    const a = await chat(env, { text: "Producent lodów dodaje szkło do waniliowych" });
    const none = await env.app.request("/api/session", { method: "DELETE" });
    expect(((await none.json()) as any).deleted.reports).toBe(0);
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(1);
    const fake = await env.app.request("/api/session", { method: "DELETE", headers: { cookie: "pw_sid=00000000000000000000000000000000" } });
    expect(((await fake.json()) as any).deleted.reports).toBe(0);
    await env.app.request("/api/session", { method: "DELETE", headers: { cookie: a.cookie } });
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(0);
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(0);
  });

  it("zdarzenia bezpieczeństwa zostają jako anonimowe liczniki (bez fragmentu i nadawcy)", async () => {
    const ev = { location: "fetched_page" as const, pattern: "ignore_previous_pl", excerpt: "zignoruj instrukcje", severity: "high" as const };
    const env = makeEnv({ engine: () => makeReport({ securityEvents: [ev] }) });
    const a = await chat(env, { text: "Strona z atakiem" });
    await env.app.request("/api/session", { method: "DELETE", headers: { cookie: a.cookie } });
    const row = env.db.prepare("SELECT excerpt, sender_id, session_id, pattern FROM security_events").get() as any;
    expect(row).toEqual({ excerpt: "", sender_id: null, session_id: null, pattern: "ignore_previous_pl" });
  });

  it("wskazanie nieznanej lub cudzej rozmowy bez ciasteczka daje 404, bez tworzenia nowej sesji", async () => {
    const env = makeEnv();
    expect((await chat(env, { text: "Pytanie", sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).status).toBe(404);
    const own = await chat(env, { text: "Pytanie" });
    expect((await chat(env, { action: "sources", sessionId: own.json.sessionId })).status).toBe(404);
    expect(n(env, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
  });
});
