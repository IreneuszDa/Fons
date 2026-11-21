/**
 * In-browser fake of the admin API for ?fixtures=1 (UI review without a server). It enforces the same
 * role rules and CSRF header as the agreed server surface so the panel's 401/403 paths can be exercised.
 * Fixture data only — sign in as "moderator", "analityk" or "administrator" with any non-empty password.
 */
import admin from "../fixtures/admin.json";
import type { AdminCase, AdminMetrics, ApiToken, FakeResult, PanelUser, Role } from "./adminApi";
import { isRole } from "./adminApi";

type State = {
  user: { username: string; role: Role } | null;
  csrf: string;
  cases: AdminCase[];
  users: PanelUser[];
  tokens: ApiToken[];
  nextTokenId: number;
};

function fresh(): State {
  const data = structuredClone(admin) as unknown as { cases: AdminCase[]; users: PanelUser[]; tokens: ApiToken[] };
  return { user: null, csrf: "", cases: data.cases, users: data.users, tokens: data.tokens, nextTokenId: 100 };
}

let state = fresh();

/** Test hook. */
export function resetFakeServer(): void {
  state = fresh();
}

const ok = (body: unknown): FakeResult => ({ status: 200, body });
const err = (status: number, error: string, messagePl: string): FakeResult => ({ status, body: { error, messagePl } });

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ALL: Role[] = ["moderator", "analityk", "administrator"];
const ANALYST: Role[] = ["analityk", "administrator"];
const EDITORS: Role[] = ["moderator", "administrator"];
const ADMIN: Role[] = ["administrator"];

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV injection guard, as on the server
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function handle(method: string, rawPath: string, body: unknown, headers: Record<string, string>): FakeResult {
  const url = new URL(rawPath, "http://fake.local");
  const path = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;

  if (method === "POST" && path === "/api/admin/login") {
    const username = typeof b.username === "string" ? b.username.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const found = state.users.find((u) => u.username === username);
    if (!username || !password) return err(400, "bad_request", "Podaj nazwę użytkownika i hasło.");
    if (!found || !isRole(found.role)) return err(401, "unauthorized", "Nieprawidłowa nazwa użytkownika lub hasło.");
    state.user = { username: found.username, role: found.role };
    state.csrf = randomHex(16);
    return ok({ user: state.user, csrf: state.csrf });
  }

  if (!state.user) return err(401, "unauthorized", "Zaloguj się do panelu.");
  if (method !== "GET" && headers["X-CSRF-Token"] !== state.csrf) return err(403, "csrf", "Brak lub nieprawidłowy token CSRF.");
  const role = state.user.role;
  const allow = (roles: Role[]) => roles.includes(role);
  const forbidden = () => err(403, "forbidden", "Brak uprawnień.");

  if (method === "GET" && path === "/api/admin/me") return ok({ user: state.user, csrf: state.csrf });
  if (method === "POST" && path === "/api/admin/logout") {
    state.user = null;
    state.csrf = "";
    return ok({ ok: true });
  }

  if (method === "GET" && path === "/api/admin/cases") {
    if (!allow(ALL)) return forbidden();
    const status = url.searchParams.get("status") ?? "open";
    return ok({ cases: state.cases.filter((c) => c.status === status) });
  }
  const caseMatch = /^\/api\/admin\/cases\/([^/]+)$/.exec(path);
  if (method === "PATCH" && caseMatch) {
    if (!allow(EDITORS)) return forbidden();
    const c = state.cases.find((x) => x.id === decodeURIComponent(caseMatch[1]!));
    if (!c) return err(404, "not_found", "Nie ma takiej sprawy.");
    if (b.status !== undefined && !["open", "closed", "forwarded"].includes(String(b.status))) return err(400, "bad_request", "Nieprawidłowy status.");
    if (typeof b.status === "string") c.status = b.status;
    if (typeof b.note === "string") c.note = b.note;
    if (typeof b.representativeText === "string" && b.representativeText.trim()) c.representativeText = b.representativeText.trim();
    c.updatedAt = new Date().toISOString();
    return ok({ case: c });
  }

  if (method === "GET" && path === "/api/admin/metrics") {
    if (!allow(ANALYST)) return forbidden();
    return ok(admin.metrics as unknown as AdminMetrics);
  }
  if (method === "GET" && (path === "/api/admin/export.csv" || path === "/api/admin/export.json")) {
    if (!allow(ANALYST)) return forbidden();
    const rows = state.cases.map(({ id, representativeText, status, senderCount, channels, alertState, createdAt, updatedAt }) => ({
      id,
      representativeText,
      status,
      senderCount,
      channels: channels.join("|"),
      alertState,
      createdAt,
      updatedAt,
    }));
    if (path.endsWith(".json")) return { status: 200, body: null, text: JSON.stringify({ cases: rows }, null, 2) };
    const cols = Object.keys(rows[0] ?? { id: "" });
    const text = [cols.join(","), ...rows.map((r) => cols.map((k) => csvCell((r as Record<string, unknown>)[k])).join(","))].join("\n");
    return { status: 200, body: null, text };
  }

  if (path === "/api/admin/users") {
    if (!allow(ADMIN)) return forbidden();
    if (method === "GET") return ok({ users: state.users });
    if (method === "POST") {
      const username = typeof b.username === "string" ? b.username.trim() : "";
      if (!/^[a-z0-9._-]{3,40}$/i.test(username)) return err(400, "bad_request", "Nazwa użytkownika: 3–40 znaków (litery, cyfry, . _ -).");
      if (!isRole(b.role)) return err(400, "bad_request", "Wybierz rolę.");
      if (typeof b.password !== "string" || b.password.length < 12) return err(400, "bad_request", "Hasło musi mieć co najmniej 12 znaków.");
      if (state.users.some((u) => u.username === username)) return err(409, "conflict", "Taki użytkownik już istnieje.");
      state.users.push({ username, role: b.role, createdAt: new Date().toISOString() });
      return { status: 201, body: { user: { username, role: b.role } } };
    }
  }
  const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (method === "DELETE" && userMatch) {
    if (!allow(ADMIN)) return forbidden();
    const name = decodeURIComponent(userMatch[1]!);
    if (name === state.user.username) return err(400, "bad_request", "Nie możesz usunąć własnego konta.");
    const before = state.users.length;
    state.users = state.users.filter((u) => u.username !== name);
    return state.users.length < before ? ok({ ok: true }) : err(404, "not_found", "Nie ma takiego użytkownika.");
  }

  if (path === "/api/admin/tokens") {
    if (!allow(ANALYST)) return forbidden();
    if (method === "GET") return ok({ tokens: state.tokens });
    if (method === "POST") {
      const label = typeof b.label === "string" ? b.label.trim() : "";
      if (!label) return err(400, "bad_request", "Podaj nazwę tokenu.");
      const id = String(state.nextTokenId++);
      state.tokens.push({ id, label, createdAt: new Date().toISOString(), lastUsedAt: null, role: "analityk" });
      return { status: 201, body: { id, token: `fons_fixture_${randomHex(20)}` } };
    }
  }
  const tokenMatch = /^\/api\/admin\/tokens\/([^/]+)$/.exec(path);
  if (method === "DELETE" && tokenMatch) {
    if (!allow(ANALYST)) return forbidden();
    const id = decodeURIComponent(tokenMatch[1]!);
    const before = state.tokens.length;
    state.tokens = state.tokens.filter((t) => t.id !== id);
    return state.tokens.length < before ? ok({ ok: true }) : err(404, "not_found", "Nie ma takiego tokenu.");
  }

  if (method === "POST" && path === "/api/admin/cache/invalidate") {
    if (!allow(ADMIN)) return forbidden();
    return ok({ removed: typeof b.key === "string" && b.key ? 1 : 37 });
  }

  return err(404, "not_found", "Nie ma takiego zasobu.");
}

export const FIXTURE_LOGINS = ALL;
