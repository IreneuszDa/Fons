import { describe, expect, it } from "vitest";
import type { ConversationReply } from "../shared/contracts";
import { renderSms, SMS_MAX_CHARS, type SmsSimAdapter } from "./channels/sms-sim";
import { makeEnv, makeReport, type TestEnv } from "./testkit";

async function sim(env: TestEnv, text: string, cookie = ""): Promise<{ status: number; json: any; cookie: string }> {
  const res = await env.app.request("/api/sim/sms", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text }),
  });
  const m = /pw_sim=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
  return { status: res.status, json: await res.json(), cookie: m ? `pw_sim=${m[1]}` : cookie };
}

const adapterOf = (env: TestEnv) => env.ctx.channels.getWebhook("sms") as SmsSimAdapter;

describe("demonstracyjny kanał SMS (adapter + webhook HMAC)", () => {
  it("jest zarejestrowany jako kanał webhookowy (nie 501), a SMS_SIM=off go wyłącza", async () => {
    const env = makeEnv();
    expect(env.ctx.channels.getWebhook("sms")?.id).toBe("sms");
    const off = makeEnv({ cfg: { smsSimulator: false } });
    expect(off.ctx.channels.getWebhook("sms")).toBeUndefined();
    expect((await sim(off, "Ziemia jest płaska")).status).toBe(501);
  });

  it("webhook: poprawny podpis HMAC → odpowiedź w skrzynce; zły podpis albo stary znacznik czasu → 403", async () => {
    const env = makeEnv();
    const a = adapterOf(env);
    const raw = JSON.stringify({ from: "+48600100200", messageId: "m-1", text: "Szwecja jest w NATO" });
    const ts = Math.floor(env.clock.now / 1000);
    const post = (headers: Record<string, string>, body = raw) =>
      env.app.request("/api/channels/sms/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    expect((await post(a.sign(raw, ts), raw + " ")).status).toBe(403); // podpis z surowego ciała
    expect((await post(a.sign(raw, ts - 3600))).status).toBe(403); // poza oknem 5 min
    expect((await post({ "x-fons-timestamp": String(ts), "x-fons-signature": "sha256=" + "0".repeat(64) })).status).toBe(403);
    expect(env.calls).toHaveLength(0);

    const ok = await post(a.sign(raw, ts));
    expect(ok.status).toBe(200);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]!.channel).toBe("sms");
    // numer nadawcy nie trafia do bazy — tylko pseudonim
    expect(JSON.stringify(env.db.prepare("SELECT * FROM sessions").all())).not.toContain("600100200");
    const out = a.takeOutbox(a.sessionIdFor("+48600100200"));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(out[0]).toMatch(/\/w\/[A-Za-z0-9_-]{22}/);
    // ponowne doręczenie tej samej wiadomości (retry bramki) nie uruchamia drugiej weryfikacji
    expect(((await (await post(a.sign(raw, ts))).json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(env.calls).toHaveLength(1);
  });

  it("symulator /telefon: SMS z werdyktem i odnośnikiem; ta sama rozmowa obsługuje „źródła”", async () => {
    const env = makeEnv();
    const first = await sim(env, "Szwecja dołączyła do NATO w 2024 roku");
    expect(first.status).toBe(200);
    expect(first.cookie).toMatch(/^pw_sim=[0-9a-f]{32}$/);
    expect(first.json.messages).toHaveLength(1);
    const sms = first.json.messages[0] as string;
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms).toContain("http://localhost:8787/w/");
    expect(sms).toMatch(/ŹRÓDŁA/);
    const sources = await sim(env, "źródła", first.cookie);
    expect(sources.json.messages[0]).toMatch(/Ustawa testowa|Sejm RP|źród/i);
    expect(env.calls).toHaveLength(1);
  });

  it("dwa telefony to dwóch nadawców: sprawa moderatora liczy oba (Pętla informacji przez drugi kanał)", async () => {
    const env = makeEnv({ engine: (req) => makeReport({ verdict: "BRAK_DOWODOW", claim: req.text ?? "x" }) });
    const text = "W zeszły czwartek w Elblągu wojsko rozdało mieszkańcom maski przeciwgazowe.";
    await sim(env, text);
    await sim(env, text); // nowy telefon (bez ciasteczka)
    const web = await env.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    expect(web.status).toBe(200);
    const row = env.db.prepare("SELECT sender_count AS n, channels_json AS ch FROM moderator_cases").get() as { n: number; ch: string };
    expect(row.n).toBe(3);
    expect(JSON.parse(row.ch)).toEqual(["sms", "web"]);
  });

  it("symulator odrzuca żądania z obcych stron i nie-JSON", async () => {
    const env = makeEnv();
    const plain = await env.app.request("/api/sim/sms", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"text":"x"}' });
    expect(plain.status).toBe(415);
    const cross = await env.app.request("/api/sim/sms", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: '{"text":"x"}',
    });
    expect(cross.status).toBe(403);
    expect(env.calls).toHaveLength(0);
  });
});

describe("renderSms", () => {
  it("długa treść jest skracana tak, by odnośnik zawsze się zmieścił", () => {
    const reply: ConversationReply = {
      kind: "verdict",
      textPl: "Werdykt: FAŁSZYWE. " + "Bardzo długie uzasadnienie z wieloma szczegółami. ".repeat(20),
      quickReplies: [],
      resultUrl: "https://fons.example/w/AAAAAAAAAAAAAAAAAAAAAA",
    };
    const sms = renderSms(reply);
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms.endsWith("https://fons.example/w/AAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(sms).toContain("…");
    expect(renderSms({ kind: "help", textPl: "Pomoc.", quickReplies: [] })).toBe("Pomoc.");
  });
});
