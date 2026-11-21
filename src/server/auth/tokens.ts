/**
 * Tokeny API integracji (MCP, HTTP, /metrics). Token = `fons_` + 32 losowe bajty base64url.
 * W bazie leży tylko SHA-256 tokenu; sam token pokazujemy raz, przy utworzeniu. Rola zawsze „analityk”.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../context";
import type { Role } from "./permissions";
import { sha256Hex } from "../util";

export const TOKEN_PREFIX = "fons_";
export const MAX_TOKENS = 50;
const LAST_USED_GRANULARITY_MS = 60_000;

export interface TokenInfo {
  id: string;
  label: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface TokenPrincipal {
  id: string;
  label: string;
  role: Role;
}

export interface TokenStore {
  create(p: { label: string; createdBy: string }): { info: TokenInfo; token: string };
  list(): TokenInfo[];
  revoke(id: string): TokenInfo | undefined;
  /** Sprawdza surowy token; przy sukcesie odnotowuje użycie (co najwyżej raz na minutę). */
  authenticate(raw: string): TokenPrincipal | null;
  count(): number;
}

interface Row {
  id: string;
  label: string;
  token_hash: string;
  role: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

const info = (r: Row): TokenInfo => ({
  id: r.id,
  label: r.label,
  role: r.role as Role,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export class TokenLimitError extends Error {
  constructor() {
    super("token_limit");
    this.name = "TokenLimitError";
  }
}

export function createTokenStore(db: Db, now: () => Date = () => new Date()): TokenStore {
  return {
    create({ label, createdBy }) {
      if (this.count() >= MAX_TOKENS) throw new TokenLimitError();
      const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const id = `tok_${randomBytes(6).toString("hex")}`;
      const createdAt = now().toISOString();
      db.prepare(
        "INSERT INTO api_tokens (id, label, token_hash, role, created_by, created_at, last_used_at) VALUES (?, ?, ?, 'analityk', ?, ?, NULL)",
      ).run(id, label, sha256Hex(token), createdBy, createdAt);
      return { token, info: { id, label, role: "analityk", createdBy, createdAt, lastUsedAt: null } };
    },
    list() {
      return (db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC, id").all() as Row[]).map(info);
    },
    revoke(id) {
      const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as Row | undefined;
      if (!row) return undefined;
      db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id);
      return info(row);
    },
    authenticate(raw) {
      if (!raw.startsWith(TOKEN_PREFIX) || raw.length > 128) return null;
      const hash = sha256Hex(raw);
      const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash) as Row | undefined;
      if (!row) return null;
      // Porównanie skrótów w stałym czasie (zapytanie po indeksie nie zastępuje tej kontroli).
      if (!timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(hash, "hex"))) return null;
      const t = now();
      if (!row.last_used_at || t.getTime() - Date.parse(row.last_used_at) >= LAST_USED_GRANULARITY_MS) {
        db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(t.toISOString(), row.id);
      }
      return { id: row.id, label: row.label, role: row.role as Role };
    },
    count() {
      return (db.prepare("SELECT COUNT(*) AS n FROM api_tokens").get() as { n: number }).n;
    },
  };
}

/** Wyciąga token z nagłówka `Authorization: Bearer …`. */
export function bearerFrom(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S{1,512})\s*$/i.exec(header);
  return m?.[1];
}
