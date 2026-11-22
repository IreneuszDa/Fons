/**
 * Konfiguracja usługi — jedyne miejsce czytające zmienne środowiskowe.
 * Wartości domyślne pozwalają uruchomić system z jednym kluczem LLM (tryb jednego klucza, PLAN §2).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type ProviderName = "anthropic" | "mistral" | "openai";

export interface AppConfig {
  env: "development" | "production" | "test";
  port: number;
  publicBaseUrl: string;
  dbPath: string;

  llmProvider: ProviderName;
  anthropicApiKey?: string;
  mistralApiKey?: string;
  openaiApiKey?: string;
  openaiSearchModel?: string;
  webSearchDailyCap?: number;
  videoProvider?: "openai" | "gemini" | "off";
  openaiVideoModel?: string;
  geminiApiKey?: string;
  geminiVideoModel?: string;
  socialKitApiKey?: string;
  /** "eu" = eu.api.openai.com (projekt OpenAI z rezydencją danych w UE); puste = przetwarzanie w USA. */
  openaiDataResidency?: string;
  /** Model główny (ocena dowodów). */
  modelMain: string;
  /** Model szybki (ekstrakcja twierdzeń, weryfikator, rozmowa z użytkownikiem). */
  modelFast: string;
  /** Dostawca niezależnego weryfikatora; undefined = tryb jednego klucza. */
  verifierProvider?: ProviderName;

  adminPassword: string;
  adminPasswordGenerated: boolean;
  userIdPepper: string;
  dailyTokenBudget: number;
  /**
   * Część dobowego budżetu, jaką może zużyć jeden adres klienta (IPv4 albo sieć IPv6 /64), 0–1 (IP_DAILY_TOKEN_SHARE,
   * domyślnie 0.25). Jeden anonimowy klient nie wyczerpie bezpiecznika dla wszystkich (SEC-04).
   */
  ipDailyTokenShare?: number;
  rateLimitPerMinute: number;
  liveSearch: boolean;
  reverseImageProvider?: "off" | "google_vision";
  reverseImageDailyCap?: number;
  googleVisionApiKey?: string;
  factCheckApiKey?: string;
  /** Webhook odbiorcy alertów pętli informacji (wskazany przez administratora). */
  alertWebhookUrl?: string;
  /** Tryb werdyktu: reguły (A, domyślny) albo propozycja modelu z bramkami kodu (B). */
  verdictMode: "rules" | "model_proposed";
  /** Serwer stoi za zaufanym reverse proxy: adres klienta z ostatniego wpisu X-Forwarded-For (TRUST_PROXY=on). */
  trustProxy?: boolean;
  /** Plik użytkowników panelu (USERS_PATH, domyślnie var/users.json). Brak = użytkownicy tylko w pamięci (testy). */
  usersPath?: string;
  /** Statyczny token do GET /metrics (METRICS_TOKEN); obok niego działają tokeny API analityka. */
  metricsToken?: string;
}

const DEFAULT_MODELS: Record<ProviderName, { main: string; fast: string }> = {
  anthropic: { main: "claude-opus-5-5", fast: "claude-opus-5-5" },
  mistral: { main: "mistral-large-latest", fast: "mistral-small-latest" },
  openai: { main: "gpt-6.2-sol", fast: "gpt-6-luna" },
};

const PROVIDERS: ProviderName[] = ["openai", "anthropic", "mistral"];

function asProvider(v: string | undefined): ProviderName | undefined {
  const t = v?.trim().toLowerCase();
  return t === "anthropic" || t === "mistral" || t === "openai" ? t : undefined;
}

function readOrCreateSecret(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const value = randomBytes(32).toString("hex");
  writeFileSync(path, value, { mode: 0o600 });
  return value;
}

/** Ścieżka pliku użytkowników bez skutków ubocznych (nie tworzy sekretów) — używa jej też scripts/user.ts. */
export function resolveUsersPath(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.USERS_PATH) ?? "var/users.json";
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function readVideoProvider(raw: string | undefined): AppConfig["videoProvider"] {
  const value = nonEmpty(raw)?.toLowerCase();
  if (value === undefined || value === "openai" || value === "gemini" || value === "off") return value;
  throw new Error("VIDEO_PROVIDER musi mieć wartość openai, gemini lub off.");
}

export function selectedVideoProvider(cfg: Pick<AppConfig, "videoProvider" | "openaiApiKey" | "geminiApiKey">) {
  return cfg.videoProvider ?? (cfg.openaiApiKey ? "openai" : cfg.geminiApiKey ? "gemini" : "off");
}

let cached: AppConfig | undefined;

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const e = process.env;
  const nodeEnv = e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "test" || e.VITEST ? "test" : "development";

  const anthropicApiKey = nonEmpty(e.ANTHROPIC_API_KEY);
  const mistralApiKey = nonEmpty(e.MISTRAL_API_KEY);
  const openaiApiKey = nonEmpty(e.OPENAI_API_KEY);
  const googleVisionApiKey = nonEmpty(e.GOOGLE_VISION_API_KEY);
  const reverseImageProvider = nonEmpty(e.REVERSE_IMAGE_PROVIDER) ?? (googleVisionApiKey ? "google_vision" : "off");
  const keyed: Record<ProviderName, boolean> = {
    anthropic: !!anthropicApiKey,
    mistral: !!mistralApiKey,
    openai: !!openaiApiKey,
  };
  // Dostawca główny: jawnie z env, a jeśli jego klucza brak, a innego jest — pierwszy dostawca z kluczem.
  if (e.LLM_PROVIDER?.trim() && !asProvider(e.LLM_PROVIDER)) {
    throw new Error("LLM_PROVIDER musi wskazywać obsługiwanego dostawcę: openai, anthropic lub mistral.");
  }
  let llmProvider: ProviderName = asProvider(e.LLM_PROVIDER) ?? "anthropic";
  if (!keyed[llmProvider]) llmProvider = PROVIDERS.find((p) => keyed[p]) ?? llmProvider;

  let verifierProvider: ProviderName | undefined = asProvider(nonEmpty(e.VERIFIER_PROVIDER));
  if (verifierProvider === llmProvider) verifierProvider = undefined;
  if (verifierProvider && !keyed[verifierProvider]) verifierProvider = undefined;

  const varDir = "var";
  const adminFromEnv = nonEmpty(e.ADMIN_PASSWORD);
  const adminPassword = adminFromEnv ?? readOrCreateSecret(`${varDir}/admin-password`);

  const modelFast = nonEmpty(e.MODEL_FAST) ?? DEFAULT_MODELS[llmProvider].fast;
  const cfg: AppConfig = {
    env: nodeEnv,
    port: Number(e.PORT ?? 8787),
    publicBaseUrl: nonEmpty(e.PUBLIC_BASE_URL) ?? `http://localhost:${e.PORT ?? 8787}`,
    dbPath: nonEmpty(e.DB_PATH) ?? `${varDir}/prawdowid.db`,
    llmProvider,
    anthropicApiKey,
    mistralApiKey,
    openaiApiKey,
    videoProvider: readVideoProvider(e.VIDEO_PROVIDER),
    openaiVideoModel: nonEmpty(e.OPENAI_VIDEO_MODEL),
    geminiApiKey: nonEmpty(e.GEMINI_API_KEY),
    geminiVideoModel: nonEmpty(e.GEMINI_VIDEO_MODEL),
    socialKitApiKey: nonEmpty(e.SOCIALKIT_API_KEY),
    openaiDataResidency: nonEmpty(e.OPENAI_DATA_RESIDENCY),
    modelMain: nonEmpty(e.MODEL_MAIN) ?? DEFAULT_MODELS[llmProvider].main,
    modelFast,
    openaiSearchModel: nonEmpty(e.OPENAI_SEARCH_MODEL) ?? (llmProvider === "openai" ? modelFast : DEFAULT_MODELS.openai.fast),
    verifierProvider,
    adminPassword,
    adminPasswordGenerated: !adminFromEnv,
    userIdPepper: nonEmpty(e.USER_ID_PEPPER) ?? readOrCreateSecret(`${varDir}/user-id-pepper`),
    dailyTokenBudget: Number(e.DAILY_TOKEN_BUDGET ?? 3_000_000),
    ipDailyTokenShare: e.IP_DAILY_TOKEN_SHARE !== undefined ? Number(e.IP_DAILY_TOKEN_SHARE) : undefined,
    rateLimitPerMinute: Number(e.RATE_LIMIT_PER_MINUTE ?? 10),
    liveSearch: nonEmpty(e.LIVE_SEARCH) ? e.LIVE_SEARCH?.trim() === "on" : Boolean(openaiApiKey),
    webSearchDailyCap: nonEmpty(e.WEB_SEARCH_DAILY_CAP) ? Number(e.WEB_SEARCH_DAILY_CAP) : undefined,
    reverseImageProvider: reverseImageProvider === "google_vision" ? "google_vision" : "off",
    reverseImageDailyCap: Number(e.REVERSE_IMAGE_DAILY_CAP ?? 500),
    googleVisionApiKey,
    factCheckApiKey: nonEmpty(e.FACTCHECK_API_KEY),
    alertWebhookUrl: nonEmpty(e.ALERT_WEBHOOK_URL),
    verdictMode: e.VERDICT_MODE === "model_proposed" ? "model_proposed" : "rules",
    trustProxy: e.TRUST_PROXY === "on",
    usersPath: resolveUsersPath(e),
    metricsToken: nonEmpty(e.METRICS_TOKEN),
    ...overrides,
  };
  if (Object.keys(overrides).length === 0) cached = cfg;
  return cfg;
}

/** Domyślne modele dostawcy (do konstrukcji weryfikatora innej rodziny). */
export function defaultModelsFor(provider: ProviderName): { main: string; fast: string } {
  return DEFAULT_MODELS[provider];
}
