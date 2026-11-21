/**
 * Panel administratora: logowanie (login + hasło, role), sprawy, metryki, eksport, użytkownicy,
 * tokeny API, unieważnianie cache, weryfikacja łańcuchów audytu.
 *
 * Każda trasa po /login przechodzi przez `register()`, który wymaga wpisu w ADMIN_ENDPOINTS
 * (src/server/auth/permissions.ts) i nakłada `guard()`: uprawnienie roli, CSRF i Origin dla sesji,
 * tylko odczyt dla tokenów API.
 */
import { randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { verifyChain } from "./audit";
import { tokensUsedToday } from "./budget";
import { invalidateCache } from "./cache";
import type { ServerContext } from "./context";
import { toCsv } from "./csv";
import { clientIp } from "./http";
import {
  ADMIN_ENDPOINTS,
  ROLES,
  roleCan,
  tokenCan,
  type AdminEndpointKey,
  type Permission,
} from "./auth/permissions";
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, actorName, authenticateRequest, type Principal } from "./auth/principal";
import { TokenLimitError } from "./auth/tokens";
import { UserError } from "./auth/users";
import { dayKey, percentile, safeEqual } from "./util";

type Env = { Variables: { principal: Principal } };
type Ctx = Context<Env>;
type Status = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 429;

const CASE_STATUSES = ["open", "closed", "forwarded"] as const;

function fail(c: Context, status: Exclude<Status, 200 | 201>, error: string, messagePl: string) {
  return c.json({ error, messagePl }, status);
}

// ───────────────────────────── sprawy ─────────────────────────────

interface CaseOut {
  id: string;
  representativeText: string;
  status: string;
  senderCount: number;
  channels: string[];
  alertState: string;
  createdAt: string;
  updatedAt: string;
  note: string;
}

interface CaseRow {
  id: number;
  representative_text: string;
  status: string;
  sender_count: number;
  channels_json: string;
  alert_state: string;
  created_at: string;
  updated_at: string;
  note: string;
}

const toCase = (r: CaseRow): CaseOut => ({
  id: String(r.id),
  representativeText: r.representative_text,
  status: r.status,
  senderCount: r.sender_count,
  channels: JSON.parse(r.channels_json) as string[],
  alertState: r.alert_state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  note: r.note ?? "",
});

function listCases(ctx: ServerContext, status?: string, limit = 500): CaseOut[] {
  const rows = (
    status
      ? ctx.db.prepare("SELECT * FROM moderator_cases WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : ctx.db.prepare("SELECT * FROM moderator_cases ORDER BY updated_at DESC LIMIT ?").all(limit)
  ) as CaseRow[];
  return rows.map(toCase);
}

// ───────────────────────────── metryki panelu ─────────────────────────────

interface RunMetricRow {
  created_at: string;
  status: string;
  verdict: string | null;
  models_json: string;
  timings_json: string;
  cost_usd: number;
  latency_ms: number;
  cache_hit: number;
  unavailable_json: string;
  security_event_count: number;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), count: s.length };
};

export interface MetricsWindow {
  from?: string;
  to?: string;
}

/** Zestawienie z tabeli runs (trwałe, w granicach retencji). Latencje p50/p95 dotyczą przebiegów bez cache. */
export function computeMetrics(ctx: ServerContext, win: MetricsWindow = {}) {
  const conds: string[] = [];
  const args: string[] = [];
  if (win.from) (conds.push("created_at >= ?"), args.push(win.from));
  if (win.to) (conds.push("created_at <= ?"), args.push(win.to));
  const rows = ctx.db
    .prepare(
      `SELECT created_at, status, verdict, models_json, timings_json, cost_usd, latency_ms, cache_hit,
              unavailable_json, security_event_count FROM runs${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY seq ASC`,
    )
    .all(...args) as RunMetricRow[];

  const byStatus: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  const fresh: number[] = [];
  const all: number[] = [];
  const stepValues: Record<string, number[]> = {};
  const byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }> = {};
  const byPurpose: Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }> = {};
  const byBranch: Record<string, number> = {};
  let cost = 0;
  let cacheHits = 0;
  let injection = 0;
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const r of rows) {
    bump(byStatus, r.status);
    if (r.verdict) bump(byVerdict, r.verdict);
    all.push(r.latency_ms);
    if (!r.cache_hit) {
      fresh.push(r.latency_ms);
      for (const [step, ms] of Object.entries(safeJson<Record<string, number>>(r.timings_json, {}))) {
        if (typeof ms === "number") (stepValues[step] ??= []).push(ms);
      }
    }
    cost += r.cost_usd;
    cacheHits += r.cache_hit;
    injection += r.security_event_count;
    for (const m of safeJson<{ provider: string; model: string; purpose?: string; inputTokens: number; outputTokens: number; costUsd: number }[]>(r.models_json, [])) {
      calls++;
      tokensIn += m.inputTokens;
      tokensOut += m.outputTokens;
      for (const [map, key] of [[byModel, `${m.provider}/${m.model}`], [byPurpose, m.purpose ?? "unknown"]] as const) {
        const e = (map[key] ??= { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
        e.calls++;
        e.tokensIn += m.inputTokens;
        e.tokensOut += m.outputTokens;
        e.costUsd += m.costUsd;
      }
    }
    for (const b of safeJson<string[]>(r.unavailable_json, [])) bump(byBranch, b);
  }

  const abstentions = byVerdict["BRAK_DOWODOW"] ?? 0;
  const byStep = Object.fromEntries(Object.entries(stepValues).map(([k, v]) => [k, stat(v)]));
  const freshStat = stat(fresh);
  const day = dayKey(ctx.now());

  const secByPattern = ctx.db.prepare("SELECT pattern, COUNT(*) AS n FROM security_events GROUP BY pattern ORDER BY n DESC").all() as { pattern: string; n: number }[];
  const alertRows = ctx.db.prepare("SELECT outcome, COUNT(*) AS n FROM alerts_log GROUP BY outcome").all() as { outcome: string; n: number }[];
  const alertsToday = ctx.db.prepare("SELECT outcome, COUNT(*) AS n FROM alerts_log WHERE day = ? GROUP BY outcome").all(day) as { outcome: string; n: number }[];
  const caseCounts = ctx.db.prepare("SELECT status, COUNT(*) AS n FROM moderator_cases GROUP BY status").all() as { status: string; n: number }[];

  return {
    generatedAt: ctx.now().toISOString(),
    totals: {
      verifications: rows.length,
      byStatus,
      byVerdict,
      abstentions,
      abstentionRate: rows.length ? abstentions / rows.length : 0,
      cacheHits,
      injectionEvents: injection,
    },
    latency: {
      p50: freshStat.p50,
      p95: freshStat.p95,
      count: freshStat.count,
      byStep,
      all: stat(all),
    },
    cost: {
      totalUsd: cost,
      per100Usd: fresh.length ? (cost / fresh.length) * 100 : 0,
      byModel,
    },
    llm: { calls, tokensIn, tokensOut, byPurpose },
    retrievalErrors: { total: Object.values(byBranch).reduce((a, b) => a + b, 0), byBranch },
    window: { from: win.from ?? rows[0]?.created_at ?? null, to: win.to ?? ctx.now().toISOString() },
    // dodatki ponad uzgodniony kształt (panel może je pominąć)
    securityByPattern: Object.fromEntries(secByPattern.map((r) => [r.pattern, r.n])),
    cases: Object.fromEntries(caseCounts.map((r) => [r.status, r.n])),
    alerts: {
      total: Object.fromEntries(alertRows.map((r) => [r.outcome, r.n])),
      today: Object.fromEntries(alertsToday.map((r) => [r.outcome, r.n])),
      dailyCap: ctx.options.dailyAlertCap,
    },
    tokens: { today: tokensUsedToday(ctx.db, ctx.now()), dailyBudget: ctx.cfg.dailyTokenBudget },
  };
}

// ───────────────────────────── trasy ─────────────────────────────

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(512) });
const CasePatch = z
  .object({
    status: z.enum(CASE_STATUSES).optional(),
    note: z.string().max(2000).optional(),
    representativeText: z.string().trim().min(3).max(1000).optional(),
  })
  .refine((v) => v.status !== undefined || v.note !== undefined || v.representativeText !== undefined, "empty");
const UserBody = z.object({ username: z.string().max(64), role: z.enum(ROLES), password: z.string().max(512) });
const TokenBody = z.object({ label: z.string().trim().min(1).max(80) });
const CacheBody = z.object({ key: z.string().min(1).max(128).optional(), all: z.boolean().optional() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/).refine((s) => !Number.isNaN(Date.parse(s)));

export function createAdminRoutes(ctx: ServerContext): Hono<Env> {
  const admin = new Hono<Env>();
  const secure = ctx.cfg.env === "production" && ctx.cfg.publicBaseUrl.startsWith("https://");
  const audit = (c: Ctx, action: string, target?: string, detail?: string): void => {
    const p = c.get("principal");
    ctx.auth.adminLog.append({ actor: actorName(p), role: p.role, action, target, detail });
  };

  // ── logowanie (jedyna trasa bez uwierzytelnienia) ──
  admin.post("/login", async (c) => {
    if (!ctx.limiters.adminLogin.check(`login:${clientIp(c, ctx)}`)) {
      c.header("Retry-After", "60");
      return fail(c, 429, "rate_limited", "Zbyt wiele prób logowania. Spróbuj za minutę.");
    }
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "Podaj nazwę użytkownika i hasło.");
    const { username, password } = parsed.data;
    const key = username.trim().toLowerCase();
    const wait = ctx.auth.loginThrottle.blockedFor(key);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return fail(c, 429, "rate_limited", "Zbyt wiele nieudanych prób dla tego konta. Spróbuj później.");
    }
    const user = await ctx.auth.users.authenticate(username, password);
    if (!user) {
      ctx.auth.loginThrottle.fail(key);
      // Do dziennika trafia login tylko istniejącego konta (w polu loginu bywa wpisane hasło).
      const known = ctx.auth.users.get(key);
      ctx.auth.adminLog.append({ actor: known ? known.username : "-", role: known?.role ?? "-", action: "login.failed", target: known ? known.username : "" });
      return fail(c, 401, "unauthorized", "Nieprawidłowa nazwa użytkownika lub hasło.");
    }
    ctx.auth.loginThrottle.success(key);
    // nowa sesja przy każdym logowaniu; poprzednia z tego przeglądarki wygasa
    const old = getCookie(c, ADMIN_COOKIE);
    if (old) ctx.adminSessions.delete(old);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(16).toString("hex");
    const nowMs = ctx.now().getTime();
    for (const [k, s] of ctx.adminSessions) if (s.expiresAt <= nowMs) ctx.adminSessions.delete(k);
    ctx.adminSessions.set(token, { username: user.username, csrf, expiresAt: nowMs + ADMIN_SESSION_TTL_MS });
    setCookie(c, ADMIN_COOKIE, token, { httpOnly: true, sameSite: "Strict", secure, path: "/api/admin", maxAge: ADMIN_SESSION_TTL_MS / 1000 });
    ctx.auth.adminLog.append({ actor: user.username, role: user.role, action: "login.success", target: user.username });
    return c.json({ user: { username: user.username, role: user.role }, csrf });
  });

  // ── wszystko poniżej wymaga uwierzytelnienia (domyślnie odmowa) ──
  admin.use("*", async (c, next) => {
    const principal = authenticateRequest(ctx, c);
    if (!principal) {
      const had = getCookie(c, ADMIN_COOKIE);
      if (had) deleteCookie(c, ADMIN_COOKIE, { path: "/api/admin" });
      return fail(c, 401, "unauthorized", "Zaloguj się do panelu.");
    }
    c.set("principal", principal);
    return next();
  });

  function guard(key: AdminEndpointKey): MiddlewareHandler<Env> {
    const policy = ADMIN_ENDPOINTS[key];
    return async (c, next) => {
      const p = c.get("principal");
      const method = c.req.method;
      const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";

      if (p.kind === "token") {
        if (policy === "session") return fail(c, 403, "forbidden", "Ta czynność wymaga zalogowania w panelu.");
        if (!safe) return fail(c, 403, "forbidden", "Token API jest tylko do odczytu.");
        if (policy !== "public" && !tokenCan(policy as Permission)) return fail(c, 403, "forbidden", "Brak uprawnień.");
        return next();
      }

      if (policy !== "session" && policy !== "public" && !roleCan(p.role, policy)) {
        return fail(c, 403, "forbidden", "Brak uprawnień do tej czynności.");
      }
      if (!safe) {
        const origin = c.req.header("origin");
        if (origin) {
          const host = c.req.header("host");
          let ok = false;
          try {
            ok = !!host && new URL(origin).host === host;
          } catch {
            ok = false;
          }
          if (!ok) return fail(c, 403, "forbidden", "Niedozwolone źródło żądania.");
        }
        const header = c.req.header("x-csrf-token");
        if (!header || !p.csrf || !safeEqual(header, p.csrf)) return fail(c, 403, "csrf", "Brak lub nieprawidłowy token CSRF.");
      }
      return next();
    };
  }

  type Handler = (c: Ctx) => Response | Promise<Response>;
  function register(method: "get" | "post" | "patch" | "delete", path: string, handler: Handler): void {
    const key = `${method.toUpperCase()} ${path}` as AdminEndpointKey;
    if (!(key in ADMIN_ENDPOINTS)) throw new Error(`admin route without policy: ${key}`);
    admin.on(method.toUpperCase(), path, guard(key), handler);
  }

  register("get", "/me", (c) => {
    const p = c.get("principal");
    return c.json({ user: { username: p.username, role: p.role }, csrf: p.csrf });
  });

  register("post", "/logout", (c) => {
    const token = getCookie(c, ADMIN_COOKIE);
    if (token) ctx.adminSessions.delete(token);
    deleteCookie(c, ADMIN_COOKIE, { path: "/api/admin" });
    audit(c, "logout");
    return c.json({ ok: true });
  });

  // ── sprawy ──
  register("get", "/cases", (c) => {
    const status = c.req.query("status");
    if (status && !(CASE_STATUSES as readonly string[]).includes(status)) {
      return fail(c, 400, "bad_request", "Nieznany status sprawy.");
    }
    return c.json({ cases: listCases(ctx, status) });
  });

  register("patch", "/cases/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = CasePatch.safeParse(await c.req.json().catch(() => null));
    if (!Number.isInteger(id) || id < 1 || !parsed.success) return fail(c, 400, "bad_request", "Nieprawidłowe dane.");
    const cur = ctx.db.prepare("SELECT * FROM moderator_cases WHERE id = ?").get(id) as CaseRow | undefined;
    if (!cur) return fail(c, 404, "not_found", "Nie ma takiej sprawy.");
    const v = parsed.data;
    // Notatka i tekst są maskowane tak jak wszystko, co zapisujemy z wejścia ludzi.
    const next = {
      status: v.status ?? cur.status,
      note: v.note !== undefined ? ctx.security.maskPii(v.note).text : cur.note,
      text: v.representativeText !== undefined ? ctx.security.maskPii(v.representativeText).text : cur.representative_text,
    };
    ctx.db
      .prepare("UPDATE moderator_cases SET status = ?, note = ?, representative_text = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.note, next.text, ctx.now().toISOString(), id);
    const fields = [v.status !== undefined && `status:${cur.status}->${v.status}`, v.note !== undefined && "note", v.representativeText !== undefined && "text"].filter(Boolean).join(",");
    audit(c, "case.update", `#${id}`, fields);
    const row = ctx.db.prepare("SELECT * FROM moderator_cases WHERE id = ?").get(id) as CaseRow;
    return c.json({ ok: true, case: toCase(row) });
  });

  // ── metryki i eksport ──
  register("get", "/metrics", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if ((from && !IsoDate.safeParse(from).success) || (to && !IsoDate.safeParse(to).success)) {
      return fail(c, 400, "bad_request", "Nieprawidłowy zakres dat.");
    }
    return c.json(computeMetrics(ctx, { from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined }));
  });

  const runsDataset = (): { headers: string[]; rows: unknown[][] } => {
    // Bez treści wejścia, nadawcy i sesji: tylko dane techniczne.
    const rows = ctx.db
      .prepare(
        `SELECT seq, created_at, channel, input_kind, status, verdict, cache_hit, latency_ms, cost_usd,
                security_event_count, unavailable_json, pipeline_version, snapshot_id FROM runs ORDER BY seq ASC`,
      )
      .all() as Record<string, unknown>[];
    const headers = ["seq", "utworzono", "kanal", "rodzaj_wejscia", "status", "werdykt", "cache", "opoznienie_ms", "koszt_usd", "zdarzenia_bezpieczenstwa", "niedostepne_galezie", "wersja_potoku", "migawka"];
    return {
      headers,
      rows: rows.map((r) => [r.seq, r.created_at, r.channel, r.input_kind, r.status, r.verdict, r.cache_hit, r.latency_ms, r.cost_usd, r.security_event_count, safeJson<string[]>(String(r.unavailable_json), []).join(";"), r.pipeline_version, r.snapshot_id]),
    };
  };

  register("get", "/export.json", (c) => {
    const dataset = c.req.query("dataset") === "runs" ? "runs" : "cases";
    audit(c, "export.json", dataset);
    c.header("Content-Disposition", `attachment; filename="${dataset === "runs" ? "przebiegi" : "sprawy"}.json"`);
    if (dataset === "runs") {
      const d = runsDataset();
      return c.json({ exportedAt: ctx.now().toISOString(), runs: d.rows.map((r) => Object.fromEntries(d.headers.map((h, i) => [h, r[i]]))) });
    }
    return c.json({ exportedAt: ctx.now().toISOString(), cases: listCases(ctx) });
  });

  register("get", "/export.csv", (c) => {
    const dataset = c.req.query("dataset") === "runs" ? "runs" : "cases";
    audit(c, "export.csv", dataset);
    let body: string;
    if (dataset === "runs") {
      const d = runsDataset();
      body = toCsv(d.headers, d.rows);
    } else {
      body = toCsv(
        ["id", "tekst", "status", "unikalni_nadawcy", "kanaly", "alert", "utworzono", "zaktualizowano", "notatka"],
        listCases(ctx).map((x) => [x.id, x.representativeText, x.status, x.senderCount, x.channels.join(";"), x.alertState, x.createdAt, x.updatedAt, x.note]),
      );
    }
    return new Response(body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${dataset === "runs" ? "przebiegi" : "sprawy"}.csv"` },
    });
  });

  // ── audyt ──
  register("get", "/audit/verify", (c) => {
    // Pola ok/checked/brokenSeq dotyczą dziennika przebiegów (zgodnie z wcześniejszym kształtem); adminLog osobno.
    const runs = verifyChain(ctx.db);
    const adminLog = ctx.auth.adminLog.verify();
    return c.json({ ...runs, ok: runs.ok && adminLog.ok, adminLog });
  });
  register("get", "/audit-log", (c) => {
    const limit = Number(c.req.query("limit") ?? 200);
    return c.json({ entries: ctx.auth.adminLog.list(Number.isFinite(limit) ? limit : 200), verify: ctx.auth.adminLog.verify() });
  });

  // ── użytkownicy ──
  register("get", "/users", (c) => c.json({ users: ctx.auth.users.list() }));

  register("post", "/users", async (c) => {
    const parsed = UserBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "Podaj nazwę użytkownika, rolę i hasło.");
    try {
      const user = await ctx.auth.users.add(parsed.data);
      audit(c, "user.create", user.username, `role:${user.role}`);
      return c.json({ user: { username: user.username, role: user.role, createdAt: user.createdAt } }, 201);
    } catch (e) {
      if (e instanceof UserError) return fail(c, e.code === "exists" ? 409 : 400, e.code, e.message);
      throw e;
    }
  });

  register("delete", "/users/:username", (c) => {
    const username = (c.req.param("username") ?? "").toLowerCase();
    if (username === c.get("principal").username) return fail(c, 409, "self", "Nie możesz usunąć własnego konta.");
    try {
      const removed = ctx.auth.users.remove(username);
      for (const [k, s] of ctx.adminSessions) if (s.username === removed.username) ctx.adminSessions.delete(k);
      audit(c, "user.delete", removed.username, `role:${removed.role}`);
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof UserError) return fail(c, e.code === "not_found" ? 404 : 409, e.code, e.message);
      throw e;
    }
  });

  // ── tokeny API ──
  register("get", "/tokens", (c) => c.json({ tokens: ctx.auth.tokens.list() }));

  register("post", "/tokens", async (c) => {
    const parsed = TokenBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "Podaj etykietę tokenu (do 80 znaków).");
    try {
      const { info, token } = ctx.auth.tokens.create({ label: parsed.data.label, createdBy: actorName(c.get("principal")) });
      audit(c, "token.create", info.id);
      c.header("Cache-Control", "no-store");
      return c.json({ id: info.id, token, label: info.label, role: info.role, createdAt: info.createdAt }, 201);
    } catch (e) {
      if (e instanceof TokenLimitError) return fail(c, 409, "token_limit", "Osiągnięto limit tokenów. Usuń nieużywane.");
      throw e;
    }
  });

  register("delete", "/tokens/:id", (c) => {
    // Analityk odwołuje tylko własne tokeny; cudze (np. administratora) — tylko rola z users:manage (SEC-12).
    const p = c.get("principal");
    const id = c.req.param("id") ?? "";
    const target = ctx.auth.tokens.list().find((t) => t.id === id);
    if (target && !roleCan(p.role, "users:manage") && target.createdBy !== actorName(p)) {
      return fail(c, 403, "forbidden", "Możesz odwołać tylko tokeny utworzone przez siebie.");
    }
    const removed = ctx.auth.tokens.revoke(id);
    if (!removed) return fail(c, 404, "not_found", "Nie ma takiego tokenu.");
    audit(c, "token.revoke", removed.id);
    return c.json({ ok: true });
  });

  // ── cache ──
  register("post", "/cache/invalidate", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CacheBody.safeParse(raw ?? {});
    if (!parsed.success) return fail(c, 400, "bad_request", "Nieprawidłowe dane.");
    // bez klucza: czyścimy cały cache obliczeń (można go odtworzyć, kosztuje tylko ponowne obliczenia)
    const removed = invalidateCache(ctx.db, parsed.data.key ? { key: parsed.data.key } : { all: true });
    audit(c, "cache.invalidate", parsed.data.key ? parsed.data.key.slice(0, 16) : "all", `removed:${removed}`);
    return c.json({ ok: true, removed });
  });

  return admin;
}
