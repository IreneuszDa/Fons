/**
 * Użytkownicy panelu: plik JSON (var/users.json, tryb 0600) z hasłami zahaszowanymi scrypt.
 * Bez ścieżki pliku sklep działa w pamięci (testy). Plik jest sprawdzany po mtime przy każdym odczycie,
 * więc `npm run user -- add …` działa bez restartu serwera, a usunięty użytkownik traci dostęp od razu.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_SCRYPT_N, dummyHash, hashPassword, hashPasswordSync, passwordProblem, verifyPassword } from "./passwords";
import { ROLES, isRole, type Role } from "./permissions";

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface PublicUser {
  username: string;
  role: Role;
  createdAt: string;
}

interface StoredUser extends PublicUser {
  passwordHash: string;
}

export type UserErrorCode = "exists" | "invalid_username" | "invalid_role" | "weak_password" | "not_found" | "last_admin";

export class UserError extends Error {
  constructor(readonly code: UserErrorCode, message: string) {
    super(message);
    this.name = "UserError";
  }
}

const FileSchema = z.object({
  version: z.literal(1),
  users: z.array(
    z.object({
      username: z.string().regex(USERNAME_RE),
      role: z.enum(ROLES),
      passwordHash: z.string().min(20),
      createdAt: z.string(),
    }),
  ),
});

export function normalizeUsername(raw: string): string | undefined {
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : undefined;
}

export interface UserStore {
  list(): PublicUser[];
  get(username: string): PublicUser | undefined;
  add(p: { username: string; role: string; password: string }): Promise<PublicUser>;
  remove(username: string): PublicUser;
  setPassword(username: string, password: string): Promise<void>;
  /** Zwraca użytkownika albo null; czas odpowiedzi nie zależy od tego, czy login istnieje. */
  authenticate(username: string, password: string): Promise<PublicUser | null>;
  /** Pierwszy start: jeśli nie ma żadnego użytkownika, tworzy „admin” (administrator) z podanym hasłem. */
  ensureBootstrapAdmin(password: string): { created: boolean };
  readonly path?: string;
}

export interface UserStoreOptions {
  /** Ścieżka pliku; brak = pamięć. */
  path?: string;
  now?: () => Date;
  /** Koszt scrypt dla nowych haseł (testy: mały). */
  scryptN?: number;
}

const pub = (u: StoredUser): PublicUser => ({ username: u.username, role: u.role, createdAt: u.createdAt });

export function createUserStore(opts: UserStoreOptions = {}): UserStore {
  const now = opts.now ?? (() => new Date());
  const cost = opts.scryptN ?? DEFAULT_SCRYPT_N;
  const path = opts.path;
  let users = new Map<string, StoredUser>();
  let seen = { mtimeMs: -1, size: -1 };
  let loadedOnce = false;

  function readFile(): void {
    if (!path) return;
    let st;
    try {
      st = statSync(path);
    } catch {
      if (loadedOnce) users = new Map();
      seen = { mtimeMs: -1, size: -1 };
      loadedOnce = true;
      return;
    }
    if (st.mtimeMs === seen.mtimeMs && st.size === seen.size && loadedOnce) return;
    const raw = readFileSync(path, "utf8");
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("users_file_invalid");
    users = new Map(parsed.data.users.map((u) => [u.username, u]));
    seen = { mtimeMs: st.mtimeMs, size: st.size };
    loadedOnce = true;
  }

  /** Odświeża z pliku; przy uszkodzonym pliku w trakcie pracy zostaje poprzedni stan (start rzuca wyjątek). */
  function refresh(strict = false): void {
    try {
      readFile();
    } catch (e) {
      if (strict || !loadedOnce) throw e;
    }
  }

  function persist(): void {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify({ version: 1, users: [...users.values()] }, null, 2);
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* system plików bez uprawnień */
    }
    const st = statSync(path);
    seen = { mtimeMs: st.mtimeMs, size: st.size };
  }

  function validate(p: { username: string; role: string; password: string }): { username: string; role: Role } {
    const username = normalizeUsername(p.username);
    if (!username) {
      throw new UserError("invalid_username", "Nazwa użytkownika: 2–32 znaki, małe litery, cyfry, kropka, myślnik lub podkreślenie.");
    }
    if (!isRole(p.role)) throw new UserError("invalid_role", "Nieznana rola.");
    const problem = passwordProblem(p.password);
    if (problem) throw new UserError("weak_password", problem);
    return { username, role: p.role };
  }

  if (path && existsSync(path)) refresh(true);

  return {
    path,
    list() {
      refresh();
      return [...users.values()].map(pub).sort((a, b) => a.username.localeCompare(b.username));
    },
    get(username) {
      refresh();
      const u = users.get(username.trim().toLowerCase());
      return u ? pub(u) : undefined;
    },
    async add(p) {
      const { username, role } = validate(p);
      refresh();
      if (users.has(username)) throw new UserError("exists", "Taki użytkownik już istnieje.");
      const passwordHash = await hashPassword(p.password, { N: cost });
      refresh();
      if (users.has(username)) throw new UserError("exists", "Taki użytkownik już istnieje.");
      const rec: StoredUser = { username, role, passwordHash, createdAt: now().toISOString() };
      users.set(username, rec);
      persist();
      return pub(rec);
    },
    remove(username) {
      refresh();
      const key = username.trim().toLowerCase();
      const u = users.get(key);
      if (!u) throw new UserError("not_found", "Nie ma takiego użytkownika.");
      if (u.role === "administrator" && [...users.values()].filter((x) => x.role === "administrator").length <= 1) {
        throw new UserError("last_admin", "Nie można usunąć ostatniego administratora.");
      }
      users.delete(key);
      persist();
      return pub(u);
    },
    async setPassword(username, password) {
      const problem = passwordProblem(password);
      if (problem) throw new UserError("weak_password", problem);
      refresh();
      const key = username.trim().toLowerCase();
      if (!users.has(key)) throw new UserError("not_found", "Nie ma takiego użytkownika.");
      const passwordHash = await hashPassword(password, { N: cost });
      refresh();
      const u = users.get(key);
      if (!u) throw new UserError("not_found", "Nie ma takiego użytkownika.");
      users.set(key, { ...u, passwordHash });
      persist();
    },
    async authenticate(username, password) {
      refresh();
      const u = users.get(username.trim().toLowerCase());
      // Zawsze jedno haszowanie, także dla nieznanego loginu (brak różnicy czasu).
      const ok = await verifyPassword(password, u?.passwordHash ?? dummyHash(cost));
      return u && ok ? pub(u) : null;
    },
    ensureBootstrapAdmin(password) {
      refresh();
      if (users.size > 0) return { created: false };
      users.set("admin", {
        username: "admin",
        role: "administrator",
        passwordHash: hashPasswordSync(password, { N: cost }),
        createdAt: now().toISOString(),
      });
      persist();
      return { created: true };
    },
  };
}
