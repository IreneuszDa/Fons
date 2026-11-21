import { describe, expect, it } from "vitest";
import { createLogger, sanitizeFields } from "./observability/logger";
import { Registry, createServerMetrics } from "./observability/metrics";
import { chat, makeApiToken, makeEnv, makeReport } from "./testkit";

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

function parseMetrics(text: string) {
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m) throw new Error(`zła linia metryki: ${line}`);
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!;
    samples.push({ name: m[1]!, labels, value: m[3] === "+Inf" ? Infinity : Number(m[3]) });
  }
  return samples;
}
const val = (s: ReturnType<typeof parseMetrics>, name: string, labels: Record<string, string> = {}) =>
  s.find((x) => x.name === name && Object.entries(labels).every(([k, v]) => x.labels[k] === v))?.value;

describe("identyfikator żądania", () => {
  it("każda odpowiedź ma X-Request-Id (też 404 i 429), identyfikatory są unikalne", async () => {
    const env = makeEnv();
    const ids = new Set<string>();
    for (const p of ["/api/health", "/api/report/AAAAAAAAAAAAAAAAAAAAAA", "/api/nie-ma", "/nie-ma"]) {
      const res = await env.app.request(p);
      const id = res.headers.get("x-request-id") ?? "";
      expect(id, p).toMatch(/^req_[0-9a-f]{16}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(4);
  });

  it("identyfikatora od klienta nie przejmujemy (trafia do dziennika przebiegów, musi być unikalny)", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/health", { headers: { "x-request-id": "../../etc/passwd" } });
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("ten sam identyfikator jest w nagłówku odpowiedzi czatu, w raporcie i w dzienniku przebiegów", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Pytanie testowe" }) });
    const id = res.headers.get("x-request-id");
    const body = (await res.json()) as any;
    expect(body.reply.report.id).toBe(id);
    expect((env.db.prepare("SELECT request_id FROM runs").get() as any).request_id).toBe(id);
  });
});

describe("logi JSON", () => {
  it("każde żądanie: ts, level, reqId, method, route (szablon), status, latencyMs", async () => {
    const env = makeEnv();
    const c = await chat(env, { text: "Pytanie testowe" });
    await env.app.request(`/api/report/${c.json.reply.report.token}`);
    const lines = env.logs.map((l) => JSON.parse(l));
    const http = lines.filter((l) => l.event === "http");
    expect(http.length).toBeGreaterThanOrEqual(2);
    for (const l of http) {
      expect(l).toMatchObject({ level: "info", method: expect.any(String), route: expect.any(String), status: expect.any(Number), latencyMs: expect.any(Number) });
      expect(l.reqId).toMatch(/^req_/);
      expect(Date.parse(l.ts)).not.toBeNaN();
    }
    const report = http.find((l) => l.method === "GET")!;
    expect(report.route).toBe("/api/report/:token"); // szablon, nie konkretny token
    expect(env.logs.join("\n")).not.toContain(c.json.reply.report.token);
  });

  it("weryfikacja: status, werdykt, cache, modele, tokeny, koszt, czasy kroków, niedostępne gałęzie, zdarzenia — bez treści użytkownika", async () => {
    const env = makeEnv({
      engine: (r) =>
        makeReport({
          claim: r.text,
          unavailableBranches: ["live"],
          timingsMs: { total: 20, retrieval: 7, assess: 9 },
          securityEvents: [{ pattern: "ignore_previous_pl", location: "user_message", severity: "high", excerpt: "zignoruj instrukcje" }],
        }),
    });
    const secret = "Mój PESEL 12345678901 i kod tajny-xyz-987";
    const c = await chat(env, { text: secret });
    const v = env.logs.map((l) => JSON.parse(l)).find((l) => l.event === "verification");
    expect(v).toMatchObject({
      level: "info",
      status: "OK",
      verdict: "POTWIERDZONE",
      cacheHit: false,
      channel: "web",
      inputMode: "claim",
      models: ["stub/stub-main"],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      timingsMs: { retrieval: 7, assess: 9 },
      unavailableBranches: ["live"],
      securityEvents: 1,
    });
    expect(v.reqId).toBe(c.json.reply.report.id);
    const all = env.logs.join("\n");
    for (const forbidden of ["12345678901", "tajny-xyz-987", "zignoruj instrukcje", "Mój PESEL"]) expect(all).not.toContain(forbidden);
    // trafienie w cache: zerowy koszt i brak modeli, ale zdarzenie bezpieczeństwa liczy się ponownie
    await chat(env, { text: secret }, c.cookie);
    const hit = env.logs.map((l) => JSON.parse(l)).filter((l) => l.event === "verification")[1];
    expect(hit).toMatchObject({ cacheHit: true, costUsd: 0, tokensIn: 0, models: [], securityEvents: 1 });
  });

  it("awaria silnika jest zalogowana bez treści błędu", async () => {
    const env = makeEnv({ engine: () => { throw new Error("klucz sk-SEKRET w treści błędu"); } });
    await chat(env, { text: "Pytanie" });
    const v = env.logs.map((l) => JSON.parse(l)).find((l) => l.event === "verification");
    expect(v).toMatchObject({ status: "AWARIA", verdict: null });
    expect(env.logs.join("\n")).not.toContain("SEKRET");
  });

  it("logger wycina pola z treścią i skraca długie napisy", () => {
    const out: string[] = [];
    const log = createLogger((l) => out.push(l), () => new Date("2026-11-21T10:00:00Z"));
    log.info({ event: "x", text: "tajne", Password: "p", body: "b", note: "a".repeat(500), n: 1 });
    const l = JSON.parse(out[0]!);
    expect(l).toMatchObject({ ts: "2026-11-21T10:00:00.000Z", level: "info", event: "x", n: 1 });
    expect(l).not.toHaveProperty("text");
    expect(l).not.toHaveProperty("Password");
    expect(l).not.toHaveProperty("body");
    expect(l.note).toHaveLength(201);
    expect(sanitizeFields({ authorization: "Bearer x", ok: true })).toEqual({ ok: true });
  });
});

describe("GET /metrics", () => {
  it("wymaga tokenu: bez tokenu i ze złym 401, z tokenem API analityka 200, z METRICS_TOKEN 200", async () => {
    const env = makeEnv({ cfg: { metricsToken: "statyczny-token-metryk-123" } });
    const none = await env.app.request("/metrics");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await env.app.request("/metrics", bearer("fons_zly"))).status).toBe(401);
    expect((await env.app.request("/metrics", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await env.app.request("/metrics?token=statyczny-token-metryk-123")).status).toBe(401); // nie z adresu URL
    expect((await env.app.request("/metrics", bearer("statyczny-token-metryk-123"))).status).toBe(200);
    const api = makeApiToken(env);
    const ok = await env.app.request("/metrics", bearer(api));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    env.ctx.auth.tokens.revoke(env.ctx.auth.tokens.list()[0]!.id);
    expect((await env.app.request("/metrics", bearer(api))).status).toBe(401);
  });

  it("bez METRICS_TOKEN i bez tokenów API nikt się nie dostanie", async () => {
    const env = makeEnv();
    expect((await env.app.request("/metrics", bearer(""))).status).toBe(401);
    expect((await env.app.request("/metrics", bearer("undefined"))).status).toBe(401);
  });

  it("format Prometheus: HELP/TYPE, poprawne linie, liczniki wg statusu/werdyktu/kanału, histogramy skumulowane", async () => {
    const env = makeEnv({
      engine: (r, i) =>
        i === 2
          ? makeReport({ verdict: "BRAK_DOWODOW", claim: r.text })
          : makeReport({ claim: r.text, unavailableBranches: i === 1 ? ["live"] : [], timingsMs: { total: 800, retrieval: 300, assess: 400 }, securityEvents: i === 1 ? [{ pattern: "p", location: "evidence", severity: "low", excerpt: "e" }] : [] }),
    });
    const token = makeApiToken(env);
    await chat(env, { text: "Pierwsze" });
    await chat(env, { text: "Drugie" });
    await chat(env, { text: "Pierwsze" }); // cache
    const res = await env.app.request("/metrics", bearer(token));
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    // każda rodzina ma HELP i TYPE przed próbkami
    for (const fam of ["fons_verifications_total", "fons_llm_calls_total", "fons_verification_duration_seconds", "fons_http_requests_total"]) {
      expect(text).toMatch(new RegExp(`# HELP ${fam} .+\\n# TYPE ${fam} (counter|histogram)\\n`));
    }
    const s = parseMetrics(text);
    expect(val(s, "fons_verifications_total", { status: "OK", verdict: "POTWIERDZONE", channel: "web" })).toBe(2);
    expect(val(s, "fons_verifications_total", { status: "OK", verdict: "BRAK_DOWODOW", channel: "web" })).toBe(1);
    expect(val(s, "fons_abstentions_total", { reason: "brak_dowodow" })).toBe(1);
    expect(val(s, "fons_cache_hits_total")).toBe(1);
    expect(val(s, "fons_injection_events_total")).toBe(2); // 1 świeże + 1 powtórzone z cache
    expect(val(s, "fons_retrieval_branch_failures_total", { branch: "live" })).toBe(1);
    expect(val(s, "fons_llm_calls_total", { provider: "stub", model: "stub-main", purpose: "assess" })).toBe(2);
    expect(val(s, "fons_llm_tokens_total", { model: "stub-main", purpose: "assess", direction: "input" })).toBe(200);
    expect(val(s, "fons_llm_tokens_total", { model: "stub-main", purpose: "assess", direction: "output" })).toBe(100);
    expect(val(s, "fons_llm_cost_usd_total", { model: "stub-main" })).toBeCloseTo(0.02);
    expect(val(s, "fons_http_requests_total", { method: "POST", route: "/api/chat", status: "200" })).toBe(3);
    expect(val(s, "fons_corpus_records")).toBe(42);
    expect(val(s, "fons_daily_tokens_used")).toBe(300);
    expect(val(s, "fons_build_info", { pipeline: "test-1", snapshot: "snap-1" })).toBe(1);

    // histogramy: kubełki rosną, +Inf = count, suma sensowna
    const buckets = s.filter((x) => x.name === "fons_verification_duration_seconds_bucket");
    expect(buckets.length).toBeGreaterThan(5);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.value).toBeGreaterThanOrEqual(buckets[i - 1]!.value);
    const count = val(s, "fons_verification_duration_seconds_count")!;
    expect(count).toBe(2); // tylko świeże przebiegi
    expect(buckets.at(-1)!.labels.le).toBe("+Inf");
    expect(buckets.at(-1)!.value).toBe(count);
    expect(val(s, "fons_verification_step_duration_seconds_count", { step: "retrieval" })).toBe(1);
    expect(val(s, "fons_verification_step_duration_seconds_count", { step: "total" })).toBeUndefined();
    expect(val(s, "fons_http_request_duration_seconds_count", { method: "POST", route: "/api/chat" })).toBe(3);
  });

  it("nie ujawnia treści użytkownika ani tokenów w etykietach", async () => {
    const env = makeEnv();
    const token = makeApiToken(env);
    await chat(env, { text: "Sekret-obywatela-777" });
    await env.app.request("/api/report/TAJNYTOKENRAPORTU12345");
    const text = await (await env.app.request("/metrics", bearer(token))).text();
    expect(text).not.toContain("Sekret-obywatela-777");
    expect(text).not.toContain("TAJNYTOKENRAPORTU");
    expect(text).not.toContain(token);
    expect(text).toContain('route="/api/report/:token"');
  });
});

describe("rejestr metryk", () => {
  it("escapuje etykiety i wartości, nie dopuszcza duplikatów rodzin, ogranicza liczbę serii", () => {
    const r = new Registry();
    const c = r.counter("t_total", "Pomoc z \\ i\nnową linią", ["l"]);
    c.inc({ l: 'a"b\\c\nd' });
    expect(r.render()).toContain('t_total{l="a\\"b\\\\c\\nd"} 1');
    expect(r.render()).toContain("# HELP t_total Pomoc z \\\\ i\\nnową linią");
    expect(() => r.counter("t_total", "x")).toThrow();
    for (let i = 0; i < 3000; i++) c.inc({ l: `v${i}` });
    expect(r.render().split("\n").filter((l) => l.startsWith("t_total{")).length).toBeLessThanOrEqual(2000);
  });

  it("licznik ignoruje wartości ujemne; histogram ignoruje NaN", () => {
    const r = new Registry();
    const c = r.counter("c_total", "c");
    c.inc({}, -5);
    c.inc();
    const h = r.histogram("h_seconds", "h", [], [1, 2]);
    h.observe({}, Number.NaN);
    h.observe({}, 1.5);
    const out = r.render();
    expect(out).toContain("c_total 1");
    expect(out).toContain('h_seconds_bucket{le="1"} 0');
    expect(out).toContain('h_seconds_bucket{le="2"} 1');
    expect(out).toContain("h_seconds_count 1");
  });

  it("serwerowe metryki renderują się bez błędu także na pusto", () => {
    expect(() => createServerMetrics().render()).not.toThrow();
  });
});
