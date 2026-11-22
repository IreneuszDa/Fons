import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../shared/contracts";
import {
  ensureLiveSnapshotsTable,
  getLiveSnapshot,
  LIVE_TTL_MS,
  purgeExpiredLiveSnapshots,
  reserveLiveRequest,
  saveLiveSnapshots,
} from "./live-store";

function rec(id: string, over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id,
    sourceId: "gov-pl",
    url: "https://www.gov.pl/web/x",
    title: "Tytuł",
    publisher: "Gov.pl",
    publishedAt: null,
    fetchedAt: "2026-11-21T10:00:00.000Z",
    lang: "pl",
    text: "Treść fragmentu strony.",
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: "gov",
    licence: "PD",
    topics: [],
    origin: "live_snapshot",
    ...over,
  };
}

const T0 = new Date("2026-11-21T10:00:00.000Z");

it("caps search attempts per UTC day even when no report or search snapshot exists", () => {
  const db = new BetterSqlite3(":memory:");
  expect(reserveLiveRequest(db, T0, 0)).toBe(false);
  expect(reserveLiveRequest(db, T0, 1)).toBe(true);
  expect(reserveLiveRequest(db, T0, 1)).toBe(false);
  expect(reserveLiveRequest(db, new Date("2026-11-22T00:00:00Z"), 1)).toBe(true);
  expect(reserveLiveRequest(db, T0, 1)).toBe(false);
  expect(db.prepare("SELECT day, requests FROM web_search_quota").all()).toEqual([{ day: "2026-11-22", requests: 1 }]);
  db.close();
});

describe("live_snapshots", () => {
  it("tworzy tabelę idempotentnie", () => {
    const db = new BetterSqlite3(":memory:");
    ensureLiveSnapshotsTable(db);
    ensureLiveSnapshotsTable(db);
    const cols = (db.prepare("PRAGMA table_info(live_snapshots)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "run_id", "record_json", "created_at", "expires_at"]);
  });

  it("zapisuje i odczytuje rekord, TTL 48 h", () => {
    const db = new BetterSqlite3(":memory:");
    expect(saveLiveSnapshots(db, "run1", [rec("live:abc")], T0)).toBe(1);
    expect(getLiveSnapshot(db, "live:abc", T0)?.title).toBe("Tytuł");
    const row = db.prepare("SELECT run_id, expires_at FROM live_snapshots").get() as { run_id: string; expires_at: string };
    expect(row.run_id).toBe("run1");
    expect(Date.parse(row.expires_at) - T0.getTime()).toBe(LIVE_TTL_MS);
    expect(getLiveSnapshot(db, "live:abc", new Date(T0.getTime() + LIVE_TTL_MS + 1))).toBeUndefined();
  });

  it("ten sam id odświeża wiersz zamiast go dublować", () => {
    const db = new BetterSqlite3(":memory:");
    saveLiveSnapshots(db, "run1", [rec("live:abc")], T0);
    saveLiveSnapshots(db, "run2", [rec("live:abc")], new Date(T0.getTime() + 1000));
    expect((db.prepare("SELECT COUNT(*) n FROM live_snapshots").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT run_id FROM live_snapshots").get() as { run_id: string }).run_id).toBe("run2");
  });

  it("odrzuca rekordy spoza przestrzeni live (origin / prefiks id)", () => {
    const db = new BetterSqlite3(":memory:");
    expect(() => saveLiveSnapshots(db, "r", [rec("gov:1")], T0)).toThrow();
    expect(() => saveLiveSnapshots(db, "r", [rec("live:1", { origin: "corpus" })], T0)).toThrow();
    expect((db.prepare("SELECT COUNT(*) n FROM live_snapshots").get() as { n: number }).n).toBe(0);
  });

  it("purge usuwa wygasłe; odczyt nie zwraca id spoza live: ani przy braku tabeli", () => {
    const db = new BetterSqlite3(":memory:");
    expect(getLiveSnapshot(db, "live:x", T0)).toBeUndefined();
    saveLiveSnapshots(db, "r", [rec("live:old")], T0);
    expect(purgeExpiredLiveSnapshots(db, new Date(T0.getTime() + LIVE_TTL_MS + 1))).toBe(1);
    expect(getLiveSnapshot(db, "gov:1", T0)).toBeUndefined();
  });
});
