/**
 * Kontekst serwera — jedyne miejsce, przez które aplikacja widzi inne moduły (silnik, korpus, bezpieczeństwo).
 * Dzięki temu createApp(ctx) da się testować z atrapami, a prawdziwe moduły podłącza dopiero wiring.ts.
 */
import type BetterSqlite3 from "better-sqlite3";
import type { AppConfig } from "./config";
import type { CatalogSource, ChannelId, InputKind, VerdictReport } from "../shared/contracts";
import type { VerificationStage } from "../shared/chat";
import { createChannelRegistry, type ChannelRegistry } from "./channels/registry";
import { createSmsSimAdapter, deriveSmsSimSecret } from "./channels/sms-sim";
import type { TopicRule } from "./moderator/topics";
import type { EngineDeps } from "../engine/verify";
import type { ConversationAgent } from "../engine/llm/conversation";
import { ConversationLinks } from "./conversation/link-memory";
import { createAdminLog, type AdminLog } from "./auth/adminlog";
import { createLoginThrottle, type LoginThrottle } from "./auth/throttle";
import { createTokenStore, type TokenStore } from "./auth/tokens";
import { createUserStore, type UserStore } from "./auth/users";
import { createLogger, nullLogger, stdoutSink, type Logger } from "./observability/logger";
import { createServerMetrics, type ServerMetrics } from "./observability/metrics";

export type Db = BetterSqlite3.Database;

/** Kształt zgodny z VerifyRequest z src/engine/verify.ts (docs/MODULES.md). */
export interface EngineRequest {
  kind: InputKind;
  text?: string;
  url?: string;
  images?: { mime: string; base64: string }[];
  imageOptions?: { searchWeb?: boolean };
  imageFocus?: "origin";
  onActivity?: (stage: VerificationStage) => void;
  channel: ChannelId;
  receivedAt: string;
  fault?: string;
  /** Identyfikator przebiegu (X-Request-Id) — tylko do korelacji zdarzeń i kosztu; silnik go nie dostaje. */
  requestId?: string;
}

export interface RateLimiterPort {
  /** true = dozwolone, false = ponad limit. */
  check(key: string): boolean;
}

export interface SecurityPorts {
  maskPii(text: string): { text: string; masked: boolean; kinds: string[] };
  hasInjection?(text: string): boolean;
  resolveRelativeDates(text: string, receivedAt: Date): string;
  pseudonymize(rawId: string): string;
  createRateLimiter(opts: { perMinute: number }): RateLimiterPort;
}

export interface EnginePort {
  verify(req: EngineRequest): Promise<VerdictReport>;
  snapshotId(): string;
  pipelineVersion: string;
  llm: { provider: string; available: boolean; singleKey: boolean };
}

export interface CorpusPort {
  count(): number;
  catalog(): CatalogSource[];
  countsBySource(): Record<string, number>;
}

export interface ServerOptions {
  /** Twardy dzienny limit alertów (PLAN §8). */
  dailyAlertCap: number;
  /** Liczba unikalnych nadawców uruchamiająca alert. */
  senderThreshold: number;
  maxInputChars: number;
  /** Katalog zbudowanego WWW (web-dist). Brak = nie serwujemy plików statycznych. */
  webDistDir?: string;
  /** Czas oczekiwania na potwierdzenie „usuń”/„zgłoś” (ms). */
  confirmTtlMs: number;
  /**
   * Ładowanie modułu MCP (domyślnie dynamiczny import ../mcp/http). Testy podstawiają własny loader;
   * jeśli rzuca, trasa /mcp odpowiada 501.
   */
  mcpLoader?: () => Promise<unknown>;
}

export interface AdminSession {
  username: string;
  csrf: string;
  expiresAt: number;
}

export interface AuthServices {
  users: UserStore;
  tokens: TokenStore;
  adminLog: AdminLog;
  /** Blokada zgadywania haseł per login. */
  loginThrottle: LoginThrottle;
}

export interface MediaItem {
  mime: string;
  base64: string;
}

export interface ServerContext {
  cfg: AppConfig;
  db: Db;
  engine: EnginePort;
  conversationAgent?: ConversationAgent;
  corpus: CorpusPort;
  security: SecurityPorts;
  topics: TopicRule[];
  channels: ChannelRegistry;
  fetch: typeof fetch;
  now: () => Date;
  options: ServerOptions;
  limiters: { sender: RateLimiterPort; ip: RateLimiterPort; adminLogin: RateLimiterPort };
  /** Obrazy z bieżącego żądania (usuwane po przetworzeniu). */
  media: Map<string, MediaItem>;
  adminSessions: Map<string, AdminSession>;
  /** Kolejka tur w obrębie tej samej rozmowy. */
  activeTurns: Map<string, Promise<void>>;
  conversationLinks: ConversationLinks;
  /** Deduplikacja identyfikatorów wiadomości z webhooków (okno 5 min). */
  seenMessages: Map<string, number>;
  /** Dobowe zużycie tokenów per klient (IPv4 / IPv6 /64) — udział w budżecie (SEC-04). */
  clientUsage: Map<string, { day: string; tokens: number }>;
  /** Logi JSON na stdout (w testach: bez wyjścia albo przechwytywane). */
  log: Logger;
  metrics: ServerMetrics;
  auth: AuthServices;
  /** Zależności silnika dla modułu MCP (tylko w produkcji; brak w testach z atrapą silnika). */
  engineDeps?: EngineDeps;
  /**
   * Wektory twierdzeń z lokalnego modelu (e5) do deduplikacji spraw moderatora. Brak = tylko dopasowanie leksykalne.
   * Wektory L2-znormalizowane, po jednym na tekst.
   */
  embedClaims?: (texts: string[]) => Promise<Float32Array[]>;
  startedAt: Date;
}

export interface ContextParts {
  cfg: AppConfig;
  db: Db;
  engine: EnginePort;
  conversationAgent?: ConversationAgent;
  corpus: CorpusPort;
  security: SecurityPorts;
  topics?: TopicRule[];
  channels?: ChannelRegistry;
  fetch?: typeof fetch;
  now?: () => Date;
  options?: Partial<ServerOptions>;
  log?: Logger;
  metrics?: ServerMetrics;
  auth?: Partial<AuthServices>;
  /** Koszt scrypt dla haseł (testy: mały). */
  scryptN?: number;
  engineDeps?: EngineDeps;
  embedClaims?: (texts: string[]) => Promise<Float32Array[]>;
}

export const DEFAULT_OPTIONS: ServerOptions = {
  dailyAlertCap: 20,
  senderThreshold: 3,
  maxInputChars: 4000,
  confirmTtlMs: 10 * 60 * 1000,
};

/**
 * Domyślny rejestr: WWW, CLI i demonstracyjny adapter SMS (webhook podpisany HMAC, symulator /telefon).
 * SMS_SIM=off wyłącza adapter demonstracyjny.
 */
function defaultChannels(parts: ContextParts, now: () => Date): ChannelRegistry {
  const registry = createChannelRegistry();
  if (parts.cfg.smsSimulator !== false) {
    registry.register(
      createSmsSimAdapter({
        secret: deriveSmsSimSecret(parts.cfg.userIdPepper),
        pseudonymize: (raw) => parts.security.pseudonymize(raw),
        now,
      }),
      { webhook: true },
    );
  }
  return registry;
}

export function createServerContext(parts: ContextParts): ServerContext {
  const perMinute = Math.max(1, parts.cfg.rateLimitPerMinute);
  const now = parts.now ?? (() => new Date());
  const log = parts.log ?? (parts.cfg.env === "test" ? nullLogger : createLogger(stdoutSink, now));
  const users =
    parts.auth?.users ?? createUserStore({ path: parts.cfg.usersPath, now, scryptN: parts.scryptN });
  // Pierwszy start: konto „admin” z ADMIN_PASSWORD (albo wygenerowanym hasłem z config.ts).
  if (!parts.auth?.users && users.ensureBootstrapAdmin(parts.cfg.adminPassword).created) {
    log.info({ event: "admin_bootstrap", username: "admin", role: "administrator" });
  }
  return {
    cfg: parts.cfg,
    db: parts.db,
    engine: parts.engine,
    conversationAgent: parts.conversationAgent,
    corpus: parts.corpus,
    security: parts.security,
    topics: parts.topics ?? [],
    channels: parts.channels ?? defaultChannels(parts, now),
    fetch: parts.fetch ?? fetch,
    now,
    options: { ...DEFAULT_OPTIONS, ...parts.options },
    limiters: {
      sender: parts.security.createRateLimiter({ perMinute }),
      // adres IP bywa wspólny dla wielu osób (NAT, szkoła) — limit hojniejszy niż per nadawca
      ip: parts.security.createRateLimiter({ perMinute: perMinute * 3 }),
      adminLogin: parts.security.createRateLimiter({ perMinute: 5 }),
    },
    media: new Map(),
    adminSessions: new Map(),
    activeTurns: new Map(),
    conversationLinks: new ConversationLinks(now),
    seenMessages: new Map(),
    clientUsage: new Map(),
    log,
    metrics: parts.metrics ?? createServerMetrics(),
    auth: {
      users,
      tokens: parts.auth?.tokens ?? createTokenStore(parts.db, now),
      adminLog: parts.auth?.adminLog ?? createAdminLog(parts.db, now),
      loginThrottle: parts.auth?.loginThrottle ?? createLoginThrottle({ now: () => now().getTime() }),
    },
    engineDeps: parts.engineDeps,
    embedClaims: parts.embedClaims,
    startedAt: now(),
  };
}
