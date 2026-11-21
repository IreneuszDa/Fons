/**
 * Macierz uprawnień — jedyne miejsce, które mówi, kto co może w panelu administratora.
 * Middleware `guard()` w admin.ts bierze uprawnienie dla trasy z ADMIN_ENDPOINTS; trasa bez wpisu
 * nie zostanie zarejestrowana (błąd przy starcie), więc nowa trasa nie może „zapomnieć” o kontroli.
 */

export const ROLES = ["moderator", "analityk", "administrator"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export type Permission =
  | "cases:read"
  | "cases:write"
  | "metrics:read"
  | "export:read"
  | "audit:read"
  | "adminlog:read"
  | "tokens:manage"
  | "users:manage"
  | "cache:invalidate";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  moderator: ["cases:read", "cases:write"],
  analityk: ["cases:read", "metrics:read", "export:read", "audit:read", "tokens:manage"],
  administrator: [
    "cases:read",
    "cases:write",
    "metrics:read",
    "export:read",
    "audit:read",
    "adminlog:read",
    "tokens:manage",
    "users:manage",
    "cache:invalidate",
  ],
};

/**
 * Token API (integracje: MCP, HTTP) ma rolę „analityk”, ale tylko do odczytu: nie tworzy tokenów,
 * nie zarządza użytkownikami i nie zmienia stanu. Wyciek tokenu nie daje więc trwałego dostępu.
 */
export const TOKEN_PERMISSIONS: readonly Permission[] = ["cases:read", "metrics:read", "export:read", "audit:read"];

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function tokenCan(permission: Permission): boolean {
  return TOKEN_PERMISSIONS.includes(permission);
}

/** "public" = bez logowania; "session" = każdy zalogowany użytkownik (tylko sesja, nie token API). */
export type EndpointPolicy = Permission | "public" | "session";

/** Klucz: „METODA /ścieżka” względem /api/admin (szablon trasy Hono). */
export const ADMIN_ENDPOINTS = {
  "POST /login": "public",
  "POST /logout": "session",
  "GET /me": "session",
  "GET /cases": "cases:read",
  "PATCH /cases/:id": "cases:write",
  "GET /metrics": "metrics:read",
  "GET /export.csv": "export:read",
  "GET /export.json": "export:read",
  "GET /audit/verify": "audit:read",
  "GET /audit-log": "adminlog:read",
  "GET /users": "users:manage",
  "POST /users": "users:manage",
  "DELETE /users/:username": "users:manage",
  "GET /tokens": "tokens:manage",
  "POST /tokens": "tokens:manage",
  "DELETE /tokens/:id": "tokens:manage",
  "POST /cache/invalidate": "cache:invalidate",
} as const satisfies Record<string, EndpointPolicy>;

export type AdminEndpointKey = keyof typeof ADMIN_ENDPOINTS;
