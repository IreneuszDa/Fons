# Fons — podział na moduły i interfejsy między nimi

Stack: TypeScript na Node 22. Jedna usługa: Hono (API + serwowanie zbudowanego WWW) + SQLite (better-sqlite3, FTS5) + React/Vite z Astryx (WWW). Uruchomienie: `npm run dev` (lokalnie), `npm start` po `npm run build` (produkcja), Docker później.

Kontrakty danych: `src/shared/contracts.ts` (zod) — jedyne źródło prawdy. Nie zmieniaj go; jeśli czegoś brakuje, dodaj typ lokalny w swoim module i zgłoś to w raporcie końcowym.

Plan produktu i reguły: `PLAN.md` (sekcje 1, 3, 4 i 6 są normatywne). Zadanie konkursowe: wymagania w PLAN.md są z niego wyprowadzone.

## Zasady wspólne

- Importy relatywne, ESM (`"type": "module"`), rozszerzenia `.js` w importach NIE są potrzebne (tsx/vite/Bundler resolution).
- Nie uruchamiaj `npm install`. Wszystkie zależności są już zainstalowane: hono, @hono/node-server, better-sqlite3, zod (v4), @anthropic-ai/sdk, @mistralai/mistralai, yaml, linkedom, @mozilla/readability, ipaddr.js, undici, fastest-levenshtein, nanoid, dotenv, @huggingface/transformers, react, react-dom, @heroicons/react, @astryxdesign/core, @astryxdesign/theme-neutral, @stylexjs/stylex; dev: typescript, tsx, vite 7, @vitejs/plugin-react 5, vitest, concurrently. Jeśli naprawdę brakuje pakietu, napisz kod bez niego i zgłoś to.
- Testy: vitest, pliki `*.test.ts` obok kodu. Testy jednostkowe nie mogą wymagać sieci ani klucza API (użyj `FakeLlmProvider`).
- Teksty dla użytkownika po polsku, prostym językiem. Identyfikatory i komentarze w kodzie mogą być po angielsku.
- Żadnych sekretów w kodzie ani w repozytorium. Konfiguracja przez `src/server/config.ts` (czyta `.env` przez dotenv).
- Treść niezaufana (wejście użytkownika, strony, fragmenty korpusu) nigdy nie trafia do promptu systemowego; zawsze w blokach z losowym ogranicznikiem (`src/engine/llm/fence.ts`).

## Właściciele katalogów (każdy agent pisze tylko w swoich)

| Katalog | Moduł | Co dostarcza |
|---|---|---|
| `src/security/` | Bezpieczeństwo | pobieranie URL z ochroną SSRF, ekstrakcja treści strony, detektor ataków, maskowanie PII, pseudonimizacja, daty względne, limiter |
| `src/corpus/`, `data/` | Korpus | katalog źródeł, ingestia z prawdziwych źródeł, rekordy JSONL, tabela mapowania ocen, ładowanie do SQLite + FTS5, `CorpusStore`, import pakietu organizatora |
| `src/engine/retrieval/` | Wyszukiwanie | gałęzie BM25 / wektory (ONNX) / incydenty, łączenie wyników (RRF), limity czasu gałęzi |
| `src/engine/verdict/` | Reguły werdyktu | czysta funkcja reguł 1–9 z PLAN §4, rozstrzygalność dowodu, karta siły; wyczerpujące testy |
| `src/engine/` (reszta) | Rdzeń silnika | dostawcy LLM, ekstrakcja twierdzeń, ocena dowodów, kontrola cytatów, weryfikator, uzasadnienie, orkiestrator `verifyInput` |
| `src/server/`, `scripts/` | Serwer | API Hono, baza (sesje, raporty, przebiegi, zdarzenia, cache, sprawy), warstwa rozmowy, adapter kanału web, log audytu z łańcuchem hashy, limity, panel admina (minimum) |
| `src/web/`, `index.html`, `vite.config.ts` | WWW | czat obywatela, karta werdyktu, strona wyniku `/w/:token`, strona audytu źródeł, prosty panel admina |
| `eval/` | Ewaluacja | zestaw przypadków A–J (dev/held-out), zestaw red-team, harness metryk, test spójności kanałów |

## Interfejsy między modułami (sygnatury obowiązujące)

### `src/security/`
```ts
// fetch.ts
export interface FetchedPage {
  finalUrl: string; status: number; contentType: string;
  rawHtml?: string;            // surowy HTML (do detektora — PRZED czyszczeniem)
  rawText: string;             // tekst z ukrytymi elementami (do detektora)
  cleanText: string;           // czytelna treść (Readability), bez ukrytego HTML i znaków zero-width
  title?: string; publishedAt?: string; // z metadanych strony, jeśli są
  hiddenSegments: string[];    // treść ukryta (display:none, aria-hidden, białe na białym, komentarze, meta)
}
export async function fetchPage(url: string, opts?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }): Promise<FetchedPage>;
export class FetchBlockedError extends Error { reason: "scheme" | "port" | "private_ip" | "too_large" | "redirects" | "timeout" | "content_type" | "http_error" }
// detector.ts
export function detectInjection(text: string, location: DetectorHit["location"], recordId?: string): DetectorHit[];
/** Usuwa z tekstu tylko zdania z trafieniem (PLAN §3.2) i zwraca resztę. */
export function stripFlaggedSentences(text: string, hits: DetectorHit[]): string;
// pii.ts
export function maskPii(text: string): { text: string; masked: boolean; kinds: string[] };
export function pseudonymize(rawId: string): string; // HMAC-SHA256 z pepperem
// dates.ts
export function resolveRelativeDates(text: string, receivedAt: Date): string; // „wczoraj” → „20 listopada 2026”
// ratelimit.ts
export function createRateLimiter(opts: { perMinute: number }): { check(key: string): boolean };
// render.ts
export function safeUrl(url: string): string | null; // tylko http/https
```

### `src/corpus/`
```ts
// store.ts
export function openDatabase(dbPath: string): import("better-sqlite3").Database; // jedna baza dla całej usługi
export function ensureCorpusLoaded(db: Database): { snapshotId: string; records: number }; // ładuje data/corpus/*.jsonl, idempotentnie
export function createCorpusStore(db: Database): CorpusStore;
// catalog.ts
export function loadCatalog(): CatalogSource[];              // data/sources.yaml
export function catalogSourceForHost(host: string): CatalogSource | undefined; // dopasowanie DOKŁADNEGO hosta
// ratings.ts
export function mapRating(sourceId: string, raw: string): FixedRating; // data/rating-map.yaml
```
Schemat bazy (właściciel: korpus):
- `records(id TEXT PRIMARY KEY, source_id, url, title, publisher, published_at, fetched_at, lang, text, role, type, level INTEGER, independence_group, licence, claim_reviewed, rating_json, topics_json, period, origin)`
- `records_fts` — FTS5 `(title, text, claim_reviewed)`, `content='records'`, `content_rowid='rowid'`, `tokenize='unicode61 remove_diacritics 2'`
- `incidents(id TEXT PRIMARY KEY, title, summary, url, domains_json, published_at, record_id)` + `incidents_fts`
- `corpus_meta(key TEXT PRIMARY KEY, value TEXT)` — m.in. `snapshot_id`, `embedding_model`, `embedding_model_hash`
- `record_embeddings(record_id TEXT PRIMARY KEY, vector BLOB)` — wypełniane przez moduł wyszukiwania

Pliki danych: `data/sources.yaml`, `data/rating-map.yaml`, `data/corpus/*.jsonl` (jeden `CorpusRecord` na linię), `data/incidents/*.jsonl`, `docs/SOURCES.md` (licencje, kwalifikacja, aktualizacja). Wyjątek: `data/high-risk-topics.yaml` należy do serwera (pętla informacji).

`src/server/config.ts` (`AppConfig`, `loadConfig`, `defaultModelsFor`) jest już napisany przez orkiestratora — silnik i serwer go importują; serwer może go rozszerzać, nie łamiąc istniejących pól.

### `src/engine/retrieval/`
```ts
export function createRetrievalBranches(db: Database, opts: { liveSearch: boolean }): RetrievalBranch[];
export async function retrieve(branches: RetrievalBranch[], q: RetrievalQuery, opts?: { perBranchTimeoutMs?: number }):
  Promise<{ candidates: EvidenceCandidate[]; unavailable: string[]; requiredFailed: boolean }>;
export function matchIncidentDomains(urlOrText: string, db: Database): { incidentId: string; title: string; url: string }[]; // tylko do ostrzeżeń
```

### `src/engine/verdict/`
```ts
export interface VerdictInput {
  claim: Claim;
  assessments: EvidenceAssessment[];     // już po kontroli cytatów i weryfikatorze
  records: Map<string, CorpusRecord>;
  now: Date;
  singleKeyVerifier: boolean;            // weryfikator tej samej rodziny → jawny czynnik obniżający siłę (bez twardego limitu; VERDICT-RULES §5)
}
export interface VerdictDecision {
  verdict: Verdict; ruleApplied: number; strength: StrengthCard;
  decisiveRecordIds: string[]; missingContext?: string;
  conflicting?: { supporting: string[]; refuting: string[] };
  archival: boolean;
}
export function isDecisive(a: EvidenceAssessment, r: CorpusRecord, all: EvidenceAssessment[], records: Map<string, CorpusRecord>): boolean;
export function decideVerdict(input: VerdictInput): VerdictDecision;
```

### `src/engine/` (rdzeń)
```ts
// llm/index.ts
export function createLlmProviders(cfg: AppConfig): { main: LlmProvider; verifier: LlmProvider; singleKey: boolean };
export class FakeLlmProvider implements LlmProvider { /* deterministyczny, do testów */ }
// llm/fence.ts
export function fence(label: string, content: string): { text: string; boundary: string };
// verify.ts
export interface VerifyRequest { kind: InputKind; text?: string; url?: string; images?: { mime: string; base64: string }[]; channel: ChannelId; receivedAt: string; fault?: string }
export interface EngineDeps { llm: LlmProvider; verifier: LlmProvider; singleKey: boolean; store: CorpusStore; db: Database; branches: RetrievalBranch[]; fetchPage: typeof fetchPage; now: () => Date; verdictMode: "rules" | "model_proposed" }
export function createEngineDeps(db: Database, cfg: AppConfig): EngineDeps;
export async function verifyInput(req: VerifyRequest, deps: EngineDeps): Promise<VerdictReport>;
export function cacheKeyFor(req: VerifyRequest, normalized: NormalizedInput, deps: EngineDeps): string;
export const PIPELINE_VERSION: string;
```

### `src/server/`
```ts
// config.ts
export interface AppConfig { /* wszystkie pola z .env.example, z wartościami domyślnymi */ }
export function loadConfig(): AppConfig;
// conversation/index.ts
export async function handleInbound(msg: InboundMessage, ctx: ServerContext): Promise<ConversationReply>;
// index.ts — startuje Hono na PORT; w produkcji serwuje web-dist/
```
API (JSON, prefiks `/api`):
- `POST /api/chat` `{ sessionId?: string, text?: string, action?: string, image?: { mime, base64 } }` → `{ sessionId, reply: ConversationReply }` (ustawia ciasteczko sesji `pw_sid`, httpOnly, SameSite=Strict)
  Klient z `Accept: application/x-ndjson, application/json` otrzymuje strumień NDJSON tylko po uruchomieniu silnika. Pierwszy wiersz ma `type: "verification-start"`, a drugi `type: "reply"` wraz z `sessionId` i `reply`. Odpowiedzi rozmowy i trafienia w pamięć podręczną wracają jako zwykły JSON.
- `GET /api/report/:token` → `VerdictReport` (404 dla nieznanego tokenu)
- `GET /api/sources` → `{ catalog: CatalogSource[], counts: Record<string, number>, snapshotId }`
- `DELETE /api/session` → usuwa dane bieżącej sesji (raporty, przebiegi, sprawy tego nadawcy)
- `GET /api/health` → `{ ok, corpusRecords, snapshotId, llm: { provider, available, singleKey } }`
- `POST /api/admin/login`, `GET /api/admin/cases`, `GET /api/admin/metrics`, `GET /api/admin/export.csv|.json` (P2: minimum)
- `POST /api/channels/:id/webhook` — odbiera wiadomości tylko dla zarejestrowanych adapterów webhookowych. Dla nieskonfigurowanego kanału zwraca HTTP 501.
- CLI używa tej samej funkcji `handleInbound` co WWW. Polecenie `npm run ask -- "pytanie"` uruchamia weryfikację. MCP ma osobne wejście `/mcp` oraz transport stdio.

### `src/web/`
Czat w języku polskim wołający `POST /api/chat`; karta werdyktu renderowana z `VerdictReport`; strona `/w/:token`; strona `/zrodla` (audyt katalogu). Konwencje Astryx z `AGENTS.md` są obowiązkowe.

### `eval/`
```ts
// run.ts — czyta eval/cases/*.jsonl, woła verifyInput bezpośrednio (in-process) z deps z createEngineDeps, liczy metryki, zapisuje eval/results/<timestamp>.json i drukuje tabelę.
// consistency.ts — to samo wejście przez warstwę rozmowy jako kanał web i jako kanał cli. Porównuje status, werdykt i zestaw recordId.
```

## Faza 2 — moduły dodane po pierwszym pomiarze

### `src/engine/llm/router.ts` i `src/engine/answer.ts`
- `router.ts` — jawna tabela `ROUTING_TABLE` (cel wywołania → poziom: `claims`, `router`, `verifier`, `vision`, `smooth` → szybki; `assess`, `open_answer` → główny), eskalacja szybki → główny przy błędzie schematu / odmowie / limicie czasu, zapasowy dostawca innej rodziny. Nieudane próby trafiają do `report.models` jako `<cel>:failed` (0 tokenów, 0 USD). Opis: [ROUTER.md](ROUTER.md).
- `answer.ts` — pytania otwarte (`inputMode: "question_open"`): wyszukiwanie → tylko rekordy treściowe → model wybiera `{found, ref, quote}` → kod sprawdza cytat w tekście rekordu → weryfikator. `report.answer` składa kod: „{wydawca} ({data}) podaje: «{cytat}»”. Bez sprawdzonego cytatu nie ma odpowiedzi.

### `src/engine/retrieval/`
```ts
createRetrievalBranches(db, {
  liveSearch,                 // LIVE_SEARCH=on
  liveConfig?: Pick<AppConfig, "openaiApiKey" | "openaiDataResidency" | "modelFast">,
  liveOptions?: { onSecurityEvent?, onDrop? },   // serwer zapisuje trafienia detektora do security_events (source "live")
  ...
});
createEngineDeps(db, cfg, { liveOptions? });
```
`retrieve()` respektuje własny `timeoutMs` gałęzi (gałąź „live”: 6500 ms). Nowe pliki: `stem.ts` (rdzeniowanie PL/EN), `rerank.ts`, `live.ts`, `live-store.ts`, `live-score.ts`.

### `src/tools/` i `src/mcp/`
- `src/tools/search.ts` — `SearchProvider` (OpenAI Responses `web_search`, `allowed_domains`, `store:false`); kod ponownie sprawdza dokładny host. Opis: [TOOLS.md](TOOLS.md).
- `src/mcp/` — serwer MCP: `verify_claim`, `search_sources`, `get_report`, `list_sources`. Wejścia: `stdio.ts` (`npm run mcp`) i `http.ts` (`createMcpHttpHandler`, montowany przez serwer pod `POST /mcp`, token API w nagłówku `Authorization: Bearer`). Kanał w raportach: `mcp`.

### `src/server/` (RBAC, obserwowalność)
- `auth/permissions.ts` — jedyna macierz uprawnień (moderator / analityk / administrator); każda trasa `/api/admin` musi mieć wpis, inaczej serwer nie wstaje.
- `auth/users.ts` (plik `USERS_PATH`, scrypt), `auth/tokens.ts` (tokeny `fons_…`, w bazie tylko SHA-256), `auth/adminlog.ts` (dziennik działań administracyjnych z łańcuchem hashy).
- `observability/` — logi JSON z `X-Request-Id`, `GET /metrics` (Prometheus, token analityka albo `METRICS_TOKEN`).
- API panelu: `POST /api/admin/login {username, password}`, `GET /api/admin/me`, `GET|PATCH /api/admin/cases[/:id]`, `GET /api/admin/metrics`, eksporty, `tokens`, `users`, `cache/invalidate`, `audit/verify`, `audit-log`.
- `ConversationReply.kind === "answer"` dla pytań otwartych z odpowiedzią.

### `src/web/admin/`
Panel `/admin` jako osobny, leniwie ładowany fragment (obywatel go nie pobiera); zakładki według roli z macierzy uprawnień.
