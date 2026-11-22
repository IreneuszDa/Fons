import { describe, expect, it } from "vitest";
import { verifyChain } from "./audit";
import { purgeRetention } from "./db";
import { createSession, newSessionId, saveSessionState } from "./sessions";
import { chat, makeEnv, makeReport, type TestEnv } from "./testkit";
import type { ChatDetail, ChatSummary } from "../shared/chat";

const path = "/api/chats";
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

function http(env: TestEnv, method: string, url: string, cookie?: string) {
  return env.app.request(url, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(method === "POST" && { body: "{}" }) });
}

async function newThread(env: TestEnv, cookie?: string) {
  const response = await http(env, "POST", path, cookie);
  expect(response.status).toBe(201);
  return { ...(await response.json() as { chat: ChatSummary }), cookie: cookieOf(response) };
}

async function detail(env: TestEnv, cookie: string, id: string) {
  const response = await http(env, "GET", path + "/" + id, cookie);
  expect(response.status).toBe(200);
  return await response.json() as ChatDetail;
}

const count = (env: TestEnv, table: string) => (env.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("prywatna historia czatów WWW", () => {
  it("wznawia wybrany czat z jego raportem, tytułem i akcjami; usunięcie usuwa tylko ten czat", async () => {
    const env = makeEnv();
    const initial = await http(env, "GET", path);
    expect(await initial.json()).toEqual({ chats: [] });
    const cookie = cookieOf(initial);
    expect(cookieOf(await http(env, "GET", path, cookie))).toBe(cookie);
    const first = (await newThread(env, cookie)).chat;
    expect(first.title).toBe("Nowy czat");
    const one = await chat(env, { sessionId: first.id, text: "Pierwsze pytanie o budżet" }, cookie);
    env.advance(1000);
    const second = (await newThread(env, cookie)).chat;
    const two = await chat(env, { sessionId: second.id, text: "Drugie pytanie o koszty biletów" }, cookie);
    const list = await (await http(env, "GET", path, cookie)).json() as { chats: ChatSummary[] };
    expect(list.chats.map(c => [c.id, c.title])).toEqual([[second.id, "Drugie pytanie o koszty biletów"], [first.id, "Pierwsze pytanie o budżet"]]);

    const followup = await chat(env, { sessionId: first.id, action: "why" }, cookie);
    expect(followup.json.reply.resultUrl).toBe(one.json.reply.resultUrl);
    const saved = await detail(env, cookie, first.id);
    expect(saved.entries).toMatchObject([
      { role: "user", text: "Pierwsze pytanie o budżet" },
      { role: "assistant", reply: { kind: "verdict", report: { token: one.json.reply.report.token }, quickReplies: one.json.reply.quickReplies } },
      { role: "user", text: "Jak to sprawdziłeś?" }, { role: "assistant", reply: { kind: "why" } },
    ]);
    expect((await http(env, "DELETE", path + "/" + first.id, cookie)).status).toBe(200);
    expect((await http(env, "GET", path + "/" + first.id, cookie)).status).toBe(404);
    expect((await http(env, "GET", "/api/report/" + one.json.reply.report.token)).status).toBe(404);
    expect((await http(env, "GET", "/api/report/" + two.json.reply.report.token)).status).toBe(200);
    expect(count(env, "web_chat_turns")).toBe(1);
    expect((await detail(env, cookie, second.id)).entries).toHaveLength(2);
    expect(verifyChain(env.db).ok).toBe(true);
    await http(env, "DELETE", "/api/session", cookie);
    expect(count(env, "web_chat_turns")).toBe(0);
  });

  it("identyfikator nie jest poświadczeniem; obcy właściciel nie odczyta, nie usunie i nie wznowi czatu", async () => {
    const env = makeEnv();
    const a = await newThread(env);
    const b = await newThread(env);
    for (const other of [b.cookie, undefined, "pw_sid=" + a.chat.id]) {
      expect((await http(env, "GET", path + "/" + a.chat.id, other)).status).toBe(404);
      expect((await http(env, "DELETE", path + "/" + a.chat.id, other)).status).toBe(404);
      expect((await chat(env, { text: "Kontynuacja", sessionId: a.chat.id }, other)).status).toBe(404);
    }
    expect((await detail(env, a.cookie, a.chat.id)).chat.id).toBe(a.chat.id);
    expect(count(env, "sessions")).toBe(2);
    expect((await env.app.request(path + "/" + a.chat.id, { method: "DELETE", headers: { cookie: a.cookie, origin: "https://inny.example" } })).status).toBe(403);
  });

  it("zachowuje zamaskowaną wiadomość i nazwę dokumentu bez danych pliku lub prywatnych parametrów", async () => {
    const env = makeEnv();
    const a = await newThread(env);
    const base64 = Buffer.from("Prywatna treść samego załącznika").toString("base64");
    await chat(env, { sessionId: a.chat.id, text: "Sprawdź test@przyklad.pl i https://urzad.example/pismo?sekret=ukryty",
      document: { mime: "text/plain", base64 }, fileName: "pismo.pdf" }, a.cookie);
    const saved = await detail(env, a.cookie, a.chat.id);
    expect(saved.entries[0]).toMatchObject({ role: "user", fileName: "pismo.pdf", text: expect.stringContaining("[EMAIL]") });
    expect(saved.chat.title).not.toMatch(/test@przyklad|sekret=ukryty/);
    expect(JSON.stringify(saved)).not.toContain("sekret=ukryty");
    const stored = JSON.stringify(env.db.prepare("SELECT * FROM web_chat_turns").all());
    expect(stored).not.toMatch(/test@przyklad|sekret=ukryty/);
    expect(stored).not.toContain(base64);
  });

  it("odzyskuje istniejące tury dawnej sesji raz przez stare ciasteczko i odrzuca niepodpisany identyfikator po zmianie", async () => {
    const env = makeEnv();
    const id = newSessionId();
    const old = createSession(env.ctx, { id, senderId: env.ctx.security.pseudonymize("web:" + id), channel: "web" });
    saveSessionState(env.ctx, old.id, { history: [{ role: "user", text: "Archiwalne pytanie" }, { role: "assistant", text: "Zachowana odpowiedź" }] });
    expect((await chat(env, { text: "Źródła", sessionId: id })).status).toBe(404);
    const upgrade = await http(env, "GET", path, "pw_sid=" + id);
    const rotated = cookieOf(upgrade);
    expect(rotated).not.toBe("pw_sid=" + id);
    const data = await detail(env, rotated, id);
    expect(data.entries).toMatchObject([{ role: "user", text: "Archiwalne pytanie" }, { role: "assistant", reply: { textPl: "Zachowana odpowiedź" } }]);
    expect((await http(env, "GET", path + "/" + id, "pw_sid=" + id)).status).toBe(404);
    expect(count(env, "web_chat_turns")).toBe(1);
  });

  it("wygasłe czaty znikają również przed cyklicznym czyszczeniem", async () => {
    const env = makeEnv();
    const a = await newThread(env);
    await chat(env, { sessionId: a.chat.id, text: "Pytanie sprzed tygodnia" }, a.cookie);
    env.advance(8 * 86_400_000);
    expect(await (await http(env, "GET", path, a.cookie)).json()).toEqual({ chats: [] });
    expect((await http(env, "GET", path + "/" + a.chat.id, a.cookie)).status).toBe(404);
    expect((await chat(env, { sessionId: a.chat.id, text: "Dalszy ciąg" }, a.cookie)).status).toBe(404);
    purgeRetention(env.db, new Date(env.clock.now));
    expect(count(env, "web_chat_turns")).toBe(0);
  });

  it("usunięcie w trakcie weryfikacji czeka na koniec zapisu i nie odtwarza usuniętej rozmowy", async () => {
    let release!: () => void;
    let announceStart!: () => void;
    const started = new Promise<void>(resolve => { announceStart = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const env = makeEnv({ engine: async input => { announceStart(); await gate; return makeReport({ claim: input.text }); } });
    const a = await newThread(env);
    const pending = chat(env, { sessionId: a.chat.id, text: "Pytanie o szwedzki parlament" }, a.cookie);
    await started;
    const deletion = http(env, "DELETE", path + "/" + a.chat.id, a.cookie);
    release();
    await Promise.all([pending, deletion]);
    expect((await http(env, "GET", path + "/" + a.chat.id, a.cookie)).status).toBe(404);
    expect(count(env, "web_chat_turns")).toBe(0);
    expect(count(env, "reports")).toBe(0);
  });
});
