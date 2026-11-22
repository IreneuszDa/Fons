import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ConversationReply, InboundMessage } from "../shared/contracts";
import { verifyHmacSha256, withinWindow } from "./channels/signature";
import { cliAdapter } from "./channels/cli";
import { webAdapter } from "./channels/web";
import { chat, makeEnv, type TestEnv } from "./testkit";
import { createHmac } from "node:crypto";

const SECRET = "shared-secret";

function fakeAdapter(sent: ConversationReply[], id = "sms"): ChannelAdapter {
  return {
    id,
    capabilities: { maxChars: 320, supportsImagesIn: false, supportsButtons: false, supportsMarkdown: false },
    verifySignature: (raw, headers) => verifyHmacSha256(SECRET, raw, headers["x-signature"]),
    parseInbound(raw): InboundMessage | null {
      const b = JSON.parse(raw) as { from: string; id: string; text: string };
      if (!b.text) return null;
      return {
        channel: (b as any).channel ?? id,
        senderId: `sms-${b.from}`,
        sessionId: `sms-sess-${b.from}`,
        messageId: b.id,
        receivedAt: new Date().toISOString(),
        text: b.text,
        images: [],
      };
    },
    render: (r) => r.textPl,
    send: async (out) => void sent.push(out.reply),
  };
}

const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
const post = (env: TestEnv, id: string, body: string, sig?: string) =>
  env.app.request(`/api/channels/${id}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig ? { "x-signature": sig } : {}) },
    body,
  });

describe("webhook kanałów", () => {
  it("obsługuje podpisaną wiadomość z nowego kanału bez zmiany kontraktu wiadomości", async () => {
    const env = makeEnv();
    const replies: ConversationReply[] = [];
    env.ctx.channels.register(fakeAdapter(replies, "partner-chat"), { webhook: true });
    const body = JSON.stringify({ from: "1", id: "delivery", text: "Czy Polska należy do NATO?" });
    expect((await post(env, "partner-chat", body, sign(body))).status).toBe(200);
    expect(env.calls[0]?.channel).toBe("partner-chat");
    expect(replies[0]?.report?.id).toBeTruthy();
  });
  it("nieznany lub nieskonfigurowany kanał → 501", async () => {
    const env = makeEnv();
    expect((await post(env, "whatsapp", "{}")).status).toBe(501);
    expect((await post(env, "nie-ma-takiego", "{}")).status).toBe(501);
    expect((await post(env, "web", "{}")).status).toBe(501); // web i cli nie mają webhooka
    expect((await post(env, "cli", "{}")).status).toBe(501);
  });

  it("zły lub brakujący podpis → 403, silnik niewołany", async () => {
    const env = makeEnv();
    const sent: ConversationReply[] = [];
    env.ctx.channels.register(fakeAdapter(sent), { webhook: true });
    const body = JSON.stringify({ from: "48111", id: "m1", text: "Ziemia jest płaska" });
    expect((await post(env, "sms", body)).status).toBe(403);
    expect((await post(env, "sms", body, "0".repeat(64))).status).toBe(403);
    expect((await post(env, "sms", body, "nie-hex")).status).toBe(403);
    expect((await post(env, "sms", body + " ", sign(body))).status).toBe(403); // podpis liczony z surowego ciała
    expect(env.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("adapter rzucający wyjątek przy weryfikacji = 403", async () => {
    const env = makeEnv();
    const a = fakeAdapter([]);
    a.verifySignature = () => {
      throw new Error("boom");
    };
    env.ctx.channels.register(a, { webhook: true });
    expect((await post(env, "sms", "{}", "x")).status).toBe(403);
  });

  it("poprawny podpis: wiadomość przechodzi przez warstwę rozmowy, odpowiedź idzie przez adapter; duplikat ignorowany", async () => {
    const env = makeEnv();
    const sent: ConversationReply[] = [];
    env.ctx.channels.register(fakeAdapter(sent), { webhook: true });
    const body = JSON.stringify({ from: "48111", id: "m1", text: "Ziemia jest płaska" });
    const r = await post(env, "sms", body, sign(body));
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe("verdict");
    expect(env.calls[0]).toMatchObject({ channel: "sms", kind: "text" });
    const dup = await post(env, "sms", body, sign(body));
    expect(((await dup.json()) as any).duplicate).toBe(true);
    expect(sent).toHaveLength(1);
    expect(env.calls).toHaveLength(1);
    // ta sama konwersacja: „źródła” działa na raporcie z kanału
    const b2 = JSON.stringify({ from: "48111", id: "m2", text: "źródła" });
    await post(env, "sms", b2, sign(b2));
    expect(sent[1]!.kind).toBe("sources");
  });

  it("wiadomość bez treści jest ignorowana; adapter nie może udawać innego kanału", async () => {
    const env = makeEnv();
    env.ctx.channels.register(fakeAdapter([]), { webhook: true });
    const empty = JSON.stringify({ from: "1", id: "e1", text: "" });
    expect(((await (await post(env, "sms", empty, sign(empty))).json()) as any).ignored).toBe(true);
    const spoof = JSON.stringify({ from: "1", id: "e2", text: "x", channel: "discord" });
    expect((await post(env, "sms", spoof, sign(spoof))).status).toBe(400);
  });

  it("błąd wysyłki odpowiedzi → 502 bez szczegółów", async () => {
    const env = makeEnv();
    const a = fakeAdapter([]);
    a.send = vi.fn(async () => {
      throw new Error("TOKEN_LEAK");
    });
    env.ctx.channels.register(a, { webhook: true });
    const body = JSON.stringify({ from: "1", id: "s1", text: "Pytanie" });
    const r = await post(env, "sms", body, sign(body));
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("TOKEN_LEAK");
  });
});

describe("pomocnicze funkcje podpisu", () => {
  it("HMAC i okno 5 minut", () => {
    const body = "{}";
    expect(verifyHmacSha256(SECRET, body, `sha256=${sign(body)}`)).toBe(true);
    expect(verifyHmacSha256("", body, sign(body))).toBe(false);
    const now = 1_800_000_000_000;
    expect(withinWindow(String(now / 1000 - 200), now)).toBe(true);
    expect(withinWindow(String(now / 1000 - 400), now)).toBe(false);
    expect(withinWindow(undefined, now)).toBe(false);
  });
});

describe("renderery kanałów", () => {
  const reply: ConversationReply = {
    kind: "verdict",
    textPl: "Wynik: Potwierdzone.",
    quickReplies: [{ id: "sources", labelPl: "Źródła" }],
    resultUrl: "http://localhost:8787/w/abc",
  };
  it("web (przyciski) i cli (lista opcji w tekście)", () => {
    expect(webAdapter.render(reply)).toContain("http://localhost:8787/w/abc");
    expect(webAdapter.render(reply)).not.toContain("Możesz odpowiedzieć");
    expect(cliAdapter.render(reply)).toContain("Możesz odpowiedzieć: Źródła");
  });
  it("kanał web nie przyjmuje webhooka", () => {
    expect(webAdapter.verifySignature("", {}, "")).toBe(false);
    expect(webAdapter.parseInbound("", {})).toBeNull();
  });
  it("kanały przez ten sam rdzeń dają ten sam werdykt (web vs cli)", async () => {
    const env = makeEnv();
    const w = await chat(env, { text: "Ziemia jest okrągła" });
    const { handleInbound } = await import("./conversation");
    const { buildCliInbound } = await import("./channels/cli");
    const c = await handleInbound(buildCliInbound(env.ctx, { senderId: "cli-x", text: "Ziemia jest okrągła" }), env.ctx);
    expect(c.report!.mainVerdict).toBe(w.json.reply.report.mainVerdict);
    expect(c.report!.verdicts[0]!.evidence.map((e) => e.recordId)).toEqual(w.json.reply.report.verdicts[0].evidence.map((e: any) => e.recordId));
  });
});
