import { describe, expect, it } from "vitest";
import { appendRun, verifyChain } from "./audit";
import { migrate, purgeRetention } from "./db";
import { makeEnv } from "./testkit";

const DAY = 86_400_000;

describe("schemat i retencja", () => {
  it("migrate jest idempotentne", () => {
    const env = makeEnv();
    expect(() => migrate(env.db)).not.toThrow();
    expect(() => migrate(env.db)).not.toThrow();
    const names = (env.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["sessions", "reports", "runs", "security_events", "computation_cache", "moderator_cases", "case_senders", "alerts_log", "token_usage"]) {
      expect(names).toContain(t);
    }
  });

  it("usuwa przebiegi starsze niż 30 dni i sesje starsze niż 7 dni; łańcuch pozostaje poprawny", () => {
    const env = makeEnv();
    const now = new Date(env.clock.now);
    const mk = (i: number, ageDays: number) =>
      appendRun(env.db, {
        requestId: `r${i}`,
        createdAt: new Date(now.getTime() - ageDays * DAY).toISOString(),
        channel: "web",
        inputKind: "text",
        inputMasked: "x",
        senderId: "s",
        sessionId: "ss",
        status: "OK",
        verdict: "POTWIERDZONE",
        recordIds: [],
        models: [],
        timingsMs: {},
        costUsd: 0,
        latencyMs: 1,
        cacheHit: false,
        securityEventCount: 0,
        unavailable: [],
        pipelineVersion: "t",
        snapshotId: "s",
      });
    mk(1, 40);
    mk(2, 35);
    mk(3, 10);
    mk(4, 1);
    const ins = env.db.prepare("INSERT INTO sessions (id, sender_id, channel, created_at, last_seen) VALUES (?, 's', 'web', ?, ?)");
    ins.run("old", new Date(now.getTime() - 8 * DAY).toISOString(), new Date(now.getTime() - 8 * DAY).toISOString());
    ins.run("new", new Date(now.getTime() - 6 * DAY).toISOString(), new Date(now.getTime() - 6 * DAY).toISOString());
    const res = purgeRetention(env.db, now);
    expect(res.runs).toBe(2);
    expect(res.sessions).toBe(1);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as any).n).toBe(2);
    expect((env.db.prepare("SELECT id FROM sessions").all() as any[]).map((r) => r.id)).toEqual(["new"]);
    expect(verifyChain(env.db)).toEqual({ ok: true, checked: 2 });
  });

  it("usuwa wygasłe raporty i wpisy cache", () => {
    const env = makeEnv();
    const now = new Date(env.clock.now);
    env.db.prepare("INSERT INTO reports (token, report_id, sender_id, report_json, created_at, expires_at) VALUES ('t1','r','s','{}',?,?)").run(now.toISOString(), new Date(now.getTime() - 1000).toISOString());
    env.db.prepare("INSERT INTO computation_cache (cache_key, report_json, created_at, expires_at) VALUES ('k','{}',?,?)").run(now.toISOString(), new Date(now.getTime() - 1000).toISOString());
    const res = purgeRetention(env.db, now);
    expect(res).toMatchObject({ reports: 1, cache: 1 });
  });
});
