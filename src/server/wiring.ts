/**
 * Podłączenie prawdziwych modułów (korpus, silnik, bezpieczeństwo) do kontekstu serwera.
 * Jedyny plik serwera, który importuje wartości z src/corpus, src/engine i src/security.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "../corpus/catalog";
import { createCorpusStore, ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { createConversationAgent } from "../engine/llm/conversation";
import { isolateFenceMarkers, normalizeInput } from "../engine/normalize";
import { createE5Embedder, warmUp, type Embedder } from "../engine/retrieval";
import { currentLiveRequestId, runWithLiveScope, withLiveUsage } from "../engine/retrieval/live";
import { PIPELINE_VERSION, createEngineDeps, verifyInput } from "../engine/verify";
import { resolveRelativeDates } from "../security/dates";
import { detectInjection } from "../security/detector";
import { maskPii, pseudonymize } from "../security/pii";
import { createRateLimiter } from "../security/ratelimit";
import type { AppConfig } from "./config";
import { createServerContext, type Db, type ServerContext } from "./context";
import { migrate } from "./db";
import { createChannelRegistry } from "./channels/registry";
import { loadExtensions, type FonsExtensions } from "./extensions";
import { loadHighRiskTopics } from "./moderator/topics";

export interface ProductionContext {
  ctx: ServerContext;
  db: Db;
}

export function openServerDatabase(cfg: AppConfig): Db {
  if (cfg.dbPath !== ":memory:") mkdirSync(dirname(resolve(cfg.dbPath)), { recursive: true });
  const db = openDatabase(cfg.dbPath);
  // Baza z raportami, sesjami i dziennikiem: tylko właściciel procesu (SEC-10). Błąd chmod nie blokuje startu.
  if (cfg.dbPath !== ":memory:") {
    for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) {
      try {
        if (existsSync(f)) chmodSync(f, 0o600);
      } catch {
        /* system plików bez uprawnień POSIX */
      }
    }
  }
  ensureCorpusLoaded(db);
  migrate(db);
  return db;
}

export async function configuredProductionContext(cfg: AppConfig, db: Db): Promise<ServerContext> {
  return buildProductionContext(cfg, db, await loadExtensions(cfg, db));
}

export function buildProductionContext(cfg: AppConfig, db: Db, extensions?: FonsExtensions): ServerContext {
  const channels = createChannelRegistry();
  for (const adapter of extensions?.channels ?? []) {
    if (adapter.id === "chatloom" || channels.get(adapter.id)) throw new Error(`Identyfikator kanału jest już zajęty: ${adapter.id}`);
    channels.register(adapter, { webhook: true });
  }
  const store = createCorpusStore(db);
  const deps = createEngineDeps(db, cfg, {
    extensions,
    liveOptions: {
      // Gałąź „live” jest tworzona raz na proces; identyfikator przebiegu przychodzi z zakresu runWithLiveScope
      // (engine.verify niżej). Poza zakresem (np. ewaluacja bez serwera) — sztuczny request_id „live:{host}”.
      onSecurityEvent: (hit, info) => {
        try {
          db.prepare(
            `INSERT INTO security_events (request_id, sender_id, session_id, created_at, source, location, record_id, pattern, excerpt, severity)
             VALUES (?, NULL, NULL, ?, 'live', ?, NULL, ?, ?, ?)`,
          ).run(currentLiveRequestId() ?? `live:${info.host}`, new Date().toISOString(), hit.location, hit.pattern, hit.excerpt.slice(0, 200), hit.severity);
        } catch {
          /* zapis zdarzenia nigdy nie psuje wyszukiwania */
        }
      },
    },
  });
  // Rozgrzewka wyszukiwania (model ONNX, indeks wektorów) w tle; warmUp nigdy nie rzuca.
  void warmUp(deps.branches).then((status) => {
    const down = Object.entries(status).filter(([, s]) => !s.available).map(([id]) => id);
    if (down.length > 0) console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "retrieval_warmup", unavailable: down }));
  });

  // Deduplikacja parafraz w sprawach moderatora: ten sam lokalny model co gałąź wektorowa, ładowany leniwie
  // (dopiero przy pierwszej sprawie, której nie rozstrzyga dopasowanie leksykalne). Błąd → tylko dopasowanie leksykalne.
  let caseEmbedder: Embedder | undefined;
  const embedClaims = (texts: string[]): Promise<Float32Array[]> => (caseEmbedder ??= createE5Embedder()).embed(texts, "query");

  return createServerContext({
    cfg,
    db,
    embedClaims,
    channels,
    conversationAgent: deps.llm.available ? createConversationAgent(deps.llm) : undefined,
    engine: {
      // Zakres przebiegu: koszt wyszukiwania na żywo (tokeny + opłata za web_search) trafia do report.models
      // („live_search”) i report.costUsd, a zdarzenia bezpieczeństwa gałęzi live dostają identyfikator przebiegu.
      readArticle: req => normalizeInput({ kind: "url", url: req.url, text: req.text, receivedAt: req.receivedAt }, {
        llm: deps.llm, fetchPage: deps.fetchPage, receivedAt: new Date(req.receivedAt), ocrDown: false,
      }),
      verify: ({ requestId, ...req }, articleRead) =>
        runWithLiveScope({ requestId }, async () => withLiveUsage(await verifyInput(req, deps, { articleRead }))),
      snapshotId: () => store.snapshotId(),
      pipelineVersion: deps.pipelineVersion ?? PIPELINE_VERSION,
      llm: { provider: deps.llm.name, available: deps.llm.available, singleKey: deps.singleKey },
    },
    corpus: {
      count: () => store.count(),
      catalog: () => loadCatalog(),
      countsBySource: () => {
        const rows = db.prepare("SELECT source_id, COUNT(*) AS n FROM records GROUP BY source_id").all() as { source_id: string; n: number }[];
        return Object.fromEntries(rows.map((r) => [r.source_id, r.n]));
      },
    },
    security: {
      maskPii,
      hasInjection: (text) => detectInjection(isolateFenceMarkers(text), "user_message").length > 0,
      resolveRelativeDates,
      pseudonymize: (raw) => pseudonymize(raw, cfg.userIdPepper),
      createRateLimiter: (opts) => createRateLimiter(opts),
    },
    topics: loadHighRiskTopics(),
    engineDeps: deps,
    options: { webDistDir: cfg.env === "production" ? resolve("web-dist") : undefined },
  });
}
