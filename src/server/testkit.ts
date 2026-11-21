/** Pomocniki testowe serwera: atrapy silnika i modułu bezpieczeństwa, kontekst w pamięci, żądania HTTP. */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Hono } from "hono";
import type { ModelUsage, VerdictReport, Verdict } from "../shared/contracts";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { createServerContext, type EngineRequest, type ServerContext, type SecurityPorts } from "./context";
import { migrate } from "./db";
import { loadHighRiskTopics } from "./moderator/topics";
import type { Role } from "./auth/permissions";
import { createLogger } from "./observability/logger";

export const chatModelUsage: ModelUsage = {
  purpose: "router", provider: "stub", model: "chat", inputTokens: 25, outputTokens: 5, latencyMs: 0, costUsd: 0,
};

export function makeTestConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    env: "test",
    port: 0,
    publicBaseUrl: "http://localhost:8787",
    dbPath: ":memory:",
    llmProvider: "anthropic",
    modelMain: "stub-main",
    modelFast: "stub-fast",
    adminPassword: "test-admin-password",
    adminPasswordGenerated: false,
    userIdPepper: "test-pepper",
    dailyTokenBudget: 1_000_000,
    rateLimitPerMinute: 100,
    liveSearch: false,
    verdictMode: "rules",
    ...over,
  };
}

export function makeStubSecurity(clock: () => number = Date.now): SecurityPorts {
  return {
    maskPii(text) {
      let masked = false;
      const out = text.replace(/\b\d{11}\b/g, () => ((masked = true), "[PESEL]")).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => ((masked = true), "[EMAIL]"));
      return { text: out, masked, kinds: masked ? ["PII"] : [] };
    },
    resolveRelativeDates(text, receivedAt) {
      const d = new Date(receivedAt.getTime());
      return text.replace(/wczoraj/gi, () => {
        const y = new Date(d.getTime() - 86_400_000);
        return y.toISOString().slice(0, 10);
      });
    },
    pseudonymize: (raw) => createHash("sha256").update(`pepper|${raw}`).digest("hex").slice(0, 32),
    createRateLimiter({ perMinute }) {
      const hits = new Map<string, number[]>();
      return {
        check(key) {
          const t = clock();
          const list = (hits.get(key) ?? []).filter((x) => x > t - 60_000);
          if (list.length >= perMinute) {
            hits.set(key, list);
            return false;
          }
          list.push(t);
          hits.set(key, list);
          return true;
        },
      };
    },
  };
}

export function makeReport(over: Partial<VerdictReport> & { verdict?: Verdict; claim?: string } = {}): VerdictReport {
  const verdict = over.verdict ?? "POTWIERDZONE";
  const claim = over.claim ?? "Przykładowe twierdzenie testowe";
  const base: VerdictReport = {
    inputMode: "claim",
    id: "engine-id",
    token: "engine-token-placeholder",
    createdAt: "2026-11-21T10:00:00.000Z",
    pipelineVersion: "test-1",
    corpusSnapshot: "snap-1",
    verdictMode: "rules",
    status: "OK",
    inputKind: "text",
    inputEchoMasked: claim,
    claims: [{ id: "c1", text: claim, type: "fakt", isMain: true, temporal: { kind: "brak" }, inputOverlap: 1 }],
    verdicts: [
      {
        claimId: "c1",
        verdict,
        ruleApplied: verdict === "BRAK_DOWODOW" ? 2 : 7,
        strength: { level: "srednia", primarySources: 1, independentPublishers: 1, newestEvidenceAt: null, archivalWarning: false, verifierAgreement: "zgoda", notes: [] },
        reasonPl: "Uzasadnienie z szablonu.",
        triedPl: verdict === "BRAK_DOWODOW" ? "Szukano w aktach prawnych i fact-checkach." : undefined,
        evidence:
          verdict === "BRAK_DOWODOW"
            ? []
            : [
                {
                  recordId: "eli:abc",
                  title: "Ustawa testowa",
                  publisher: "Sejm RP",
                  publishedAt: "2025-01-01",
                  fetchedAt: "2026-11-01",
                  url: "https://eli.gov.pl/akt/1",
                  quote: "dosłowny cytat z ustawy",
                  relation: "WSPIERA",
                  aspect: "sedno",
                  sourceType: "pierwotne",
                  level: 1,
                  role: "tresc",
                  group: "wspierajace",
                },
              ],
      },
    ],
    mainVerdict: verdict,
    summaryPl: "Krótkie podsumowanie wyniku.",
    warnings: [],
    transparencyPl: "Kod sprawdził cytaty. Przeczytaj źródło sam.",
    models: [{ purpose: "assess", provider: "stub", model: "stub-main", inputTokens: 100, outputTokens: 50, latencyMs: 10, costUsd: 0.01 }],
    timingsMs: { total: 20 },
    costUsd: 0.01,
    unavailableBranches: [],
    securityEvents: [],
    cacheHit: false,
  };
  return { ...base, ...over, mainVerdict: over.mainVerdict === undefined ? base.mainVerdict : over.mainVerdict };
}

export type StubEngineFn = (req: EngineRequest, callNo: number) => VerdictReport | Promise<VerdictReport>;

export interface TestEnv {
  ctx: ServerContext;
  app: Hono;
  db: Database.Database;
  calls: EngineRequest[];
  /** Linie logu JSON zapisane przez serwer w tym środowisku. */
  logs: string[];
  clock: { now: number };
  advance(ms: number): void;
}

export function makeEnv(
  opts: {
    engine?: StubEngineFn;
    cfg?: Partial<AppConfig>;
    fetch?: typeof fetch;
    options?: Partial<ServerContext["options"]>;
    /** Użytkownicy w pliku (ścieżka) zamiast w pamięci. */
    usersPath?: string;
  } = {},
): TestEnv {
  const db = new Database(":memory:");
  migrate(db);
  const clock = { now: Date.parse("2026-11-21T10:00:00.000Z") };
  const calls: EngineRequest[] = [];
  const engineFn: StubEngineFn = opts.engine ?? ((req) => makeReport({ claim: req.text ?? req.url ?? "x" }));
  const logs: string[] = [];
  const ctx = createServerContext({
    cfg: makeTestConfig({ ...(opts.usersPath ? { usersPath: opts.usersPath } : {}), ...opts.cfg }),
    scryptN: 1024, // tanie haszowanie w testach
    log: createLogger((line) => void logs.push(line), () => new Date(clock.now)),
    db,
    engine: {
      async verify(req) {
        calls.push(req);
        return engineFn(req, calls.length);
      },
      snapshotId: () => "snap-1",
      pipelineVersion: "test-1",
      llm: { provider: "stub", available: true, singleKey: true },
    },
    corpus: { count: () => 42, catalog: () => [], countsBySource: () => ({ eli: 40, demagog: 2 }) },
    security: makeStubSecurity(() => clock.now),
    topics: loadHighRiskTopics(),
    fetch: opts.fetch,
    now: () => new Date(clock.now),
    options: opts.options,
  });
  return { ctx, app: createApp(ctx), db, calls, logs, clock, advance: (ms) => void (clock.now += ms) };
}

export interface ChatResult {
  status: number;
  json: any;
  cookie: string;
}

/** POST /api/chat z pamiętaniem ciasteczka sesji. */
export async function chat(env: TestEnv, body: Record<string, unknown>, cookie = ""): Promise<ChatResult> {
  const res = await env.app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = /pw_sid=([^;]*)/.exec(setCookie);
  const newCookie = m ? (m[1] ? `pw_sid=${m[1]}` : "") : cookie;
  return { status: res.status, json: await res.json(), cookie: newCookie };
}

export interface AdminSessionInfo {
  cookie: string;
  csrf: string;
  user: { username: string; role: Role };
}

/** Logowanie loginem i hasłem; domyślnie konto „admin” z hasłem z konfiguracji testowej. */
export async function adminLogin(
  env: TestEnv,
  creds: { username?: string; password?: string } = {},
): Promise<AdminSessionInfo> {
  const res = await env.app.request("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: creds.username ?? "admin", password: creds.password ?? env.ctx.cfg.adminPassword }),
  });
  const cookie = /pw_admin=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
  const json = (await res.json()) as { csrf: string; user: { username: string; role: Role } };
  return { cookie, csrf: json.csrf, user: json.user };
}

export const TEST_PASSWORD = "haslo-testowe-123";

/** Tworzy użytkownika danej roli i zwraca jego sesję (login: `test-<rola>`). */
export async function loginAs(env: TestEnv, role: Role): Promise<AdminSessionInfo> {
  const username = `test-${role}`;
  if (!env.ctx.auth.users.get(username)) await env.ctx.auth.users.add({ username, role, password: TEST_PASSWORD });
  env.advance(61_000); // limit prób logowania per IP liczy też udane próby
  return adminLogin(env, { username, password: TEST_PASSWORD });
}

/** Tworzy token API (rola analityk) bezpośrednio w sklepie i zwraca surowy token. */
export function makeApiToken(env: TestEnv, label = "test"): string {
  return env.ctx.auth.tokens.create({ label, createdBy: "test" }).token;
}
