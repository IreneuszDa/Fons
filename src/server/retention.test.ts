import { describe, expect, it } from "vitest";
import { purgeRetention } from "./db";
import { makeEnv } from "./testkit";

const DAY = 86_400_000;

describe("retencja: live_snapshots", () => {
  it("bez tabeli live_snapshots retencja działa i zgłasza 0", () => {
    const env = makeEnv();
    expect(purgeRetention(env.db, new Date(env.clock.now)).liveSnapshots).toBe(0);
  });

  it("usuwa tylko wygasłe wiersze (expires_at tekst ISO)", () => {
    const env = makeEnv();
    env.db.exec("CREATE TABLE live_snapshots (id TEXT PRIMARY KEY, run_id TEXT, expires_at TEXT NOT NULL, text TEXT)");
    const now = new Date(env.clock.now);
    const ins = env.db.prepare("INSERT INTO live_snapshots VALUES (?, 'r', ?, 't')");
    ins.run("old", new Date(now.getTime() - DAY).toISOString());
    ins.run("old2", new Date(now.getTime() - 1000).toISOString());
    ins.run("fresh", new Date(now.getTime() + DAY).toISOString());
    expect(purgeRetention(env.db, now).liveSnapshots).toBe(2);
    expect((env.db.prepare("SELECT id FROM live_snapshots").all() as any[]).map((r) => r.id)).toEqual(["fresh"]);
  });

  it("expires_at liczbowe (sekundy lub milisekundy) nie kasuje wszystkiego", () => {
    const env = makeEnv();
    env.db.exec("CREATE TABLE live_snapshots (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    const now = new Date(env.clock.now);
    const ins = env.db.prepare("INSERT INTO live_snapshots VALUES (?, ?)");
    ins.run("old-ms", now.getTime() - DAY);
    ins.run("old-s", Math.floor((now.getTime() - DAY) / 1000));
    ins.run("fresh-ms", now.getTime() + DAY);
    ins.run("fresh-s", Math.floor((now.getTime() + DAY) / 1000));
    expect(purgeRetention(env.db, now).liveSnapshots).toBe(2);
    expect((env.db.prepare("SELECT id FROM live_snapshots ORDER BY id").all() as any[]).map((r) => r.id)).toEqual(["fresh-ms", "fresh-s"]);
  });

  it("tabela bez kolumny expires_at jest pomijana", () => {
    const env = makeEnv();
    env.db.exec("CREATE TABLE live_snapshots (id TEXT PRIMARY KEY, ttl TEXT)");
    env.db.prepare("INSERT INTO live_snapshots VALUES ('a', 'x')").run();
    expect(purgeRetention(env.db, new Date(env.clock.now)).liveSnapshots).toBe(0);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM live_snapshots").get() as any).n).toBe(1);
  });
});

describe("migracja", () => {
  it("starsza baza bez kolumny note dostaje ją, dane zostają", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { migrate } = await import("./db");
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE moderator_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, representative_text TEXT NOT NULL, claim_norm TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', sender_count INTEGER NOT NULL DEFAULT 0, channels_json TEXT NOT NULL DEFAULT '[]',
      alert_state TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare("INSERT INTO moderator_cases (representative_text, claim_norm, created_at, updated_at) VALUES ('a','a','t','t')").run();
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT note FROM moderator_cases").get()).toEqual({ note: "" });
  });
});
