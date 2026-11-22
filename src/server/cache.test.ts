import { describe, expect, it } from "vitest";
import { CACHE_TTL_DEGRADED_MS, CACHE_TTL_LIVE_MS, CACHE_TTL_MS, computeCacheKey } from "./cache";
import { chat, makeEnv, makeReport, type TestEnv } from "./testkit";

const ATTACK = { location: "fetched_page" as const, pattern: "ignore_previous_pl", excerpt: "zignoruj poprzednie instrukcje", severity: "high" as const };

function count(env: TestEnv, sql: string, ...args: unknown[]): number {
  return (env.db.prepare(sql).get(...args) as { n: number }).n;
}

describe("cache obliczeń", () => {
  it("rozróżnia identyfikatory dokumentów i wielkość liter w adresie kanału cytowanym w tekście", () => {
    const { ctx } = makeEnv();
    const common = { receivedAt: "2026-11-22T10:00:00Z", channel: "web" };
    const key = (url: string) => computeCacheKey(ctx, { ...common, kind: "url", url });
    expect(key("https://wydawca.example/page?ref=A")).not.toBe(key("https://wydawca.example/page?ref=B"));
    const textKey = (text: string) => computeCacheKey(ctx, { ...common, kind: "text", text });
    expect(textKey("Sprawdź youtube.com/channel/UCAAAAAAAAAAAAAAAAAAAAAA"))
      .not.toBe(textKey("Sprawdź youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"));
  });
  it("wynik z wykazu gaśnie po 30 dniach od odczytu źródła, nawet gdy został dopiero zapisany", async () => {
    const env = makeEnv({ engine: () => {
      const report = makeReport({ sourceActivity: { branches: [{ id: "official_membership", labelPl: "wykaz", status: "completed", candidateCount: 1 }], assessedCount: 1, candidateCount: 1 } });
      report.verdicts[0]!.evidence[0]!.fetchedAt = "2026-10-22T10:05:00Z";
      return report;
    } });
    const input = { text: "Czy Chorwacja należy do NATO?" };
    await chat(env, input);
    env.advance(4 * 60_000);
    expect((await chat(env, input)).json.reply.report.cacheHit).toBe(true);
    env.advance(60_000);
    expect((await chat(env, input)).json.reply.report.cacheHit).toBe(false);
  });
  it("ponawia analizę filmu po zmianie konfiguracji modelu obrazu", async () => {
    const env = makeEnv({ cfg: { videoProvider: "openai", openaiApiKey: "test" } });
    const input = { text: "https://www.instagram.com/reel/AbC123/" };
    await chat(env, input);
    expect((await chat(env, input)).json.reply.report.cacheHit).toBe(true);
    env.ctx.cfg.openaiVideoModel = "model-b";
    expect((await chat(env, input)).json.reply.report.cacheHit).toBe(false);
    env.ctx.cfg.videoProvider = "off";
    expect((await chat(env, input)).json.reply.report.cacheHit).toBe(false);
    expect(env.calls).toHaveLength(3);
  });

  it("ponawia próbę odczytu obrazu po raporcie z samą transkrypcją", async () => {
    const env = makeEnv({ engine: () => makeReport({ videoAnalysis: {
      platform: "facebook", provider: "openai", status: "transcript_only", transcriptSource: "openai", caption: "",
      transcript: [{ seconds: 0, text: "Nagranie testowe" }], observations: [], claimOrigins: [],
    } }) });
    const input = { text: "https://facebook.com/watch/?v=123" };
    await chat(env, input);
    await chat(env, input);
    expect(env.calls).toHaveLength(2);
  });

  it("distinguishes watch IDs and shares canonical YouTube results across Shorts and short links", async () => {
    const env = makeEnv();
    for (const text of ["youtube.com/watch?v=abcdefghijk", "https://youtu.be/abcdefghijk?t=4", "https://www.youtube.com/shorts/abcdefghijk",
      "youtube.com/watch?v=abcdefghij2", "facebook.com/watch/?v=123", "facebook.com/watch/?v=456"]) {
      await chat(env, { text });
    }
    expect(env.calls.map(call => call.url)).toEqual(["https://youtube.com/watch?v=abcdefghijk", "https://youtube.com/watch?v=abcdefghij2",
      "https://facebook.com/watch/?v=123", "https://facebook.com/watch/?v=456"]);
  });
  it("trafienie: silnik wołany raz, nowa kopia raportu z nowym tokenem i cacheHit=true", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Ziemia jest okrągła" });
    const b = await chat(env, { text: "  ziemia   JEST okrągła " }); // inna sesja, to samo znormalizowane wejście
    expect(env.calls).toHaveLength(1);
    const ra = a.json.reply.report;
    const rb = b.json.reply.report;
    expect(ra.cacheHit).toBe(false);
    expect(rb.cacheHit).toBe(true);
    expect(rb.token).not.toBe(ra.token);
    expect(rb.id).not.toBe(ra.id);
    expect(rb.token).toHaveLength(22);
    expect(rb.costUsd).toBe(0);
    expect(rb.mainVerdict).toBe(ra.mainVerdict);
    expect(count(env, "SELECT COUNT(*) AS n FROM reports")).toBe(2);
    // każdy użytkownik ma własną kopię
    expect((await env.app.request(`/api/report/${ra.token}`)).status).toBe(200);
    expect((await env.app.request(`/api/report/${rb.token}`)).status).toBe(200);
  });

  it("każde trafienie w cache zapisuje od nowa zdarzenia bezpieczeństwa z nowym identyfikatorem żądania", async () => {
    const env = makeEnv({
      engine: () =>
        makeReport({
          claim: "Strona z atakiem",
          securityEvents: [ATTACK],
          warnings: [{ kind: "injection_detected", textPl: "W materiale wykryto próbę wpłynięcia na system — zignorowano." }],
        }),
    });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await chat(env, { text: "Strona z atakiem" }));
    expect(env.calls).toHaveLength(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM security_events")).toBe(3);
    expect(count(env, "SELECT COUNT(DISTINCT request_id) AS n FROM security_events")).toBe(3);
    expect(count(env, "SELECT COUNT(*) AS n FROM security_events WHERE source = 'cache_replay'")).toBe(2);
    expect(results[2]!.json.reply.textPl).not.toContain("próbę wpłynięcia na system");
    expect(results[2]!.json.reply.report.securityEvents).toHaveLength(1);
    // zdarzenia zapisane w dzienniku przebiegów też
    expect(count(env, "SELECT COUNT(*) AS n FROM runs WHERE security_event_count = 1")).toBe(3);
  });

  it("TTL 48 h dla przebiegu pełnego", async () => {
    const env = makeEnv();
    await chat(env, { text: "Pytanie A" });
    env.advance(CACHE_TTL_MS - 60_000);
    await chat(env, { text: "Pytanie A" });
    expect(env.calls).toHaveLength(1);
    env.advance(120_000);
    await chat(env, { text: "Pytanie A" });
    expect(env.calls).toHaveLength(2);
  });

  it("TTL 15 min, gdy włączone są źródła na żywo (stan „na teraz” szybko się starzeje)", async () => {
    const env = makeEnv({ cfg: { liveSearch: true } });
    await chat(env, { text: "Czy jest teraz alert RCB?" });
    env.advance(CACHE_TTL_LIVE_MS - 30_000);
    await chat(env, { text: "Czy jest teraz alert RCB?" });
    expect(env.calls).toHaveLength(1);
    env.advance(60_000);
    await chat(env, { text: "Czy jest teraz alert RCB?" });
    expect(env.calls).toHaveLength(2);
  });

  it("TTL 15 min, gdy gałąź opcjonalna była niedostępna", async () => {
    const env = makeEnv({ engine: (r) => makeReport({ claim: r.text, unavailableBranches: ["live"] }) });
    await chat(env, { text: "Pytanie B" });
    env.advance(CACHE_TTL_DEGRADED_MS - 30_000);
    await chat(env, { text: "Pytanie B" });
    expect(env.calls).toHaveLength(1);
    env.advance(60_000);
    await chat(env, { text: "Pytanie B" });
    expect(env.calls).toHaveLength(2);
  });

  it.each([
    ["NIEPELNE", () => makeReport({ status: "NIEPELNE", mainVerdict: null, verdicts: [] })],
    ["DOPRECYZUJ", () => makeReport({ status: "DOPRECYZUJ", mainVerdict: null, verdicts: [] })],
    ["POZA_ZAKRESEM", () => makeReport({ status: "POZA_ZAKRESEM", mainVerdict: null, verdicts: [] })],
    [
      "AWARIA (wyjątek)",
      () => {
        throw new Error("boom");
      },
    ],
  ])("nie zapisuje do cache statusu %s", async (_name, produce) => {
    const env = makeEnv({ engine: () => produce() });
    const a = await chat(env, { text: "Pytanie C" });
    await chat(env, { text: "Pytanie C" });
    expect(env.calls).toHaveLength(2);
    expect(count(env, "SELECT COUNT(*) AS n FROM computation_cache")).toBe(0);
    expect(a.json.reply.kind).toBe("status");
    expect(a.json.reply.report?.mainVerdict ?? null).toBeNull();
  });

  it("status OK z trafieniem detektora jest zapisywany do cache", async () => {
    const env = makeEnv({ engine: () => makeReport({ securityEvents: [ATTACK] }) });
    await chat(env, { text: "Pytanie D" });
    expect(count(env, "SELECT COUNT(*) AS n FROM computation_cache")).toBe(1);
  });

  it.each(["Wczoraj była manifestacja", "Czy ostatnio odbył się strajk generalny?"])("uwzględnia dzień pytania o zmienny okres: %s", async text => {
    const env = makeEnv();
    await chat(env, { text });
    await chat(env, { text });
    expect(env.calls).toHaveLength(1);
    env.advance(86_400_000);
    await chat(env, { text });
    expect(env.calls).toHaveLength(2);
  });

  it("PII jest maskowane przed liczeniem hasha (ten sam wniosek z różnym PESEL = jedno wejście)", async () => {
    const env = makeEnv();
    await chat(env, { text: "Jan 12345678901 dostał mandat" });
    await chat(env, { text: "Jan 10987654321 dostał mandat" });
    expect(env.calls).toHaveLength(1);
  });

  it("„usuń moje dane” nie otwiera klucza: ponowne wyliczenie trafia tylko do pytającego, nie do cache (SEC-02)", async () => {
    let n = 0;
    const env = makeEnv({ engine: () => makeReport({ claim: "Łańcuszek X", verdict: ++n === 1 ? "FALSZYWE" : "POTWIERDZONE" }) });
    const first = await chat(env, { text: "Łańcuszek X" });
    expect(first.json.reply.report.mainVerdict).toBe("FALSZYWE");
    // napastnik kasuje swoje dane (to on utworzył wpis cache) i wysyła ponownie
    const del = await env.app.request("/api/session", { method: "DELETE", headers: { cookie: first.cookie } });
    expect((await del.json()).deleted.cache).toBe(1);
    const reroll = await chat(env, { text: "Łańcuszek X" });
    expect(reroll.json.reply.report.mainVerdict).toBe("POTWIERDZONE");
    expect(count(env, "SELECT COUNT(*) AS n FROM computation_cache")).toBe(0);
    // kolejny obywatel nie dostaje „wylosowanego” wyniku z cache
    const citizen = await chat(env, { text: "Łańcuszek X" });
    expect(citizen.json.reply.report.cacheHit).toBe(false);
    expect(env.calls).toHaveLength(3);
    // po końcu pierwotnego TTL klucz znów może trafić do cache
    env.advance(CACHE_TTL_MS + 60_000);
    await chat(env, { text: "Łańcuszek X" });
    expect(count(env, "SELECT COUNT(*) AS n FROM computation_cache")).toBe(1);
  });

  it("wynik w cache nie niesie parametrów śledzących pierwszego zgłaszającego (SEC-08)", async () => {
    const env = makeEnv({
      engine: (req) => makeReport({ claim: "Artykuł", inputEchoMasked: req.url ?? "" } as never),
    });
    await chat(env, { text: "https://news.example/a?id=7&mc_eid=SUBSCRIBER1&utm_term=nl42" });
    const b = await chat(env, { text: "https://news.example/a?id=7" });
    expect(b.json.reply.report.cacheHit).toBe(true);
    expect(b.json.reply.report.inputEchoMasked).toBe("https://news.example/a?id=7");
    expect(JSON.stringify(b.json.reply.report)).not.toMatch(/SUBSCRIBER1|nl42/);
  });

  it("administrator może unieważnić wpis", async () => {
    const env = makeEnv();
    await chat(env, { text: "Pytanie E" });
    const { invalidateCache } = await import("./cache");
    expect(invalidateCache(env.db, { all: true })).toBe(1);
    await chat(env, { text: "Pytanie E" });
    expect(env.calls).toHaveLength(2);
  });
});
