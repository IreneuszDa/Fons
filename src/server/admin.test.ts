import { describe, expect, it } from "vitest";
import { neutraliseCell, toCsv } from "./csv";
import { ADMIN_ENDPOINTS, ROLES, roleCan, type Role } from "./auth/permissions";
import { adminLogin, chat, loginAs, makeApiToken, makeEnv, makeReport, type TestEnv } from "./testkit";

const req = (cookie: string, method: string, body?: unknown, csrf?: string) => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const post = (cookie: string, body?: unknown, csrf?: string) => req(cookie, "POST", body ?? {}, csrf);

function seedCase(env: TestEnv, text = "Producent lodów dodaje szkło do waniliowych"): void {
  const now = env.ctx.now().toISOString();
  env.db
    .prepare(
      "INSERT INTO moderator_cases (representative_text, claim_norm, status, sender_count, channels_json, alert_state, created_at, updated_at) VALUES (?, ?, 'open', 1, '[\"web\"]', 'none', ?, ?)",
    )
    .run(text, text, now, now);
}

describe("neutralizacja CSV", () => {
  it.each(["=SUM(1+1)", "+48123456789", "-2+3", "@cmd", "\tTAB", "\rCR"])("komórka %j dostaje apostrof", (v) => {
    expect(neutraliseCell(v)).toBe(`'${v}`);
  });
  it("zwykłe komórki i liczby bez zmian; cudzysłowy podwajane", () => {
    expect(neutraliseCell("zwykły tekst")).toBe("zwykły tekst");
    expect(neutraliseCell(-5)).toBe("-5");
    expect(toCsv(["a"], [['x "y"']])).toContain('"x ""y"""');
  });
});

describe("logowanie", () => {
  it("złe hasło 401, nieznany login 401 (ten sam komunikat), dobre ustawia ciasteczko i zwraca {user, csrf}", async () => {
    const env = makeEnv();
    const bad = await env.app.request("/api/admin/login", post("", { username: "admin", password: "zle" }));
    const unknown = await env.app.request("/api/admin/login", post("", { username: "nikt", password: "zle" }));
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(((await bad.json()) as any).messagePl).toBe(((await unknown.json()) as any).messagePl);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await env.app.request("/api/admin/login", post("", { username: "admin", password: env.ctx.cfg.adminPassword }));
    expect(ok.status).toBe(200);
    const sc = ok.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/pw_admin=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    const body = (await ok.json()) as any;
    expect(body.user).toEqual({ username: "admin", role: "administrator" });
    expect(body.csrf).toMatch(/^[0-9a-f]{32}$/);
    expect(ok.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("login samym hasłem (bez username) to 400", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/admin/login", post("", { password: env.ctx.cfg.adminPassword }));
    expect(res.status).toBe(400);
  });

  it("limit prób logowania per IP", async () => {
    const env = makeEnv();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await env.app.request("/api/admin/login", post("", { username: `u${i}`, password: "zle" }))).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it("blokada per login po 10 nieudanych próbach (także z różnych IP) i zwolnienie po oknie", async () => {
    const env = makeEnv();
    const attempt = async () => {
      env.advance(20_000); // limit per IP (5/min) nie przeszkadza, okno blokady per login (10 min) trwa
      return (await env.app.request("/api/admin/login", post("", { username: "admin", password: "zle" }))).status;
    };
    for (let i = 0; i < 10; i++) expect(await attempt()).toBe(401);
    expect(await attempt()).toBe(429);
    // nawet poprawne hasło jest wtedy odrzucone
    env.advance(61_000);
    const blocked = await env.app.request("/api/admin/login", post("", { username: "admin", password: env.ctx.cfg.adminPassword }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    env.advance(11 * 60_000);
    const ok = await env.app.request("/api/admin/login", post("", { username: "admin", password: env.ctx.cfg.adminPassword }));
    expect(ok.status).toBe(200);
  });

  it("/me zwraca użytkownika i csrf; bez logowania 401; wylogowanie kończy sesję (z CSRF)", async () => {
    const env = makeEnv();
    expect((await env.app.request("/api/admin/me")).status).toBe(401);
    const { cookie, csrf } = await adminLogin(env);
    const me = (await (await env.app.request("/api/admin/me", { headers: { cookie } })).json()) as any;
    expect(me).toEqual({ user: { username: "admin", role: "administrator" }, csrf });
    expect((await env.app.request("/api/admin/logout", post(cookie))).status).toBe(403);
    expect((await env.app.request("/api/admin/logout", post(cookie, {}, csrf))).status).toBe(200);
    expect((await env.app.request("/api/admin/me", { headers: { cookie } })).status).toBe(401);
  });

  it("sesja wygasa po 8 godzinach", async () => {
    const env = makeEnv();
    const { cookie } = await adminLogin(env);
    env.advance(8 * 3_600_000 + 1000);
    expect((await env.app.request("/api/admin/me", { headers: { cookie } })).status).toBe(401);
  });

  it("usunięcie użytkownika kończy jego sesję od razu, zmiana roli działa bez ponownego logowania", async () => {
    const env = makeEnv();
    const mod = await loginAs(env, "moderator");
    expect((await env.app.request("/api/admin/cases", { headers: { cookie: mod.cookie } })).status).toBe(200);
    env.ctx.auth.users.remove("test-moderator");
    expect((await env.app.request("/api/admin/cases", { headers: { cookie: mod.cookie } })).status).toBe(401);
  });

  it("bez logowania wszystko jest 401, także z podrobionym ciasteczkiem", async () => {
    const env = makeEnv();
    for (const p of ["/api/admin/cases", "/api/admin/metrics", "/api/admin/export.csv", "/api/admin/export.json", "/api/admin/users", "/api/admin/tokens", "/api/admin/audit-log"]) {
      expect((await env.app.request(p)).status, p).toBe(401);
    }
    expect((await env.app.request("/api/admin/cases", { headers: { cookie: "pw_admin=podrobione" } })).status).toBe(401);
  });
});

describe("macierz ról", () => {
  // Zapytania próbne dla każdej trasy z ADMIN_ENDPOINTS (poza loginem).
  const probes: Record<string, (s: { cookie: string; csrf: string }) => [string, RequestInit]> = {
    "POST /logout": (s) => ["/api/admin/logout", post(s.cookie, {}, s.csrf)],
    "GET /me": (s) => ["/api/admin/me", req(s.cookie, "GET")],
    "GET /cases": (s) => ["/api/admin/cases", req(s.cookie, "GET")],
    "PATCH /cases/:id": (s) => ["/api/admin/cases/1", req(s.cookie, "PATCH", { note: "x" }, s.csrf)],
    "GET /metrics": (s) => ["/api/admin/metrics", req(s.cookie, "GET")],
    "GET /export.csv": (s) => ["/api/admin/export.csv", req(s.cookie, "GET")],
    "GET /export.json": (s) => ["/api/admin/export.json", req(s.cookie, "GET")],
    "GET /audit/verify": (s) => ["/api/admin/audit/verify", req(s.cookie, "GET")],
    "GET /audit-log": (s) => ["/api/admin/audit-log", req(s.cookie, "GET")],
    "GET /users": (s) => ["/api/admin/users", req(s.cookie, "GET")],
    "POST /users": (s) => ["/api/admin/users", post(s.cookie, { username: "nowy-uzytkownik", role: "moderator", password: "dlugie-haslo-123" }, s.csrf)],
    "DELETE /users/:username": (s) => ["/api/admin/users/nikt", req(s.cookie, "DELETE", undefined, s.csrf)],
    "GET /tokens": (s) => ["/api/admin/tokens", req(s.cookie, "GET")],
    "POST /tokens": (s) => ["/api/admin/tokens", post(s.cookie, { label: "integracja" }, s.csrf)],
    "DELETE /tokens/:id": (s) => ["/api/admin/tokens/tok_brak", req(s.cookie, "DELETE", undefined, s.csrf)],
    "POST /cache/invalidate": (s) => ["/api/admin/cache/invalidate", post(s.cookie, {}, s.csrf)],
  };

  it("każda trasa z macierzy ma zapytanie próbne i odwrotnie", () => {
    const keys = Object.keys(ADMIN_ENDPOINTS).filter((k) => k !== "POST /login");
    expect(Object.keys(probes).sort()).toEqual(keys.sort());
  });

  it("wszystkie zarejestrowane trasy /api/admin mają wpis w macierzy", () => {
    const env = makeEnv();
    const registered = env.app.routes
      .filter((r) => r.path.startsWith("/api/admin") && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace("/api/admin", "")}`);
    for (const key of registered) expect(key in ADMIN_ENDPOINTS, key).toBe(true);
  });

  for (const role of ROLES) {
    it(`rola ${role}: 200/201/404 tylko tam, gdzie macierz pozwala, wszędzie indziej 403`, async () => {
      const env = makeEnv();
      seedCase(env);
      const session = await loginAs(env, role);
      for (const [key, policy] of Object.entries(ADMIN_ENDPOINTS)) {
        if (key === "POST /login") continue;
        const [url, init] = probes[key]!(session);
        const res = await env.app.request(url, init);
        const allowed = policy === "session" || (policy !== "public" && roleCan(role as Role, policy));
        if (allowed) {
          expect([200, 201, 404], `${role} ${key} -> ${res.status}`).toContain(res.status);
        } else {
          expect(res.status, `${role} ${key}`).toBe(403);
        }
        if (key === "POST /logout") Object.assign(session, await loginAs(env, role)); // sesja została zakończona
      }
    });
  }

  it("żądanie zmieniające stan bez CSRF to 403 także dla administratora", async () => {
    const env = makeEnv();
    seedCase(env);
    const { cookie } = await adminLogin(env);
    expect((await env.app.request("/api/admin/cases/1", req(cookie, "PATCH", { status: "closed" }))).status).toBe(403);
    expect((await env.app.request("/api/admin/cases/1", req(cookie, "PATCH", { status: "closed" }, "0".repeat(32)))).status).toBe(403);
    expect((await env.app.request("/api/admin/users", post(cookie, { username: "abc", role: "moderator", password: "dlugie-haslo-123" }))).status).toBe(403);
  });

  it("niezgodny Origin przy zmianie stanu to 403", async () => {
    const env = makeEnv();
    seedCase(env);
    const { cookie, csrf } = await adminLogin(env);
    const res = await env.app.request("/api/admin/cases/1", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, origin: "https://evil.example", host: "localhost:8787" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(403);
    expect((env.db.prepare("SELECT status FROM moderator_cases WHERE id = 1").get() as any).status).toBe("open");
  });
});

describe("sprawy", () => {
  it("lista z filtrem statusu i polem note; PATCH zmienia status, notatkę i tekst (z maskowaniem PII)", async () => {
    const env = makeEnv({ engine: (r) => makeReport({ verdict: "BRAK_DOWODOW", claim: r.text }) });
    await chat(env, { text: "Producent lodów dodaje szkło do waniliowych" });
    const { cookie, csrf } = await loginAs(env, "moderator");
    const list = (await (await env.app.request("/api/admin/cases?status=open", { headers: { cookie } })).json()) as any;
    expect(list.cases).toHaveLength(1);
    expect(list.cases[0]).toMatchObject({ id: "1", status: "open", note: "", senderCount: 1 });
    expect((await env.app.request("/api/admin/cases?status=zly", { headers: { cookie } })).status).toBe(400);

    const patch = await env.app.request(
      "/api/admin/cases/1",
      req(cookie, "PATCH", { status: "forwarded", note: "Przekazano do MSZ, kontakt 12345678901", representativeText: "Szkło w lodach waniliowych" }, csrf),
    );
    expect(patch.status).toBe(200);
    const c = ((await patch.json()) as any).case;
    expect(c).toMatchObject({ status: "forwarded", representativeText: "Szkło w lodach waniliowych" });
    expect(c.note).toContain("[PESEL]");
    expect(c.note).not.toContain("12345678901");
    const fwd = (await (await env.app.request("/api/admin/cases?status=forwarded", { headers: { cookie } })).json()) as any;
    expect(fwd.cases).toHaveLength(1);
    expect(((await (await env.app.request("/api/admin/cases?status=open", { headers: { cookie } })).json()) as any).cases).toHaveLength(0);
  });

  it("PATCH: puste ciało, zły status, nieistniejąca sprawa", async () => {
    const env = makeEnv();
    seedCase(env);
    const { cookie, csrf } = await adminLogin(env);
    expect((await env.app.request("/api/admin/cases/1", req(cookie, "PATCH", {}, csrf))).status).toBe(400);
    expect((await env.app.request("/api/admin/cases/1", req(cookie, "PATCH", { status: "dismissed" }, csrf))).status).toBe(400);
    expect((await env.app.request("/api/admin/cases/99", req(cookie, "PATCH", { status: "closed" }, csrf))).status).toBe(404);
    expect((await env.app.request("/api/admin/cases/abc", req(cookie, "PATCH", { status: "closed" }, csrf))).status).toBe(400);
  });
});

describe("eksport", () => {
  it("CSV neutralizuje formuły; JSON zwraca sprawy; dataset=runs eksportuje dane techniczne bez treści", async () => {
    const env = makeEnv();
    for (const t of ["=HYPERLINK(\"http://evil\",\"x\")", "+1+1", "-1+2", "@SUM(A1)", "\tcmd", "\rcmd", "zwykły"]) seedCase(env, t);
    await chat(env, { text: "Tajne pytanie obywatela" });
    const { cookie } = await loginAs(env, "analityk");
    const res = await env.app.request("/api/admin/export.csv", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`"'+1+1"`);
    expect(csv).toContain(`"'@SUM(A1)"`);
    expect(csv).toContain(`"'\tcmd"`);
    expect(csv).toContain(`"zwykły"`);
    for (const m of csv.matchAll(/(?:^|,)"([^"]|"")*"/g)) expect(m[0].replace(/^,/, "")).not.toMatch(/^"[=+\-@\t\r]/);
    const j = (await (await env.app.request("/api/admin/export.json", { headers: { cookie } })).json()) as any;
    expect(j.cases).toHaveLength(7);
    const runs = await (await env.app.request("/api/admin/export.csv?dataset=runs", { headers: { cookie } })).text();
    expect(runs).toContain("POTWIERDZONE");
    expect(runs).not.toContain("Tajne pytanie");
    const runsJson = (await (await env.app.request("/api/admin/export.json?dataset=runs", { headers: { cookie } })).json()) as any;
    expect(runsJson.runs).toHaveLength(1);
    expect(JSON.stringify(runsJson)).not.toContain("Tajne pytanie");
  });
});

describe("metryki panelu", () => {
  it("kształt uzgodniony z panelem: totals, latency, cost, llm, retrievalErrors, window", async () => {
    const env = makeEnv({
      engine: (r, i) =>
        i === 1
          ? makeReport({ claim: r.text, unavailableBranches: ["live"], securityEvents: [{ pattern: "ignore_previous_pl", location: "user_message", severity: "high", excerpt: "x" }] })
          : i === 2
            ? makeReport({ verdict: "BRAK_DOWODOW", claim: r.text })
            : makeReport({ status: "NIEPELNE", mainVerdict: null, verdicts: [], claim: r.text }),
    });
    await chat(env, { text: "Pierwsze" });
    await chat(env, { text: "Drugie" });
    await chat(env, { text: "Trzecie" });
    await chat(env, { text: "Pierwsze" }); // trafienie w cache
    const { cookie } = await loginAs(env, "analityk");
    const m = (await (await env.app.request("/api/admin/metrics", { headers: { cookie } })).json()) as any;
    expect(m.totals).toMatchObject({
      verifications: 4,
      byStatus: { OK: 3, NIEPELNE: 1 },
      byVerdict: { POTWIERDZONE: 2, BRAK_DOWODOW: 1 },
      abstentions: 1,
      cacheHits: 1,
    });
    expect(m.totals.injectionEvents).toBeGreaterThanOrEqual(1);
    expect(m.latency).toMatchObject({ count: 3 });
    expect(m.latency).toHaveProperty("p50");
    expect(m.latency).toHaveProperty("p95");
    expect(m.latency.byStep.total).toMatchObject({ count: 3 });
    expect(m.cost.totalUsd).toBeCloseTo(0.03);
    expect(m.cost.per100Usd).toBeCloseTo(1); // 0,03 USD / 3 świeże przebiegi * 100
    expect(m.cost.byModel["stub/stub-main"]).toMatchObject({ calls: 3 });
    expect(m.llm).toMatchObject({ calls: 3, tokensIn: 300, tokensOut: 150 });
    expect(m.llm.byPurpose.assess).toMatchObject({ calls: 3 });
    expect(m.retrievalErrors.byBranch).toEqual({ live: 1 });
    expect(m.window.to).toBeTruthy();
    expect(m.cases).toMatchObject({ open: 1 });
    expect(m.tokens.today).toBe(450);
  });

  it("zakres dat: from/to filtrują przebiegi; zły format to 400", async () => {
    const env = makeEnv();
    await chat(env, { text: "Pierwsze" });
    env.advance(2 * 86_400_000);
    await chat(env, { text: "Drugie" });
    const { cookie } = await loginAs(env, "analityk");
    const all = (await (await env.app.request("/api/admin/metrics", { headers: { cookie } })).json()) as any;
    expect(all.totals.verifications).toBe(2);
    const late = (await (await env.app.request("/api/admin/metrics?from=2026-11-22", { headers: { cookie } })).json()) as any;
    expect(late.totals.verifications).toBe(1);
    expect((await env.app.request("/api/admin/metrics?from=wczoraj", { headers: { cookie } })).status).toBe(400);
  });
});

describe("użytkownicy", () => {
  it("administrator tworzy i usuwa użytkowników; nowy użytkownik loguje się swoją rolą", async () => {
    const env = makeEnv();
    const { cookie, csrf } = await adminLogin(env);
    const created = await env.app.request("/api/admin/users", post(cookie, { username: "Anna.K", role: "moderator", password: "dlugie-haslo-123" }, csrf));
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).user).toMatchObject({ username: "anna.k", role: "moderator" });
    const list = (await (await env.app.request("/api/admin/users", { headers: { cookie } })).json()) as any;
    expect(list.users.map((u: any) => u.username)).toEqual(["admin", "anna.k"]);
    expect(JSON.stringify(list)).not.toMatch(/scrypt|passwordHash/);
    env.advance(61_000);
    const anna = await adminLogin(env, { username: "anna.k", password: "dlugie-haslo-123" });
    expect(anna.user.role).toBe("moderator");
    expect((await env.app.request("/api/admin/users/anna.k", req(cookie, "DELETE", undefined, csrf))).status).toBe(200);
    expect((await env.app.request("/api/admin/cases", { headers: { cookie: anna.cookie } })).status).toBe(401);
  });

  it("walidacja: duplikat 409, słabe hasło 400, zła nazwa 400, zła rola 400; nie można usunąć siebie ani ostatniego administratora", async () => {
    const env = makeEnv();
    const { cookie, csrf } = await adminLogin(env);
    const add = (body: unknown) => env.app.request("/api/admin/users", post(cookie, body, csrf));
    expect((await add({ username: "admin", role: "moderator", password: "dlugie-haslo-123" })).status).toBe(409);
    expect((await add({ username: "ktos", role: "moderator", password: "krotkie" })).status).toBe(400);
    expect((await add({ username: "Ź!", role: "moderator", password: "dlugie-haslo-123" })).status).toBe(400);
    expect((await add({ username: "ktos", role: "szef", password: "dlugie-haslo-123" })).status).toBe(400);
    expect((await env.app.request("/api/admin/users/admin", req(cookie, "DELETE", undefined, csrf))).status).toBe(409);
    expect((await env.app.request("/api/admin/users/nikt", req(cookie, "DELETE", undefined, csrf))).status).toBe(404);
    await add({ username: "admin2", role: "administrator", password: "dlugie-haslo-123" });
    env.advance(61_000);
    const a2 = await adminLogin(env, { username: "admin2", password: "dlugie-haslo-123" });
    // admin2 może usunąć admina (jest drugi administrator), ale ostatniego już nie
    expect((await env.app.request("/api/admin/users/admin", req(a2.cookie, "DELETE", undefined, a2.csrf))).status).toBe(200);
    expect((await env.app.request("/api/admin/users/admin2", req(a2.cookie, "DELETE", undefined, a2.csrf))).status).toBe(409);
  });
});

describe("tokeny API", () => {
  it("utworzenie (token raz), użycie jako Bearer do odczytu, odwołanie", async () => {
    const env = makeEnv();
    const { cookie, csrf } = await loginAs(env, "analityk");
    const res = await env.app.request("/api/admin/tokens", post(cookie, { label: "Grafana" }, csrf));
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created.token).toMatch(/^fons_[A-Za-z0-9_-]{43}$/);
    expect(created.id).toMatch(/^tok_/);

    const list = (await (await env.app.request("/api/admin/tokens", { headers: { cookie } })).json()) as any;
    expect(list.tokens[0]).toMatchObject({ id: created.id, label: "Grafana", role: "analityk", lastUsedAt: null });
    expect(JSON.stringify(list)).not.toContain(created.token);
    // w bazie jest tylko skrót
    const stored = env.db.prepare("SELECT token_hash FROM api_tokens").all() as { token_hash: string }[];
    expect(stored[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const bearer = { headers: { authorization: `Bearer ${created.token}` } };
    expect((await env.app.request("/api/admin/metrics", bearer)).status).toBe(200);
    expect((await env.app.request("/api/admin/cases", bearer)).status).toBe(200);
    const after = (await (await env.app.request("/api/admin/tokens", { headers: { cookie } })).json()) as any;
    expect(after.tokens[0].lastUsedAt).toBeTruthy();

    expect((await env.app.request(`/api/admin/tokens/${created.id}`, req(cookie, "DELETE", undefined, csrf))).status).toBe(200);
    expect((await env.app.request("/api/admin/metrics", bearer)).status).toBe(401);
    expect((await env.app.request(`/api/admin/tokens/${created.id}`, req(cookie, "DELETE", undefined, csrf))).status).toBe(404);
  });

  it("token API jest tylko do odczytu: nie tworzy tokenów, nie zarządza użytkownikami, nie zmienia spraw", async () => {
    const env = makeEnv();
    seedCase(env);
    const token = makeApiToken(env);
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await env.app.request("/api/admin/tokens", { headers: h })).status).toBe(403);
    expect((await env.app.request("/api/admin/tokens", { method: "POST", headers: h, body: JSON.stringify({ label: "x" }) })).status).toBe(403);
    expect((await env.app.request("/api/admin/users", { headers: h })).status).toBe(403);
    expect((await env.app.request("/api/admin/cases/1", { method: "PATCH", headers: h, body: JSON.stringify({ status: "closed" }) })).status).toBe(403);
    expect((await env.app.request("/api/admin/cache/invalidate", { method: "POST", headers: h, body: "{}" })).status).toBe(403);
    expect((await env.app.request("/api/admin/me", { headers: h })).status).toBe(403);
    expect((await env.app.request("/api/admin/cases", { headers: { authorization: "Bearer fons_zly" } })).status).toBe(401);
    expect((await env.app.request("/api/admin/cases", { headers: { authorization: "Basic abc" } })).status).toBe(401);
  });

  it("walidacja etykiety i limit liczby tokenów", async () => {
    const env = makeEnv();
    const { cookie, csrf } = await adminLogin(env);
    expect((await env.app.request("/api/admin/tokens", post(cookie, { label: "" }, csrf))).status).toBe(400);
    for (let i = 0; i < 50; i++) makeApiToken(env, `t${i}`);
    expect((await env.app.request("/api/admin/tokens", post(cookie, { label: "ponad limit" }, csrf))).status).toBe(409);
  });
});

describe("cache i dziennik administratora", () => {
  it("unieważnienie cache: wymaga CSRF; bez klucza czyści wszystko; z kluczem tylko wpis", async () => {
    const env = makeEnv();
    await chat(env, { text: "Pytanie jeden" });
    await chat(env, { text: "Pytanie dwa" });
    const { cookie, csrf } = await adminLogin(env);
    expect((await env.app.request("/api/admin/cache/invalidate", post(cookie, {}))).status).toBe(403);
    const key = (env.db.prepare("SELECT cache_key FROM computation_cache LIMIT 1").get() as any).cache_key as string;
    const one = await env.app.request("/api/admin/cache/invalidate", post(cookie, { key }, csrf));
    expect(((await one.json()) as any).removed).toBe(1);
    const all = await env.app.request("/api/admin/cache/invalidate", post(cookie, {}, csrf));
    expect(((await all.json()) as any).removed).toBe(1);
  });

  it("działania trafiają do dziennika (kto, rola, akcja, cel) i łańcuch się weryfikuje", async () => {
    const env = makeEnv();
    seedCase(env);
    const { cookie, csrf } = await adminLogin(env);
    await env.app.request("/api/admin/cases/1", req(cookie, "PATCH", { status: "closed", note: "tajna notatka" }, csrf));
    await env.app.request("/api/admin/users", post(cookie, { username: "ktos", role: "analityk", password: "dlugie-haslo-123" }, csrf));
    await env.app.request("/api/admin/export.csv", { headers: { cookie } });
    const log = (await (await env.app.request("/api/admin/audit-log", { headers: { cookie } })).json()) as any;
    const actions = log.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["login.success", "case.update", "user.create", "export.csv"]));
    const upd = log.entries.find((e: any) => e.action === "case.update");
    expect(upd).toMatchObject({ actor: "admin", role: "administrator", target: "#1" });
    expect(JSON.stringify(log)).not.toContain("tajna notatka");
    expect(log.verify.ok).toBe(true);
    const v = (await (await env.app.request("/api/admin/audit/verify", { headers: { cookie } })).json()) as any;
    expect(v).toMatchObject({ ok: true, adminLog: { ok: true } });
  });

  it("nieudane logowanie jest w dzienniku; login nieistniejącego konta nie jest zapisywany", async () => {
    const env = makeEnv();
    await env.app.request("/api/admin/login", post("", { username: "admin", password: "zle" }));
    await env.app.request("/api/admin/login", post("", { username: "haslo-wpisane-w-login", password: "zle" }));
    const rows = env.db.prepare("SELECT actor, action FROM admin_audit WHERE action = 'login.failed'").all() as any[];
    expect(rows).toEqual([
      { actor: "admin", action: "login.failed" },
      { actor: "-", action: "login.failed" },
    ]);
  });
});
