import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePhone } from "../shared/phone";
import { purgeRetention, WHATSAPP_SIGNUP_RETENTION_DAYS } from "./db";
import { makeEnv, makeReport, type TestEnv } from "./testkit";
import { OUTBOX_LEASE_MS, RESEND_COOLDOWN_MS, welcomeText } from "./whatsapp-signup";

const secret = "chatloom-fixture-secret";
const cfg = { chatloomWebhookSecret: secret, publicBaseUrl: "https://fons.example/" };

function signup(env: TestEnv, body: unknown, headers: Record<string, string> = {}) {
  return env.app.request("/api/signup/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signedHeaders(env: TestEnv, raw: string, { key = secret, age = 0 } = {}) {
  const timestamp = String(Math.floor(env.clock.now / 1000) - age);
  const signature = createHmac("sha256", key).update(timestamp + "." + raw).digest("hex");
  return { "X-ChatLoom-Timestamp": timestamp, "X-ChatLoom-Signature": signature };
}

function poll(env: TestEnv, opts?: { key?: string; age?: number }, query = "") {
  return env.app.request(`/api/channels/chatloom/outbox${query}`, { headers: signedHeaders(env, "", opts) });
}

function ack(env: TestEnv, id: string, body: object, opts?: { key?: string; age?: number }) {
  const raw = JSON.stringify(body);
  return env.app.request(`/api/channels/chatloom/outbox/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedHeaders(env, raw, opts) },
    body: raw,
  });
}

async function items(env: TestEnv, query = ""): Promise<{ id: string; phone: string; text: string }[]> {
  const res = await poll(env, undefined, query);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { id: string; phone: string; text: string }[] }).items;
}

describe("normalizePhone", () => {
  it.each([
    ["500 000 000", "+48500000000"],
    ["500-000-000", "+48500000000"],
    ["+48 500 000 000", "+48500000000"],
    ["0048500000000", "+48500000000"],
    ["(+48) 500.000.000", "+48500000000"],
    ["+44 20 7946 0958", "+442079460958"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("accepts %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each(["", "12345", "50000000", "5000000000", "+48 050 000 000", "+48 500 000 0000", "+0 123 456 789", "abc500000000", "+48500000000x", "1".repeat(41)])(
    "rejects %s", (input) => expect(normalizePhone(input)).toBeNull());
});

describe("zapis do Fons na WhatsAppie", () => {
  it("wymaga zgody i poprawnego numeru, przyjmuje tylko JSON z tej samej strony", async () => {
    const env = makeEnv({ cfg });
    expect((await signup(env, { phone: "500000000" })).status).toBe(400);
    const noConsent = await signup(env, { phone: "500000000", consent: false });
    expect(noConsent.status).toBe(400);
    expect(await noConsent.json()).toMatchObject({ error: "consent_required" });
    const bad = await signup(env, { phone: "12", consent: true });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_phone", messagePl: expect.any(String) });
    expect((await signup(env, "{")).status).toBe(400);
    expect((await env.app.request("/api/signup/whatsapp", { method: "POST", headers: { "content-type": "text/plain" },
      body: JSON.stringify({ phone: "500000000", consent: true }) })).status).toBe(415);
    expect((await signup(env, { phone: "500000000", consent: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_signups").get()).toEqual({ n: 0 });
  });

  it("zapisuje numer w E.164 raz, bez numeru w logach, i odpowiada tym samym statusem przy powtórce", async () => {
    const env = makeEnv({ cfg });
    const first = await signup(env, { phone: "500 000 000", consent: true });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, status: "pending" });
    const again = await signup(env, { phone: "+48500000000", consent: true });
    expect(await again.json()).toEqual({ ok: true, status: "pending" });
    const rows = env.db.prepare("SELECT phone, status, ip_hash FROM whatsapp_signups").all() as { phone: string; ip_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: "+48500000000", status: "pending" });
    expect(rows[0]!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    const logs = env.logs.join("\n");
    expect(logs).toContain("whatsapp_signup");
    expect(logs).not.toMatch(/500000000|500 000 000/);
    expect(await items(env)).toHaveLength(1);
  });

  it("ogranicza liczbę zapisów z jednego adresu IP", async () => {
    const env = makeEnv({ cfg });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await signup(env, { phone: `50000000${i}`, consent: true })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    env.advance(61_000);
    expect((await signup(env, { phone: "500000009", consent: true })).status).toBe(200);
  });
});

describe("skrzynka nadawcza ChatLoom", () => {
  it("jest wyłączona bez sekretu i wymaga świeżego podpisu", async () => {
    const off = makeEnv();
    expect((await poll(off)).status).toBe(501);
    expect((await ack(off, "x", { status: "sent" })).status).toBe(501);
    const env = makeEnv({ cfg });
    expect((await env.app.request("/api/channels/chatloom/outbox")).status).toBe(403);
    expect((await poll(env, { key: "wrong" })).status).toBe(403);
    for (const age of [-301, 301]) expect((await poll(env, { age })).status).toBe(403);
    expect((await ack(env, "x", { status: "sent" }, { key: "wrong" })).status).toBe(403);
    // The signature covers the exact raw body.
    const raw = JSON.stringify({ status: "sent" });
    const tampered = await env.app.request("/api/channels/chatloom/outbox/x", {
      method: "POST", headers: { "Content-Type": "application/json", ...signedHeaders(env, raw) }, body: raw + " ",
    });
    expect(tampered.status).toBe(403);
  });

  it("wydaje najstarsze zapisy z powitaniem, blokuje je na 5 minut i zwraca po wygaśnięciu blokady", async () => {
    const env = makeEnv({ cfg });
    await signup(env, { phone: "500000001", consent: true });
    env.advance(1000);
    await signup(env, { phone: "+44 20 7946 0958", consent: true });

    const batch = await items(env);
    expect(batch.map(item => item.phone)).toEqual(["+48500000001", "+442079460958"]);
    expect(batch[0]!.text).toBe(welcomeText("https://fons.example/"));
    expect(batch[0]!.text).toContain("https://fons.example");
    expect(batch[0]!.text).toContain("usuń moje dane");
    expect(batch[0]!.text.length).toBeLessThan(400);
    expect(batch[0]!.text).not.toMatch(/[*_`#]/);

    expect(await items(env)).toEqual([]);
    env.advance(OUTBOX_LEASE_MS - 1000);
    expect(await items(env)).toEqual([]);
    env.advance(1000);
    expect((await items(env)).map(item => item.id)).toEqual(batch.map(item => item.id));
  });

  it("wydaje najwyżej 20 pozycji naraz", async () => {
    const env = makeEnv({ cfg: { ...cfg, rateLimitPerMinute: 100 } });
    for (let i = 0; i < 25; i++) {
      if (i % 5 === 0) env.advance(61_000);
      expect((await signup(env, { phone: `5000000${String(i).padStart(2, "0")}`, consent: true })).status).toBe(200);
    }
    expect(await items(env)).toHaveLength(20);
    expect(await items(env)).toHaveLength(5);
  });

  it("zapisuje potwierdzenie wysyłki i ponawia tylko nieudane powitanie", async () => {
    const env = makeEnv({ cfg });
    await signup(env, { phone: "500000001", consent: true });
    await signup(env, { phone: "500000002", consent: true });
    const [sent, failed] = await items(env);

    expect((await ack(env, sent!.id, { status: "sent" })).status).toBe(200);
    expect(await (await ack(env, sent!.id, { status: "sent" })).json()).toEqual({ ok: true });
    expect((await ack(env, sent!.id, { status: "failed" })).status).toBe(409);
    expect((await ack(env, failed!.id, { status: "failed", error: "WhatsApp rejected +48 500 000 002" })).status).toBe(200);
    expect((await ack(env, "missing", { status: "sent" })).status).toBe(404);
    expect((await ack(env, sent!.id, { status: "unknown" })).status).toBe(400);

    const rows = env.db.prepare("SELECT phone, status, sent_at, error, lease_until FROM whatsapp_signups ORDER BY phone").all();
    expect(rows).toEqual([
      { phone: "+48500000001", status: "sent", sent_at: new Date(env.clock.now).toISOString(), error: null, lease_until: 0 },
      { phone: "+48500000002", status: "failed", sent_at: null, error: "WhatsApp rejected [numer]", lease_until: 0 },
    ]);
    expect(await items(env)).toEqual([]);

    // Saving a number again queues a new welcome under a new id; a just-greeted number waits out the cooldown.
    expect(await (await signup(env, { phone: "500000001", consent: true })).json()).toEqual({ ok: true, status: "sent" });
    expect(await (await signup(env, { phone: "500000002", consent: true })).json()).toEqual({ ok: true, status: "pending" });
    const [retried] = await items(env);
    expect(retried!.phone).toBe("+48500000002");
    expect(retried!.id).not.toBe(failed!.id);
    expect((await ack(env, failed!.id, { status: "sent" })).status).toBe(404);
    expect((await ack(env, retried!.id, { status: "sent" })).status).toBe(200);

    env.advance(RESEND_COOLDOWN_MS);
    expect(await (await signup(env, { phone: "500000001", consent: true })).json()).toEqual({ ok: true, status: "pending" });
    expect(await (await signup(env, { phone: "500000001", consent: true })).json()).toEqual({ ok: true, status: "pending" });
    const again = await items(env);
    expect(again.map(item => item.phone)).toEqual(["+48500000001"]);
    expect(again[0]!.id).not.toBe(sent!.id);
  });

  it("wydaje najwyżej ?limit pozycji", async () => {
    const env = makeEnv({ cfg });
    for (const phone of ["500000011", "500000012", "500000013"]) await signup(env, { phone, consent: true });
    expect((await items(env, "?limit=0"))).toEqual([]);
    expect((await items(env, "?limit=2")).length).toBe(2);
    expect((await items(env)).length).toBe(1);
  });

  it("usuwa zapis po okresie retencji i po „usuń moje dane” z tego numeru", async () => {
    const env = makeEnv({ cfg });
    await signup(env, { phone: "500000001", consent: true });
    await signup(env, { phone: "500000002", consent: true });
    env.advance(WHATSAPP_SIGNUP_RETENTION_DAYS * 86_400_000 - 1000);
    await signup(env, { phone: "500000003", consent: true });
    env.advance(2000);
    purgeRetention(env.db, new Date(env.clock.now));
    const phones = () => (env.db.prepare("SELECT phone FROM whatsapp_signups").all() as { phone: string }[]).map(r => r.phone);
    expect(phones()).toEqual(["+48500000003"]);

    const env2 = makeEnv({ cfg, engine: () => makeReport() });
    await signup(env2, { phone: "500000001", consent: true });
    await signup(env2, { phone: "500000002", consent: true });
    const room = "!wa:relay";
    const sender = "@whatsapp_48500000001:relay";
    let n = 0;
    const say = async (body: string) => {
      const raw = JSON.stringify({ room_id: room, sender, event_id: `$e${++n}`, origin_server_ts: env2.clock.now, type: "m.room.message",
        content: { msgtype: "m.text", body } });
      const res = await env2.app.request("/api/channels/chatloom/webhook", {
        method: "POST", headers: { "Content-Type": "application/json", ...signedHeaders(env2, raw) }, body: raw });
      expect(res.status).toBe(200);
    };
    await say("usuń moje dane");
    await say("tak");
    expect((env2.db.prepare("SELECT phone FROM whatsapp_signups").all() as { phone: string }[]).map(r => r.phone)).toEqual(["+48500000002"]);
  });
});
