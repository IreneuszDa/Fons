/**
 * Admin panel client (agreed surface: docs/MODULES.md → src/server admin API).
 * Cookies are httpOnly + SameSite=Strict; every state-changing call carries X-CSRF-Token from login / me.
 * Lives in the lazily loaded admin chunk, so citizens never download it.
 */
import { ApiError, messageFrom, NETWORK_ERROR_PL, readJson } from "../api";

export const ROLES = ["moderator", "analityk", "administrator"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export interface AdminUser {
  username: string;
  role: Role;
}

export const CASE_STATUSES = ["open", "forwarded", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** A type alias (not an interface) so it satisfies Table's Record<string, unknown> row constraint. */
export type AdminCase = {
  id: string;
  representativeText: string;
  status: string;
  senderCount: number;
  channels: string[];
  alertState: string;
  createdAt: string;
  updatedAt: string;
  note?: string | null;
};

export type CasePatch = { status?: CaseStatus; note?: string; representativeText?: string };

/** A breakdown value is a plain number or an object with counts/costs — the panel accepts both. */
export type MetricValue = number | Record<string, unknown>;
export type Breakdown = Record<string, MetricValue>;

export interface AdminMetrics {
  totals: {
    verifications: number;
    byStatus: Breakdown;
    byVerdict: Breakdown;
    abstentions: MetricValue;
    cacheHits: number;
    injectionEvents: number;
  };
  latency: { p50: number; p95: number; byStep?: Breakdown };
  cost: { totalUsd: number; per100Usd: number; byModel?: Breakdown };
  llm: { calls: number; tokensIn: number; tokensOut: number; byPurpose?: Breakdown };
  retrievalErrors: { byBranch?: Breakdown };
  window: { from: string | null; to: string | null };
}

export type PanelUser = { username: string; role: string; createdAt?: string | null };
export type ApiToken = { id: string; label: string; createdAt?: string | null; lastUsedAt?: string | null; role?: string };

let csrf: string | undefined;
export function resetAdminClient(): void {
  csrf = undefined;
}

export function currentCsrf(): string | undefined {
  return csrf;
}

const FORBIDDEN_PL = "Brak uprawnień do tej części panelu. Jeśli to pomyłka, poproś administratora o zmianę roli.";
const UNAUTHORIZED_PL = "Sesja wygasła albo nie jesteś zalogowany. Zaloguj się ponownie.";

interface RawResult {
  status: number;
  body: unknown;
  blob?: Blob;
}

async function transport(method: string, path: string, body: unknown, asBlob: boolean): Promise<RawResult> {
  const headers: Record<string, string> = { Accept: asBlob ? "*/*" : "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, NETWORK_ERROR_PL);
  }
  if (asBlob && res.ok) return { status: res.status, body: null, blob: await res.blob() };
  return { status: res.status, body: await readJson(res) };
}

function isCsrfError(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { error?: unknown }).error === "csrf";
}

async function call<T>(method: string, path: string, body: unknown, fallbackPl: string, asBlob = false): Promise<{ data: T; blob?: Blob }> {
  let r = await transport(method, path, body, asBlob);
  // A stale CSRF token (e.g. after a server restart): refresh it once from /me and retry.
  if (r.status === 403 && method !== "GET" && isCsrfError(r.body)) {
    const me = await adminMe();
    if (me) r = await transport(method, path, body, asBlob);
  }
  if (r.status === 401) {
    csrf = undefined;
    throw new ApiError(401, messageFrom(r.body, UNAUTHORIZED_PL));
  }
  if (r.status === 403) throw new ApiError(403, isCsrfError(r.body) ? UNAUTHORIZED_PL : FORBIDDEN_PL);
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, messageFrom(r.body, fallbackPl));
  return { data: r.body as T, blob: r.blob };
}

function readSession(body: unknown): AdminUser | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { user?: { username?: unknown; role?: unknown }; csrf?: unknown; csrfToken?: unknown };
  const token = typeof b.csrf === "string" ? b.csrf : typeof b.csrfToken === "string" ? b.csrfToken : undefined;
  if (token) csrf = token;
  const u = b.user;
  if (!u || typeof u.username !== "string" || !isRole(u.role)) return null;
  return { username: u.username, role: u.role };
}

/** Current session, or null when not signed in (401). */
export async function adminMe(): Promise<AdminUser | null> {
  const r = await transport("GET", "/api/admin/me", undefined, false);
  if (r.status === 401 || r.status === 404) return null;
  if (r.status === 403) throw new ApiError(403, FORBIDDEN_PL);
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, messageFrom(r.body, "Nie udało się sprawdzić sesji."));
  const user = readSession(r.body);
  if (!user) throw new ApiError(403, FORBIDDEN_PL);
  return user;
}

export async function adminLogin(username: string, password: string): Promise<AdminUser> {
  const r = await transport("POST", "/api/admin/login", { username, password }, false);
  if (r.status === 401 || r.status === 400) throw new ApiError(r.status, messageFrom(r.body, "Nieprawidłowa nazwa użytkownika lub hasło."));
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, messageFrom(r.body, "Nie udało się zalogować."));
  const user = readSession(r.body);
  if (!user) throw new ApiError(403, FORBIDDEN_PL);
  return user;
}

export async function adminLogout(): Promise<void> {
  try {
    await transport("POST", "/api/admin/logout", undefined, false);
  } finally {
    csrf = undefined;
  }
}

function listOf<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])) return (body as Record<string, T[]>)[key]!;
  return [];
}

export async function fetchCases(status: CaseStatus): Promise<AdminCase[]> {
  const { data } = await call<unknown>("GET", `/api/admin/cases?status=${encodeURIComponent(status)}`, undefined, "Nie udało się wczytać spraw.");
  return listOf<AdminCase>(data, "cases").map((c) => ({ ...c, id: String(c.id), channels: Array.isArray(c.channels) ? c.channels : [] }));
}

export async function patchCase(id: string, patch: CasePatch): Promise<void> {
  await call("PATCH", `/api/admin/cases/${encodeURIComponent(id)}`, patch, "Nie udało się zapisać zmian w sprawie.");
}

export async function fetchMetrics(): Promise<AdminMetrics> {
  const { data } = await call<AdminMetrics>("GET", "/api/admin/metrics", undefined, "Nie udało się wczytać metryk.");
  return data;
}

export type ExportFormat = "csv" | "json";

export const EXPORT_PATH: Record<ExportFormat, string> = { csv: "/api/admin/export.csv", json: "/api/admin/export.json" };

/** Downloads an export through fetch (so 401/403 show a message instead of a raw error page). */
export async function fetchExport(format: ExportFormat): Promise<Blob> {
  const { blob, data } = await call<unknown>("GET", EXPORT_PATH[format], undefined, "Nie udało się pobrać eksportu.", true);
  if (blob) return blob;
  return new Blob([typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2)]);
}

export async function fetchUsers(): Promise<PanelUser[]> {
  const { data } = await call<unknown>("GET", "/api/admin/users", undefined, "Nie udało się wczytać użytkowników.");
  return listOf<PanelUser>(data, "users");
}

export async function createUser(input: { username: string; role: Role; password: string }): Promise<void> {
  await call("POST", "/api/admin/users", input, "Nie udało się dodać użytkownika.");
}

export async function deleteUser(username: string): Promise<void> {
  await call("DELETE", `/api/admin/users/${encodeURIComponent(username)}`, undefined, "Nie udało się usunąć użytkownika.");
}

export async function fetchTokens(): Promise<ApiToken[]> {
  const { data } = await call<unknown>("GET", "/api/admin/tokens", undefined, "Nie udało się wczytać tokenów.");
  return listOf<ApiToken>(data, "tokens").map((t) => ({ ...t, id: String(t.id) }));
}

/** The token value is returned exactly once — the caller shows it and never stores it. */
export async function createToken(label: string): Promise<{ id: string; token: string }> {
  const { data } = await call<{ id: string | number; token: string }>("POST", "/api/admin/tokens", { label }, "Nie udało się utworzyć tokenu.");
  if (!data || typeof data.token !== "string") throw new ApiError(500, "Serwer nie zwrócił tokenu. Spróbuj ponownie.");
  return { id: String(data.id), token: data.token };
}

export async function revokeToken(id: string): Promise<void> {
  await call("DELETE", `/api/admin/tokens/${encodeURIComponent(id)}`, undefined, "Nie udało się unieważnić tokenu.");
}

export async function invalidateCache(key?: string): Promise<{ removed?: number }> {
  const { data } = await call<{ removed?: number } | null>("POST", "/api/admin/cache/invalidate", key ? { key } : {}, "Nie udało się wyczyścić pamięci podręcznej.");
  return data ?? {};
}
