import { describe, expect, it } from "vitest";
import { GENESIS_HASH, appendRun, eraseRunsForSender, verifyChain, type RunInput } from "./audit";
import { chat, makeEnv } from "./testkit";

function run(i: number, over: Partial<RunInput> = {}): RunInput {
  return {
    requestId: `req_${i}`,
    createdAt: `2026-11-21T10:00:0${i}.000Z`,
    channel: "web",
    inputKind: "text",
    inputMasked: `pytanie ${i}`,
    senderId: "sender-a",
    sessionId: "sess-a",
    status: "OK",
    verdict: "POTWIERDZONE",
    recordIds: [`eli:${i}`],
    models: [],
    timingsMs: { total: 10 },
    costUsd: 0.01,
    latencyMs: 12,
    cacheHit: false,
    securityEventCount: 0,
    unavailable: [],
    pipelineVersion: "t",
    snapshotId: "s",
    ...over,
  };
}

describe("dziennik audytu z łańcuchem SHA-256", () => {
  it("pusty i poprawny łańcuch się weryfikują; pierwszy wiersz wskazuje na genesis", () => {
    const env = makeEnv();
    expect(verifyChain(env.db)).toEqual({ ok: true, checked: 0 });
    for (let i = 0; i < 4; i++) appendRun(env.db, run(i));
    expect(verifyChain(env.db)).toEqual({ ok: true, checked: 4 });
    const first = env.db.prepare("SELECT prev_hash FROM runs ORDER BY seq LIMIT 1").get() as any;
    expect(first.prev_hash).toBe(GENESIS_HASH);
  });

  it("wykrywa zmianę statusu, werdyktu, kosztu i zamaskowanego wejścia", () => {
    for (const [col, val] of [
      ["status", "AWARIA"],
      ["verdict", "FALSZYWE"],
      ["cost_usd", 0],
      ["input_masked", "podmienione"],
      ["sender_id", "ktos-inny"],
    ] as const) {
      const env = makeEnv();
      for (let i = 0; i < 4; i++) appendRun(env.db, run(i));
      env.db.prepare(`UPDATE runs SET ${col} = ? WHERE request_id = 'req_2'`).run(val);
      const r = verifyChain(env.db);
      expect(r.ok, col).toBe(false);
      expect(r.brokenSeq, col).toBe(3);
    }
  });

  it("wykrywa usunięcie wiersza ze środka i przepięcie hashy", () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) appendRun(env.db, run(i));
    env.db.prepare("DELETE FROM runs WHERE request_id = 'req_2'").run();
    const r = verifyChain(env.db);
    expect(r).toMatchObject({ ok: false, reason: "prev_hash_mismatch" });
  });

  it("wykrywa nadpisanie hasha (próba „naprawienia” po manipulacji)", () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) appendRun(env.db, run(i));
    env.db.prepare("UPDATE runs SET status = 'AWARIA', hash = ? WHERE request_id = 'req_1'").run("f".repeat(64));
    expect(verifyChain(env.db).ok).toBe(false);
  });

  it("usunięcie danych nadawcy czyści pola osobowe, ale łańcuch pozostaje poprawny", () => {
    const env = makeEnv();
    appendRun(env.db, run(0));
    appendRun(env.db, run(1, { senderId: "sender-b", sessionId: "sess-b" }));
    appendRun(env.db, run(2));
    expect(eraseRunsForSender(env.db, "sender-a")).toBe(2);
    const rows = env.db.prepare("SELECT input_masked, sender_id, record_ids_json, salt FROM runs WHERE erased = 1").all() as any[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toEqual({ input_masked: "", sender_id: null, record_ids_json: "[]", salt: "" });
    expect(verifyChain(env.db)).toEqual({ ok: true, checked: 3 });
    // podmiana treści w wierszu NIEusuniętym nadal jest wykrywana
    env.db.prepare("UPDATE runs SET input_masked = 'x' WHERE sender_id = 'sender-b'").run();
    expect(verifyChain(env.db).ok).toBe(false);
  });

  it("przebiegi z rozmowy (cache, awaria, trafienie) tworzą poprawny łańcuch; log nie zawiera surowego PESEL", async () => {
    const env = makeEnv();
    await chat(env, { text: "Jan 12345678901 dostał mandat" });
    await chat(env, { text: "Jan 12345678901 dostał mandat" });
    const rows = env.db.prepare("SELECT input_masked, cache_hit FROM runs ORDER BY seq").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[1].cache_hit).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("12345678901");
    expect(verifyChain(env.db)).toMatchObject({ ok: true, checked: 2 });
  });
});
