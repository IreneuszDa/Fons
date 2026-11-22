import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider } from "../engine/llm/fake";
import { STATUS_PL } from "../engine/messages";
import { makeTestDeps } from "../mcp/testkit";
import { initCorpusSchema } from "../corpus/store";
import { chat, chatModelUsage as usage, makeEnv, makeReport } from "./testkit";

function onePagePdf(): Buffer {
  const stream = "BT /F1 12 Tf 40 740 Td (Tekst dokumentu testowego.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, "0")} 00000 n `);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n${offsets.join("\n")}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

describe("pliki wysłane do /api/chat", () => {
  let image: { mime: string; base64: string };
  beforeAll(async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: "green" } })
      .withExif({ IFD0: { Artist: "private@example.com" } }).png().toBuffer();
    image = { mime: "image/png", base64: png.toString("base64") };
  });

  it("przekazuje podpis i piksele bez metadanych do weryfikacji oraz rozróżnia podpisy w cache", async () => {
    const google = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: google, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test" } });
    const message = { image, text: "Sprawdź prawdziwość wiadomości o Warszawie ze zrzutu." };
    const first = await chat(env, message);
    expect(first.status).toBe(200);
    expect(first.json.reply).toMatchObject({ kind: "verdict", report: { imageAnalysis: { only: false } } });
    expect(env.calls[0]).toMatchObject({ kind: "image", text: message.text, images: [{ mime: "image/jpeg" }] });
    const metadata = await sharp(Buffer.from(env.calls[0]!.images![0]!.base64, "base64")).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 30, height: 20 });
    expect(metadata.exif).toBeUndefined();
    expect(JSON.stringify(first.json)).not.toContain(image.base64);
    expect(JSON.stringify(first.json)).not.toContain("private@example.com");
    expect((await chat(env, message, first.cookie)).json.reply.report.cacheHit).toBe(true);
    const different = await chat(env, { image, text: "Sprawdź prawdziwość wiadomości o Gdańsku ze zrzutu." }, first.cookie);
    expect(different.json.reply.report.cacheHit).toBe(false);
    expect(env.calls).toHaveLength(2);
    expect(google).not.toHaveBeenCalled();
    expect(env.ctx.media.size).toBe(0);
  });

  it.each(["obraz", "dokument"])("izoluje i usuwa cache załącznika (%s) dla wskazanego czatu", async kind => {
    const env = makeEnv();
    const body = kind === "obraz"
      ? { image, text: "Sprawdź prawdziwość wiadomości o Warszawie ze zrzutu." }
      : { document: { mime: "text/plain", base64: Buffer.from("Warszawa jest stolicą Polski.").toString("base64") } };
    const first = await chat(env, body);
    const sessionId = first.json.sessionId;
    expect(first.json.reply.report.cacheHit).toBe(false);
    expect((await chat(env, { ...body, sessionId }, first.cookie)).json.reply.report.cacheHit).toBe(true);
    const second = await chat(env, body);
    expect(second.json.reply.report.cacheHit).toBe(false);
    expect(env.calls).toHaveLength(2);

    const cleanup = await env.app.request("/api/chats/" + sessionId, { method: "DELETE", headers: { cookie: first.cookie } });
    expect(cleanup.status).toBe(200);
    expect(env.db.prepare("SELECT cache_key FROM computation_cache WHERE session_id = ?").all(sessionId)).toEqual([]);
    expect(env.db.prepare("SELECT cache_key FROM cache_tombstones WHERE instr(cache_key, ?) = 1").all(sessionId + ":")).toEqual([]);
    expect((await chat(env, { ...body, sessionId: second.json.sessionId }, second.cookie)).json.reply.report.cacheHit).toBe(true);
  });

  it("odpowiada na pytanie o zawartość załączonego zdjęcia z pikseli", async () => {
    const google = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: google, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test" } });
    let pixels: Buffer | undefined;
    const provider = new FakeLlmProvider({ supportsVision: true, override: req => {
      pixels = Buffer.from(req.images![0]!.base64, "base64");
      return { answerPl: "Obraz jest zielony.", citationIndex: -1 };
    } });
    initCorpusSchema(env.db);
    env.ctx.engineDeps = { ...makeTestDeps(env.db), llm: provider };
    const message = { image, text: "Jaki kolor widzisz?" };
    const first = await chat(env, message);
    expect(first.json.reply).toMatchObject({ kind: "image_analysis", textPl: "Obraz jest zielony.", report: {
      mainVerdict: null, claims: [], models: [{ purpose: "image_question" }], imageAnalysis: { only: true, visual: { mode: "visual" } },
    } });
    const metadata = await sharp(pixels!).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 30, height: 20 });
    expect(metadata.exif).toBeUndefined();
    expect((await chat(env, message, first.cookie)).json.reply.report.cacheHit).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(google).not.toHaveBeenCalled();
    expect(env.calls).toHaveLength(0);
    expect(env.ctx.media.size).toBe(0);
  });

  it("sam szuka publikacji z fotografią przy pytaniu o prezydenta i respektuje wyłączenie Google", async () => {
    const google = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ responses: [{ webDetection: {} }] }));
    const env = makeEnv({ fetch: google, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test" } });
    initCorpusSchema(env.db);
    env.ctx.engineDeps = { ...makeTestDeps(env.db), llm: new FakeLlmProvider({
      supportsVision: true, override: () => ({ subject: "person", printedLabel: "" }),
    }) };
    const message = { image, text: "Czy to jest Prezydent polski?" };
    const first = await chat(env, message);
    expect(first.json.reply).toMatchObject({ kind: "image_analysis", textPl: expect.stringContaining("podpisu"), report: {
      mainVerdict: null, claims: [], imageAnalysis: { only: true, visual: { mode: "identity" }, images: [{ search: { status: "ok" } }] },
    } });
    expect(first.json.reply.textPl).not.toMatch(/C2PA|IPTC|Żadne wiarygodne źródło/);
    const optOut = await chat(env, { ...message, imageOptions: { searchWeb: false } }, first.cookie);
    expect(optOut.json.reply.report.cacheHit).toBe(false);
    expect(optOut.json.reply.report.imageAnalysis.images[0].search).toBeUndefined();
    const byText = await chat(env, { image, text: "Kto to jest? Nie wysyłaj tego zdjęcia do Google." }, first.cookie);
    expect(byText.json.reply.report.imageAnalysis.images[0].search).toBeUndefined();
    expect(google).toHaveBeenCalledOnce();
    expect(env.calls).toHaveLength(0);
  });

  it("opisuje zdjęcie bez wiadomości, jeżeli odczyt nie wykrył na nim tekstu", async () => {
    const env = makeEnv({ engine: () => makeReport({
      status: "DOPRECYZUJ", statusMessagePl: STATUS_PL.imageUnreadable, mainVerdict: null, verdicts: [], claims: [], models: [],
    }) });
    const llm = new FakeLlmProvider({ supportsVision: true, override: () => ({ answerPl: "Widzę zielony prostokąt.", citationIndex: -1 }) });
    initCorpusSchema(env.db);
    env.ctx.engineDeps = { ...makeTestDeps(env.db), llm };
    const result = await chat(env, { image });
    expect(result.json.reply).toMatchObject({ kind: "image_analysis", textPl: "Widzę zielony prostokąt.", report: {
      imageAnalysis: { only: true, visual: { mode: "visual" } },
    } });
  });

  it("agent rozpoznaje pytanie o pochodzenie i może do niego wrócić po usunięciu pliku", async () => {
    const env = makeEnv();
    const agent = vi.fn().mockResolvedValue({ kind: "image_origin", usage });
    env.ctx.conversationAgent = agent;
    const first = await chat(env, { image, text: "Wygląda jak coś z generatora. Co mówi o tym sam plik?" });
    const finding = first.json.reply.report.imageAnalysis.images[0].provenance.textPl;
    expect(first.json.reply.kind).toBe("image_analysis");
    expect(env.ctx.media.size).toBe(0);
    const followUp = await chat(env, { text: "Czyli co wiadomo o autorstwie tego zdjęcia?" }, first.cookie);
    expect(followUp.json.reply.textPl).toBe(finding);
    expect(agent.mock.calls.map(([input]) => input.imageContext)).toEqual(["attached", "previous"]);
    expect(JSON.stringify(agent.mock.calls)).not.toContain(image.base64);
    expect(env.calls).toHaveLength(0);
  });

  it("sprawdza lokalne poświadczenia bez OCR, obsługuje też jawne żądanie wyszukania kopii", async () => {
    const google = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ responses: [{ webDetection: {
      pagesWithMatchingImages: [{ url: "https://www.nato.int/archive", pageTitle: "Archiwum" }],
    } }] }));
    const env = makeEnv({ fetch: google, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test", dailyTokenBudget: 0 } });
    const message = { image, text: "Czy to AI?" };
    const local = await chat(env, message);
    expect(local.json.reply).toMatchObject({ kind: "image_analysis", report: { mainVerdict: null, claims: [],
      imageAnalysis: { only: true, images: [{ provenance: { declaration: "none" } }] } } });
    expect(local.json.reply.report.imageAnalysis.images[0].search).toBeUndefined();
    expect(google).not.toHaveBeenCalled();
    const optedIn = { ...message, imageOptions: { searchWeb: true } };
    const searched = await chat(env, optedIn, local.cookie);
    const report = searched.json.reply.report;
    expect(report).toMatchObject({ cacheHit: false, mainVerdict: null, imageAnalysis: { only: true, images: [
      { search: { status: "ok", matches: [{ kind: "page", url: "https://www.nato.int/archive" }] } },
    ] } });
    const saved = await env.app.request(`/api/report/${report.token}`);
    expect(await saved.json()).toMatchObject({ imageAnalysis: report.imageAnalysis });
    expect((await chat(env, optedIn, local.cookie)).json.reply.report.cacheHit).toBe(true);
    expect(google).toHaveBeenCalledOnce();
    expect(env.calls).toHaveLength(0);
    expect(env.ctx.media.size).toBe(0);
  });

  it("sam wyszukuje kopie na prośbę w rozmowie i zwraca zapamiętane adresy w kolejnej turze", async () => {
    const page = "https://www.nato.int/archive";
    const google = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ responses: [{ webDetection: {
      pagesWithMatchingImages: [{ url: page, pageTitle: "Archiwum" }],
    } }] }));
    const env = makeEnv({ fetch: google, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test" } });
    env.ctx.conversationAgent = vi.fn().mockResolvedValue({ kind: "image_copies", usage });
    const first = await chat(env, { image, text: "Gdzie w sieci pojawiło się to zdjęcie?" });
    expect(first.json.reply.report.imageAnalysis).toMatchObject({ only: true, focus: "copies", images: [{ search: { status: "ok" } }] });
    const next = await chat(env, { text: "Na jakiej stronie są kopie?" }, first.cookie);
    expect(next.json.reply).toMatchObject({ kind: "sources", textPl: page });
    expect(google).toHaveBeenCalledOnce();
    expect(env.calls).toHaveLength(0);
  });

  it.each([
    ["text/plain", Buffer.from("Treść testowa ze znakami ąćź."), "Treść testowa ze znakami ąćź."],
    ["application/pdf", onePagePdf(), "Tekst dokumentu testowego."],
  ] as const)("odczytuje %s i zachowuje pytanie o plik", async (mime, bytes, expected) => {
    const env = makeEnv();
    const text = "Co można sprawdzić w tym dokumencie?";
    const document = { mime, base64: bytes.toString("base64") };
    const result = await chat(env, { text, document });
    expect(result.status).toBe(200);
    expect(result.json.reply.kind).toBe("verdict");
    expect(env.calls[0]?.kind).toBe("text");
    expect(env.calls[0]?.text).toContain(expected);
    expect(env.calls[0]?.text).toContain(text);
    expect(JSON.stringify(result.json)).not.toContain(document.base64);
    expect(env.ctx.media.size).toBe(0);
  });

  it.each([
    ["application/pdf", Buffer.from("%PDF-1.4\nuszkodzony"), /odczytać PDF/],
    ["text/plain", Buffer.from([0xff]), /UTF-8/],
    ["text/plain", Buffer.from("tekst\u0000"), /binarne/],
    ["text/plain", Buffer.from(" \n"), /nie znalazłem tekstu/i],
    ["text/plain", Buffer.from("a".repeat(20_001)), /20 000/],
  ] as const)("wyjaśnia błąd odczytu pliku %s i usuwa go z pamięci", async (mime, bytes, message) => {
    const env = makeEnv();
    const response = await chat(env, { document: { mime, base64: bytes.toString("base64") } });
    expect(response.json.reply).toMatchObject({ kind: "status", textPl: expect.stringMatching(message) });
    expect(env.calls).toHaveLength(0);
    expect(env.ctx.media.size).toBe(0);
  });

  it("przekazuje nagranie do silnika, usuwa bajty z pamięci i zapisuje tylko nazwę pliku w historii", async () => {
    const env = makeEnv();
    const recording = { mime: "audio/wav", base64: Buffer.from("private voice recording for transport test").toString("base64") };
    const post = (body: object, cookie = "") => env.app.request("/api/chat/recording", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    });
    const invalid = await post({ recording, document: { mime: "text/plain", base64: "YQ==" } });
    expect(invalid.status).toBe(400);
    const accepted = await post({ recording, fileName: "Wiadomość.wav", text: "Sprawdź to nagranie" });
    expect(accepted.status).toBe(200);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({ kind: "recording", recording, text: "Sprawdź to nagranie" });
    expect(env.ctx.media.size).toBe(0);
    const stored = JSON.stringify(env.db.prepare("SELECT * FROM web_chat_turns").all());
    expect(stored).toContain("Wiadomość.wav");
    expect(stored).not.toContain(recording.base64);
    expect(await accepted.text()).not.toContain(recording.base64);
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    await post({ recording, text: "Sprawdź to nagranie" }, cookie);
    expect(env.calls).toHaveLength(1);
    await post({ recording, text: "Sprawdź to nagranie" });
    expect(env.calls).toHaveLength(2);
  });

  it("odrzuca zły typ pliku i niejednoznaczne załączniki przed analizą", async () => {
    const env = makeEnv();
    const document = { mime: "text/plain", base64: Buffer.from("test").toString("base64") };
    const requests = [
      { image: { ...image, base64: document.base64 } }, { image, document },
      { document, imageOptions: { searchWeb: true } }, { document: { ...document, mime: "text/html" } },
      { document: { ...document, base64: "!#@" } },
    ];
    for (const body of requests) expect((await chat(env, body)).status).toBe(400);
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const corrupt = await chat(env, { image: { ...image, base64: fakePng.toString("base64") } });
    expect(corrupt.json.reply).toMatchObject({ kind: "status", textPl: expect.stringContaining("odczytać obrazu") });
    expect(env.calls).toHaveLength(0);
    expect(env.ctx.media.size).toBe(0);
  });
});

describe("API podstawowe", () => {
  it("GET /api/health i /api/sources", async () => {
    const env = makeEnv();
    const h = await (await env.app.request("/api/health")).json();
    expect(h).toMatchObject({ ok: true, corpusRecords: 42, snapshotId: "snap-1", llm: { provider: "stub", available: true, singleKey: true } });
    const s = await (await env.app.request("/api/sources")).json();
    expect(s).toMatchObject({ catalog: [], counts: { eli: 40 }, snapshotId: "snap-1" });
  });

  it("nagłówki bezpieczeństwa, noindex na /w/* i /api/report/*", async () => {
    const env = makeEnv();
    const r = await env.app.request("/api/report/nieistnieje123456789");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("permissions-policy")).toBe("camera=(), microphone=(self), geolocation=(), payment=()");
    const w = await env.app.request("/w/abc");
    expect(w.headers.get("x-robots-tag")).toContain("noindex");
    const health = await env.app.request("/api/health");
    expect(health.headers.get("x-robots-tag")).toBeNull();
  });

  it("czat ustawia ciasteczko pw_sid (httpOnly, SameSite=Strict) i zwraca odpowiedź", async () => {
    const env = makeEnv();
    const res = await env.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Ziemia jest okrągła" }),
    });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/pw_sid=[0-9a-f]{32}/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    const j = (await res.json()) as any;
    expect(j.reply.kind).toBe("verdict");
    expect(j.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(j.reply.resultUrl).toContain("/w/");
  });

  it("odpowiedź API asystenta bez narzędzia wraca bez sygnału o sprawdzaniu źródeł", async () => {
    const env = makeEnv();
    const answer = "Pomagam ustalić skąd pochodzi wiadomość. Co Cię zaciekawiło?";
    env.ctx.conversationAgent = async () => ({ kind: "reply", text: answer, usage });
    const res = await env.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ text: "hej co to ?" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ reply: { textPl: answer } });
    expect(env.calls).toHaveLength(0);
  });

  it("czat wysyła zdarzenie rozpoczęcia weryfikacji przed wynikiem", async () => {
    let finishVerification!: (report: ReturnType<typeof makeReport>) => void;
    const verification = new Promise<ReturnType<typeof makeReport>>((resolve) => {
      finishVerification = resolve;
    });
    const env = makeEnv({ engine: (req) => {
      req.onActivity?.("searching");
      return verification;
    } });
    env.ctx.conversationAgent = async () => ({ kind: "verify", query: null, usage });
    const claim = "Polska należy do Unii Europejskiej od 2004 roku.";
    const res = await env.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ text: claim }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toMatch(/pw_sid=[0-9a-f]{32}/);
      const start = await reader.read();
      expect(decoder.decode(start.value)).toBe('{"type":"verification-start"}\n');
      expect(env.calls).toHaveLength(1);
      expect(JSON.parse(decoder.decode((await reader.read()).value))).toEqual({ type: "verification-stage", stage: "searching" });
      const notify = env.calls[0]!.onActivity!;
      notify("searching"); // Multiple claims can enter the same stage.
      notify("assessing");
      expect(JSON.parse(decoder.decode((await reader.read()).value))).toEqual({ type: "verification-stage", stage: "assessing" });
    } finally {
      finishVerification(makeReport({ claim }));
    }

    const result = await reader.read();
    expect(JSON.parse(decoder.decode(result.value))).toMatchObject({
      type: "reply",
      sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      reply: { kind: "verdict", report: { inputEchoMasked: claim } },
    });
    expect((await reader.read()).done).toBe(true);
  });

  it("czat zwraca wynik z pamięci podręcznej bez komunikatu o sprawdzaniu", async () => {
    const env = makeEnv();
    const body = { text: "Polska należy do Unii Europejskiej od 2004 roku." };
    const original = await chat(env, body);
    const res = await env.app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson", cookie: original.cookie },
      body: JSON.stringify(body),
    });

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ sessionId: original.json.sessionId, reply: { kind: "verdict", report: { cacheHit: true } } });
    expect(env.calls).toHaveLength(1);
  });

  it("GET /api/report/:token zwraca raport, nieznany token to 404", async () => {
    const env = makeEnv();
    const c = await chat(env, { text: "Ziemia jest okrągła" });
    const token = c.json.reply.report.token as string;
    expect(token).toHaveLength(22); // 128 bitów base64url
    const res = await env.app.request(`/api/report/${token}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).mainVerdict).toBe("POTWIERDZONE");
    expect((await env.app.request("/api/report/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await env.app.request("/api/report/..%2F..%2Fetc")).status).toBe(404);
  });

  it("błędy silnika nie wyciekają: brak stosu i treści dostawcy, status to nie werdykt", async () => {
    const env = makeEnv({
      engine: () => {
        throw new Error("PROVIDER_SECRET_MESSAGE sk-ant-123 at /usr/lib/stack");
      },
    });
    const c = await chat(env, { text: "Cokolwiek" });
    const raw = JSON.stringify(c.json);
    expect(raw).not.toContain("PROVIDER_SECRET_MESSAGE");
    expect(raw).not.toContain("sk-ant");
    expect(raw).not.toContain("stack");
    expect(c.json.reply.kind).toBe("status");
    expect(c.json.reply.report).toBeUndefined();
  });

  it("nieprawidłowy JSON i nieznany adres API dają JSON bez szczegółów", async () => {
    const env = makeEnv();
    const bad = await env.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{nie json" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("bad_request");
    const nf = await env.app.request("/api/nie-ma");
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).error).toBe("not_found");
  });

  it("limit rozmiaru ciała: 413", async () => {
    const env = makeEnv();
    const big = "x".repeat(70 * 1024);
    const res = await env.app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: big }) });
    expect(res.status).toBe(413);
  });

  it("produkcja: pliki statyczne i fallback SPA na trasach aplikacji", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const env = makeEnv({ options: { webDistDir: dir } });
    for (const p of ["/", "/w/abcdef", "/zrodla", "/telefon", "/admin"]) {
      const r = await env.app.request(p);
      expect(r.status, p).toBe(200);
      expect(await r.text()).toContain("<title>spa</title>");
    }
    const js = await env.app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(js.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await env.app.request("/assets/brak.js")).status).toBe(404);
    expect((await env.app.request("/cokolwiek")).status).toBe(404);
    expect((await env.app.request("/assets/..%2f..%2fpackage.json")).status).toBe(404);
    // API nadal działa obok statyków
    expect((await env.app.request("/api/health")).status).toBe(200);
  });
});
