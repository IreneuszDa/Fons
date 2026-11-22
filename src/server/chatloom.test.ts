import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createServerContext } from "./context";
import { NO_REPORT_TEXT } from "./conversation/templates";
import { purgeRetention, SESSION_RETENTION_DAYS } from "./db";
import { makeEnv, makeReport, type TestEnv } from "./testkit";

const secret = "chatloom-fixture-secret";
const cfg = { chatloomWebhookSecret: secret };
const text = { msgtype: "m.text", body: "Ziemia jest okrągła." };
const room = "!fons:example.org";
const sender = "@contact:example.org";

function event(eventId: string, type = "m.room.message", content: Record<string, unknown> = text) {
  return { room_id: room, sender, event_id: eventId, origin_server_ts: 1795255200000, type, content };
}

const like = () => event("$like", "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$answer", key: "👍" } });

function post(env: TestEnv, body: object | string, { age = 0, key = secret, signedBody }: {
  age?: number; key?: string; signedBody?: string;
} = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(env.clock.now / 1000) - age);
  const signature = createHmac("sha256", key).update(timestamp + "." + (signedBody ?? raw)).digest("hex");
  return env.app.request("/api/channels/chatloom/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ChatLoom-Timestamp": timestamp, "X-ChatLoom-Signature": signature },
    body: raw,
  });
}

interface Action {
  txn_id: string;
  type: string;
  content: { body?: string };
}

async function actions(res: Response): Promise<Action[]> {
  expect(res.status).toBe(200);
  return (await res.json() as { actions: Action[] }).actions;
}

describe("konektor ChatLoom", () => {
  it("włącza się po konfiguracji, sprawdza podpis surowej treści i świeżość dostawy", async () => {
    const msg = event("$one");
    expect((await post(makeEnv(), msg)).status).toBe(501);
    const env = makeEnv({ cfg });
    expect((await post(env, msg, { key: "wrong" })).status).toBe(403);
    expect((await post(env, JSON.stringify(msg) + "\n", { signedBody: JSON.stringify(msg) })).status).toBe(403);
    for (const age of [-301, 301]) expect((await post(env, msg, { age })).status).toBe(403);
    expect((await post(env, "{")).status).toBe(400);
    expect((await post(env, { ...msg, room_id: null })).status).toBe(400);
    expect(env.calls).toHaveLength(0);
  });

  it("zwraca tekst i reakcję Matrix, a po restarcie zachowuje te same akcje oraz historię pokoju", async () => {
    const env = makeEnv({ cfg });
    const msg = event("$one");
    const original = await actions(await post(env, msg));
    expect(original).toMatchObject([
      { type: "m.room.message", content: { msgtype: "m.text", body: expect.any(String) } },
      { type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: msg.event_id, key: "✅" } } },
    ]);
    for (const action of original) expect(action.txn_id).toEqual(expect.any(String));
    expect(new Set(original.map(action => action.txn_id)).size).toBe(2);
    expect(env.calls).toMatchObject([{ channel: "chatloom", kind: "text", text: text.body }]);

    const db = new Database(env.db.serialize());
    try {
      const { cfg, engine, corpus, security, now } = env.ctx;
      const app = createApp(createServerContext({ cfg, db, engine, corpus, security, now, scryptN: 1024 }));
      const restarted = { ...env, app, db };
      expect(await actions(await post(restarted, msg))).toEqual(original);
      const followup = event("$sources", "m.room.message", { msgtype: "m.text", body: "źródła" });
      const same = await actions(await post(restarted, followup));
      expect(same[0]?.content.body).toContain("https://eli.gov.pl/akt/1");
      const other = await actions(await post(restarted, { ...followup, room_id: "!other:example.org", event_id: "$other" }));
      expect(other[0]?.content.body).toContain(NO_REPORT_TEXT);
      expect(env.calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("przy jednoczesnych dostawach uruchamia silnik raz i pozwala odtworzyć odpowiedź", async () => {
    const env = makeEnv({ cfg, engine: async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return makeReport();
    } });
    const msg = event("$concurrent");
    const deliveries = await Promise.all([post(env, msg), post(env, msg)]);
    expect(deliveries.some(res => res.status === 200)).toBe(true);
    const replay = await actions(await post(env, msg));
    for (const res of deliveries) {
      if (res.status === 503) continue;
      expect(await actions(res)).toEqual(replay);
    }
    expect(env.calls).toHaveLength(1);
    expect(env.db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 1 });
  });

  it("dobiera reakcję do wyniku sprawdzenia", async () => {
    const env = makeEnv({ cfg, engine: () => makeReport({ verdict: "FALSZYWE" }) });
    const result = await actions(await post(env, event("$false")));
    expect(result[1]).toMatchObject({
      type: "m.reaction", content: { "m.relates_to": { key: "❌", event_id: "$false" } },
    });
  });

  it.each([false, true])("uwzględnia wycofanie reakcji, także dostarczone przed dodaniem (%s)", async redactionFirst => {
    const env = makeEnv({ cfg });
    const add = like();
    const remove = redactionFirst
      ? { ...event("$remove", "m.room.redaction", {}), redacts: add.event_id }
      : event("$remove", "m.room.redaction", { redacts: add.event_id });
    const send = async (msg: object) => expect(await actions(await post(env, msg))).toEqual([]);
    const emojis = () => env.db.prepare("SELECT emoji FROM chatloom_reactions").all();
    if (redactionFirst) await send(remove);
    await send(add);
    if (!redactionFirst) {
      expect(emojis()).toEqual([{ emoji: "👍" }]);
      await send(remove);
    }
    await send(add);
    expect(emojis()).toEqual([{ emoji: null }]);
    expect(env.calls).toHaveLength(0);
  });

  it("ogranicza wycofanie reakcji do tego samego nadawcy i pokoju", async () => {
    const env = makeEnv({ cfg });
    const reaction = like();
    await actions(await post(env, reaction));
    const remove = event("$remove", "m.room.redaction", { redacts: reaction.event_id });
    for (const scope of [{ sender: "@inna:example.org" }, { room_id: "!inny:example.org" }]) {
      await actions(await post(env, { ...remove, ...scope }));
    }
    expect(env.db.prepare("SELECT emoji FROM chatloom_reactions WHERE emoji IS NOT NULL").all()).toEqual([{ emoji: "👍" }]);
  });

  it("odróżnia cytat w odpowiedzi Matrix od nowej wiadomości do sprawdzenia", async () => {
    const env = makeEnv({ cfg });
    const body = "> <@contact:example.org> Wcześniejsza wiadomość.\n> Druga linia cytatu.\n\n" + text.body;
    const reply = event("$quote", "m.room.message", {
      msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: "$prior" } },
    });
    await actions(await post(env, reply));
    expect(env.calls).toMatchObject([{ text: text.body }]);
  });

  it("po usunięciu danych ponowne dostawy nie odtwarzają odpowiedzi, sesji ani reakcji", async () => {
    const env = makeEnv({ cfg });
    const first = event("$one");
    const reaction = like();
    const redaction = event("$old-remove", "m.room.redaction", { redacts: "$old-reaction" });
    await actions(await post(env, first));
    await actions(await post(env, reaction));
    await actions(await post(env, redaction));
    const request = event("$forget", "m.room.message", { ...text, body: "Usuń moje dane" });
    const confirmation = event("$yes", "m.room.message", { ...text, body: "tak" });
    await actions(await post(env, request));
    expect((await actions(await post(env, confirmation)))[0]?.content.body).toContain("Usunąłem");
    expect(await actions(await post(env, first))).toEqual([]);
    expect(await actions(await post(env, reaction))).toEqual([]);
    expect(await actions(await post(env, redaction))).toEqual([]);
    expect(env.db.prepare("SELECT id FROM sessions").all()).toEqual([]);
    expect(env.db.prepare(`SELECT event_key FROM chatloom_reactions
      WHERE emoji IS NOT NULL OR sender_id IS NOT NULL OR session_id IS NOT NULL OR target_key IS NOT NULL`).all()).toEqual([]);
    expect(env.db.prepare("SELECT event_key FROM chatloom_replies WHERE sender_id IS NOT NULL OR session_id IS NOT NULL").all()).toEqual([]);
    expect(env.calls).toHaveLength(1);
  });

  it("czyści dane po okresie retencji i pomija ponowną synchronizację wygasłych zdarzeń", async () => {
    const env = makeEnv({ cfg });
    const first = event("$one");
    const reaction = like();
    await actions(await post(env, first));
    await actions(await post(env, reaction));
    env.advance((SESSION_RETENTION_DAYS + 1) * 86_400_000);
    purgeRetention(env.db, env.ctx.now());
    expect(await actions(await post(env, first))).toEqual([]);
    expect(await actions(await post(env, reaction))).toEqual([]);
    expect(env.db.prepare("SELECT event_key FROM chatloom_replies").all()).toEqual([]);
    expect(env.db.prepare("SELECT event_key FROM chatloom_reactions").all()).toEqual([]);
  });

  it("pomija edycje, szyfrogramy i zdarzenia członkostwa", async () => {
    const env = makeEnv({ cfg });
    const edit = event("$edit", "m.room.message", {
      ...text, "m.new_content": text, "m.relates_to": { rel_type: "m.replace", event_id: "$one" },
    });
    for (const msg of [edit, event("$encrypted", "m.room.encrypted", { ciphertext: "fixture" }), event("$member", "m.room.member", { membership: "join" })]) {
      expect(await actions(await post(env, msg))).toEqual([]);
    }
    expect(env.calls).toHaveLength(0);
  });
});
