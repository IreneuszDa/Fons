import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createAdminLog } from "./auth/adminlog";
import { dummyHash, hashPassword, hashPasswordSync, parseHash, verifyPassword } from "./auth/passwords";
import { ROLES, ROLE_PERMISSIONS, TOKEN_PERMISSIONS, roleCan } from "./auth/permissions";
import { createTokenStore } from "./auth/tokens";
import { UserError, createUserStore } from "./auth/users";
import { migrate } from "./db";

const COST = { N: 1024 };

describe("hasła (scrypt)", () => {
  it("skrót ma format scrypt$N$r$p$sól$skrót, sól jest losowa, weryfikacja działa", async () => {
    const a = await hashPassword("tajne-haslo-123", COST);
    const b = await hashPassword("tajne-haslo-123", COST);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("tajne-haslo-123");
    expect(await verifyPassword("tajne-haslo-123", a)).toBe(true);
    expect(await verifyPassword("tajne-haslo-124", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("wersja synchroniczna jest zgodna z asynchroniczną; uszkodzony skrót nie przechodzi", async () => {
    const h = hashPasswordSync("abcdefghij", COST);
    expect(await verifyPassword("abcdefghij", h)).toBe(true);
    for (const bad of ["", "plain", "scrypt$1$8$1$AA==$AA==", "scrypt$1024$8$1$AAAAAAAAAAAA$AA==", "bcrypt$1024$8$1$a$b", `${h}$extra`]) {
      expect(parseHash(bad), bad).toBeUndefined();
      expect(await verifyPassword("abcdefghij", bad)).toBe(false);
    }
    expect(() => hashPasswordSync("x", { N: 1000 })).toThrow(); // nie potęga dwójki
  });

  it("skrót atrapa jest poprawny i nie pasuje do niczego", async () => {
    expect(await verifyPassword("cokolwiek", dummyHash(1024))).toBe(false);
  });
});

describe("macierz uprawnień", () => {
  it("moderator ⊂ analityk-lub-administrator wg specyfikacji; administrator ma wszystko", () => {
    expect(ROLE_PERMISSIONS.moderator).toEqual(["cases:read", "cases:write"]);
    expect(roleCan("analityk", "cases:write")).toBe(false);
    expect(roleCan("analityk", "tokens:manage")).toBe(true);
    expect(roleCan("analityk", "users:manage")).toBe(false);
    expect(roleCan("moderator", "metrics:read")).toBe(false);
    expect(roleCan("moderator", "tokens:manage")).toBe(false);
    const all = new Set(ROLES.flatMap((r) => ROLE_PERMISSIONS[r]));
    for (const p of all) expect(roleCan("administrator", p), p).toBe(true);
  });
  it("token API ma tylko uprawnienia odczytu", () => {
    for (const p of TOKEN_PERMISSIONS) expect(p).toMatch(/:read$/);
    expect(TOKEN_PERMISSIONS).not.toContain("tokens:manage");
  });
});

describe("sklep użytkowników", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "fons-users-")), "var", "users.json");

  it("pierwszy start tworzy konto admin; ponowne wywołanie niczego nie zmienia; plik ma tryb 0600 i same skróty", async () => {
    const path = tmp();
    const store = createUserStore({ path, scryptN: 1024 });
    expect(store.ensureBootstrapAdmin("haslo-startowe-1")).toEqual({ created: true });
    expect(store.ensureBootstrapAdmin("inne-haslo-123")).toEqual({ created: false });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("haslo-startowe-1");
    expect(raw).toContain("scrypt$");
    expect(await store.authenticate("admin", "haslo-startowe-1")).toMatchObject({ username: "admin", role: "administrator" });
    expect(await store.authenticate("admin", "inne-haslo-123")).toBeNull();
    expect(await store.authenticate("ADMIN", "haslo-startowe-1")).not.toBeNull(); // login bez rozróżniania wielkości liter
    expect(await store.authenticate("nikt", "haslo-startowe-1")).toBeNull();
  });

  it("dane przeżywają restart; zmiana pliku z zewnątrz (CLI) jest widoczna bez restartu", async () => {
    const path = tmp();
    const a = createUserStore({ path, scryptN: 1024 });
    a.ensureBootstrapAdmin("haslo-startowe-1");
    await a.add({ username: "ola", role: "analityk", password: "dlugie-haslo-123" });
    const b = createUserStore({ path, scryptN: 1024 }); // „nowy proces”
    expect(b.list().map((u) => u.username)).toEqual(["admin", "ola"]);
    // drugi „proces” (CLI) dopisuje użytkownika
    await b.add({ username: "ewa", role: "moderator", password: "dlugie-haslo-123" });
    expect(a.get("ewa")).toMatchObject({ role: "moderator" });
    b.remove("ewa");
    expect(a.get("ewa")).toBeUndefined();
  });

  it("uszkodzony plik przy starcie to błąd (nie tworzymy po cichu nowego admina)", () => {
    const path = tmp();
    createUserStore({ path, scryptN: 1024 }).ensureBootstrapAdmin("haslo-startowe-1");
    writeFileSync(path, "{ to nie jest json");
    expect(() => createUserStore({ path, scryptN: 1024 })).toThrow();
    writeFileSync(path, JSON.stringify({ version: 1, users: [{ username: "x", role: "szef", passwordHash: "a".repeat(30), createdAt: "" }] }));
    expect(() => createUserStore({ path, scryptN: 1024 })).toThrow();
  });

  it("walidacja nazw, ról i haseł oraz ochrona ostatniego administratora", async () => {
    const store = createUserStore({ scryptN: 1024 });
    store.ensureBootstrapAdmin("haslo-startowe-1");
    const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as UserError).code;
    expect(await code(store.add({ username: "a", role: "moderator", password: "dlugie-haslo-123" }))).toBe("invalid_username");
    expect(await code(store.add({ username: "../etc", role: "moderator", password: "dlugie-haslo-123" }))).toBe("invalid_username");
    expect(await code(store.add({ username: "ola", role: "root", password: "dlugie-haslo-123" }))).toBe("invalid_role");
    expect(await code(store.add({ username: "ola", role: "moderator", password: "krotkie" }))).toBe("weak_password");
    await store.add({ username: "ola", role: "moderator", password: "dlugie-haslo-123" });
    expect(await code(store.add({ username: "OLA", role: "moderator", password: "dlugie-haslo-123" }))).toBe("exists");
    expect(() => store.remove("admin")).toThrowError(/ostatniego administratora/);
    await store.setPassword("ola", "nowe-dlugie-haslo-1");
    expect(await store.authenticate("ola", "dlugie-haslo-123")).toBeNull();
    expect(await store.authenticate("ola", "nowe-dlugie-haslo-1")).not.toBeNull();
  });
});

describe("tokeny API (sklep)", () => {
  function setup() {
    const db = new Database(":memory:");
    migrate(db);
    const clock = { t: Date.parse("2026-11-21T10:00:00Z") };
    return { db, clock, store: createTokenStore(db, () => new Date(clock.t)) };
  }

  it("losowy token fons_ + 32 bajty base64url; w bazie tylko SHA-256", () => {
    const { db, store } = setup();
    const a = store.create({ label: "A", createdBy: "admin" });
    const b = store.create({ label: "B", createdBy: "admin" });
    expect(a.token).toMatch(/^fons_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    const rows = db.prepare("SELECT * FROM api_tokens").all() as any[];
    expect(rows.map((r) => r.token_hash)).not.toContain(a.token);
    expect(JSON.stringify(rows)).not.toContain(a.token);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.role === "analityk")).toBe(true);
  });

  it("uwierzytelnianie, last_used_at (raz na minutę), odwołanie", () => {
    const { store, clock } = setup();
    const { token, info } = store.create({ label: "Grafana", createdBy: "admin" });
    expect(store.authenticate(token)).toEqual({ id: info.id, label: "Grafana", role: "analityk" });
    expect(store.list()[0]!.lastUsedAt).toBe(new Date(clock.t).toISOString());
    clock.t += 10_000;
    store.authenticate(token);
    expect(store.list()[0]!.lastUsedAt).toBe("2026-11-21T10:00:00.000Z"); // bez zbędnych zapisów
    clock.t += 60_000;
    store.authenticate(token);
    expect(store.list()[0]!.lastUsedAt).toBe("2026-11-21T10:01:10.000Z");
    expect(store.authenticate(token + "x")).toBeNull();
    expect(store.authenticate("fons_" + "A".repeat(43))).toBeNull();
    expect(store.authenticate("")).toBeNull();
    expect(store.revoke(info.id)?.id).toBe(info.id);
    expect(store.authenticate(token)).toBeNull();
    expect(store.revoke(info.id)).toBeUndefined();
  });
});

describe("dziennik administratora: łańcuch hashy", () => {
  function setup() {
    const db = new Database(":memory:");
    migrate(db);
    const log = createAdminLog(db, () => new Date("2026-11-21T10:00:00Z"));
    for (let i = 1; i <= 5; i++) log.append({ actor: "admin", role: "administrator", action: "case.update", target: `#${i}`, detail: "status:open->closed" });
    return { db, log };
  }

  it("nienaruszony łańcuch się weryfikuje, headHash jest stabilny", () => {
    const { log } = setup();
    const v = log.verify();
    expect(v).toMatchObject({ ok: true, checked: 5 });
    expect(v.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.verify().headHash).toBe(v.headHash);
    expect(log.list(2).map((e) => e.target)).toEqual(["#5", "#4"]);
  });

  it("zmiana treści wiersza zrywa łańcuch", () => {
    const { db, log } = setup();
    db.prepare("UPDATE admin_audit SET actor = 'ktos-inny' WHERE seq = 3").run();
    expect(log.verify()).toMatchObject({ ok: false, brokenSeq: 3, reason: "hash_mismatch" });
  });

  it("usunięcie wiersza ze środka, z początku i przestawienie skrótów są wykrywane", () => {
    const mid = setup();
    mid.db.prepare("DELETE FROM admin_audit WHERE seq = 3").run();
    expect(mid.log.verify()).toMatchObject({ ok: false, brokenSeq: 4, reason: "prev_hash_mismatch" });

    const head = setup();
    head.db.prepare("DELETE FROM admin_audit WHERE seq = 1").run();
    expect(head.log.verify()).toMatchObject({ ok: false, brokenSeq: 2 });

    // przeliczenie skrótu zmienionego wiersza nie ukrywa zmiany: następny wiersz wskazuje na stary skrót
    const re = setup();
    re.db.prepare("UPDATE admin_audit SET action = 'x', hash = ? WHERE seq = 2").run("f".repeat(64));
    expect(re.log.verify().ok).toBe(false);
  });

  it("pola są przycinane, a pusty dziennik jest poprawny", () => {
    const db = new Database(":memory:");
    migrate(db);
    const log = createAdminLog(db);
    expect(log.verify()).toMatchObject({ ok: true, checked: 0 });
    log.append({ actor: "a".repeat(500), role: "administrator", action: "x", detail: "d".repeat(1000) });
    const e = log.list(1)[0]!;
    expect(e.actor).toHaveLength(80);
    expect(e.detail).toHaveLength(300);
    expect(log.verify().ok).toBe(true);
  });
});
