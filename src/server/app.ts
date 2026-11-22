import { createOpenAiVideoAnalyzer, OpenAiVideoAnalysisError } from "../engine/video/openai-video";
import { AUDIO_MIMES, DOCUMENT_MIMES, IMAGE_MIMES, MAX_ATTACHMENT_BYTES, MAX_RECORDING_BYTES, RECORDING_MIMES } from "../shared/attachments";
/** Fabryka aplikacji Hono: createApp(ctx) — testy używają app.request(). */
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { z } from "zod";
import { CHAT_STREAM_CONTENT_TYPE, type ChatResponse, type ChatStreamEvent, type VerificationStage } from "../shared/chat";
import { InboundMessage, type ChannelAdapter } from "../shared/contracts";
import { createAdminRoutes } from "./admin";
import { authenticateBearerRequest, authorizeMetrics } from "./auth/principal";
import { buildWebInbound } from "./channels/web";
import { createChatLoomWebhook } from "./channels/chatloom";
import type { ServerContext } from "./context";
import { handleInbound, type InboundOptions } from "./conversation";
import { RATE_LIMITED_TEXT } from "./conversation/templates";
import { securityHeaders } from "./headers";
import { GENERIC_ERROR_PL, clientIp, clientKey } from "./http";
import { requestObservability } from "./observability/http";
import { addTokens, budgetExceeded, addClientTokens, clientBudgetExceeded, tokensUsedToday } from "./budget";
import { TOKEN_RE, getReportByToken } from "./reports";
import { eraseSender, findSession, inTurnOrder } from "./sessions";
import { chatSummary, createWebChat, listWebChats, newChatOwner, readChatOwner, readWebChat, recordWebTurn } from "./web-chats";
import { createStaticHandler } from "./static";

export const SESSION_COOKIE = "pw_sid";
const SESSION_COOKIE_MAX_AGE = 7 * 86_400;
const CHAT_BODY_MAX = 8 * 1024 * 1024;
const MAX_RECORDING_BASE64 = Math.ceil(MAX_RECORDING_BYTES / 3) * 4;
const RECORDING_ROUTE = "/api/chat/recording";
const DICTATION_ROUTE = "/api/dictation";
const WEBHOOK_BODY_MAX = 1024 * 1024;
const DEFAULT_BODY_MAX = 64 * 1024;
const DEDUPE_WINDOW_MS = 5 * 60_000;
const MCP_BODY_MAX = 1024 * 1024;

/** Kształt modułu ../mcp/http (pisany równolegle); ładowany dynamicznie, żeby brak modułu nie wywracał serwera. */
interface McpModule {
  createMcpHttpHandler(opts: {
    db: ServerContext["db"];
    deps: unknown;
    cfg?: unknown;
    /** Sprawdza surowy token Bearer; role: "analyst" = wszystkie narzędzia, "reader" = bez verify_claim. */
    authorize: (bearer: string | undefined) => { ok: boolean; role?: string };
  }): (req: Request) => Promise<Response>;
}

const defaultMcpLoader = async (): Promise<unknown> => {
  // zmienna zamiast literału: tsc nie wymaga istnienia modułu, a błąd importu trafia do try/catch
  const spec = "../mcp/http";
  return import(spec);
};

const ChatBody = z.object({
  sessionId: z.string().max(128).optional(),
  text: z.string().max(50_000).optional(),
  action: z.string().max(64).optional(),
  fileName: z.string().max(512).optional(),
  image: z
    .object({ mime: z.enum(IMAGE_MIMES), base64: z.string().max(8_000_000) })
    .optional(),
  document: z.object({ mime: z.enum(DOCUMENT_MIMES), base64: z.string().max(8_000_000) }).optional(),
  recording: z.object({ mime: z.enum(RECORDING_MIMES), base64: z.string().max(MAX_RECORDING_BASE64) }).optional(),
  imageOptions: z.object({ searchWeb: z.boolean().optional() }).optional(),
});

/**
 * Ochrona przed żądaniami z obcych stron (SEC-05): POST z text/plain to „proste” żądanie bez preflightu, więc dowolna
 * strona mogłaby kazać przeglądarkom odwiedzających uruchamiać płatne weryfikacje. Wymagamy JSON (wymusza preflight,
 * który się nie uda, bo nie wysyłamy nagłówków CORS), a Sec-Fetch-Site / Origin — jeśli są — muszą wskazywać tę samą
 * stronę (Host żądania albo PUBLIC_BASE_URL). Klienci spoza przeglądarki (CLI, testy) nie wysyłają tych nagłówków.
 */
export function crossSiteRejection(c: Context, ctx: ServerContext, opts: { requireJson: boolean }): Response | undefined {
  if (opts.requireJson) {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") {
      return c.json({ error: "unsupported_media_type", messagePl: "Nieprawidłowe żądanie." }, 415);
    }
  }
  const site = c.req.header("sec-fetch-site")?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return c.json({ error: "forbidden", messagePl: "Niedozwolone źródło żądania." }, 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      const host = c.req.header("host");
      ok = (!!host && o.host === host) || o.origin === new URL(ctx.cfg.publicBaseUrl).origin;
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "forbidden", messagePl: "Niedozwolone źródło żądania." }, 403);
  }
  return undefined;
}

function imageMagicOk(mime: string, base64: string): boolean {
  let head: Buffer;
  try {
    head = Buffer.from(base64.slice(0, 32), "base64");
  } catch {
    return false;
  }
  if (mime === "image/png") return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === "image/jpeg") return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
}

type WebhookStatus = 200 | 400 | 403 | 502;

/** Wspólna ścieżka webhooka kanału: podpis → parseInbound → deduplikacja → rozmowa → wysłanie odpowiedzi. */
async function processWebhook(
  ctx: ServerContext,
  adapter: ChannelAdapter,
  raw: string,
  headers: Record<string, string | undefined>,
  url: string,
): Promise<{ status: WebhookStatus; body: Record<string, unknown> }> {
  let signatureOk = false;
  try {
    signatureOk = adapter.verifySignature(raw, headers, url) === true;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { status: 403, body: { error: "forbidden", messagePl: "Nieprawidłowy podpis." } };

  let inbound: unknown;
  try {
    inbound = adapter.parseInbound(raw, headers);
  } catch {
    return { status: 400, body: { error: "bad_request", messagePl: "Nieprawidłowa wiadomość." } };
  }
  if (!inbound) return { status: 200, body: { ok: true, ignored: true } };
  const msg = InboundMessage.safeParse(inbound);
  if (!msg.success || msg.data.channel !== adapter.id) return { status: 400, body: { error: "bad_request", messagePl: "Nieprawidłowa wiadomość." } };

  const nowMs = ctx.now().getTime();
  for (const [k, t] of ctx.seenMessages) if (nowMs - t > DEDUPE_WINDOW_MS) ctx.seenMessages.delete(k);
  const dedupeKey = `${adapter.id}:${msg.data.messageId}`;
  if (ctx.seenMessages.has(dedupeKey)) return { status: 200, body: { ok: true, duplicate: true } };
  ctx.seenMessages.set(dedupeKey, nowMs);

  const reply = await handleInbound(msg.data, ctx);
  try {
    await adapter.send({ channel: adapter.id, sessionId: msg.data.sessionId, reply });
  } catch {
    return { status: 502, body: { error: "send_failed", messagePl: "Nie udało się wysłać odpowiedzi." } };
  }
  return { status: 200, body: { ok: true } };
}

export function createApp(ctx: ServerContext): Hono {
  const app = new Hono();
  const secureCookie = ctx.cfg.env === "production" && ctx.cfg.publicBaseUrl.startsWith("https://");
  const ownerFrom = (c: Context) => readChatOwner(ctx, getCookie(c, SESSION_COOKIE));
  const rememberOwner = (c: Context, cookie: string) => setCookie(c, SESSION_COOKIE, cookie,
    { httpOnly: true, sameSite: "Strict", secure: secureCookie, path: "/", maxAge: SESSION_COOKIE_MAX_AGE });
  const missingChat = (c: Context) => c.json({ error: "not_found", messagePl: "Ta rozmowa została usunięta albo wygasła." }, 404);

  app.use("*", requestObservability(ctx));
  app.use("*", securityHeaders(ctx));

  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  let readingRecordings = 0;
  const recordingQueueFull = () => Array.from(ctx.media.keys()).filter(key => key.startsWith("recording_")).length >= 3;
  const recordingBusy = (c: Context) => c.json({ error: "busy", messagePl: "Trwa analiza innych nagrań. Spróbuj ponownie za chwilę." }, 429);
  app.use("/api/*", async (c, next) => {
    if (c.req.path !== RECORDING_ROUTE && c.req.path !== DICTATION_ROUTE) return next();
    const rejection = crossSiteRejection(c, ctx, { requireJson: true });
    if (rejection) return rejection;
    if (readingRecordings >= 3 || recordingQueueFull()) return recordingBusy(c);
    readingRecordings++;
    try { await next(); } finally { readingRecordings--; }
  });
  app.use("/api/*", (c, next) => {
    const p = c.req.path;
    const maxSize = (p === RECORDING_ROUTE || p === DICTATION_ROUTE) ? MAX_RECORDING_BASE64 + 65_536
      : p === "/api/chat" ? CHAT_BODY_MAX : p.startsWith("/api/channels/") ? WEBHOOK_BODY_MAX : DEFAULT_BODY_MAX;
    return bodyLimit({
      maxSize,
      onError: (cc) => cc.json({ error: "payload_too_large", messagePl: "Wiadomość jest za duża." }, 413),
    })(c, next);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse(); // np. 413 z limitu rozmiaru ciała
    // Nigdy nie zwracamy stosu ani treści błędu (dostawcy, bazy) — tylko nazwę błędu w logu operatora.
    ctx.log.error({ event: "unhandled_error", error: err instanceof Error ? err.name : "error", method: c.req.method });
    return c.json({ error: "internal_error", messagePl: GENERIC_ERROR_PL }, 500);
  });

  // ───────── publiczne API ─────────

  app.get("/api/health", (c) => {
    let records = 0;
    let dbOk = true;
    try {
      records = ctx.corpus.count();
      ctx.db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    return c.json({
      ok: dbOk && records > 0,
      corpusRecords: records,
      snapshotId: ctx.engine.snapshotId(),
      llm: ctx.engine.llm,
    });
  });

  app.get("/api/sources", (c) =>
    c.json({ catalog: ctx.corpus.catalog(), counts: ctx.corpus.countsBySource(), snapshotId: ctx.engine.snapshotId() }),
  );

  app.get("/api/report/:token", (c) => {
    const report = getReportByToken(ctx.db, c.req.param("token"), ctx.now());
    if (!report) return c.json({ error: "not_found", messagePl: "Nie ma takiego wyniku albo wygasł." }, 404);
    c.header("Cache-Control", "private, no-store");
    return c.json(report);
  });

  app.get("/api/chats", (c) => {
    const rejected = crossSiteRejection(c, ctx, { requireJson: false });
    if (rejected) return rejected;
    const owner = ownerFrom(c) ?? newChatOwner(ctx);
    rememberOwner(c, owner.cookie);
    return c.json({ chats: listWebChats(ctx, owner.senderId) });
  });

  app.post("/api/chats", (c) => {
    const rejected = crossSiteRejection(c, ctx, { requireJson: true });
    if (rejected) return rejected;
    if (!ctx.limiters.ip.check(`create-chat:${clientKey(clientIp(c, ctx))}`)) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited", messagePl: RATE_LIMITED_TEXT }, 429);
    }
    const owner = ownerFrom(c) ?? newChatOwner(ctx);
    const session = createWebChat(ctx, owner.senderId);
    rememberOwner(c, owner.cookie);
    return c.json({ chat: chatSummary(ctx, owner.senderId, session.id)! }, 201);
  });

  app.get("/api/chats/:id", (c) => {
    const rejected = crossSiteRejection(c, ctx, { requireJson: false });
    if (rejected) return rejected;
    const owner = ownerFrom(c);
    if (!owner) return missingChat(c);
    const detail = readWebChat(ctx, owner.senderId, c.req.param("id"));
    rememberOwner(c, owner.cookie);
    return detail ? c.json(detail) : missingChat(c);
  });

  app.delete("/api/chats/:id", async (c) => {
    const rejected = crossSiteRejection(c, ctx, { requireJson: false });
    if (rejected) return rejected;
    const owner = ownerFrom(c);
    if (!owner) return missingChat(c);
    rememberOwner(c, owner.cookie);
    const id = c.req.param("id");
    return inTurnOrder(ctx, owner.senderId, () => {
      if (!chatSummary(ctx, owner.senderId, id)) return missingChat(c);
      eraseSender(ctx, owner.senderId, id);
      return c.json({ ok: true });
    });
  });

  app.on("POST", ["/api/chat", RECORDING_ROUTE, DICTATION_ROUTE], async (c) => {
    const crossSite = crossSiteRejection(c, ctx, { requireJson: true });
    if (crossSite) return crossSite;
    // IPv6: limit per sieć /64 (jeden abonent), nie per adres.
    const ip = clientKey(clientIp(c, ctx));
    if (!ctx.limiters.ip.check(`ip:${ip}`)) {
      c.header("Retry-After", "60");
      return c.json(
        { sessionId: "", reply: { kind: "rate_limited", textPl: RATE_LIMITED_TEXT, quickReplies: [] } },
        429,
      );
    }
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad_request", messagePl: "Nieprawidłowe żądanie." }, 400);
    const body = parsed.data;
    const attachments = [body.image, body.document, body.recording].filter(file => !!file);
    const attachment = attachments[0];
    if (attachments.length > 1 || (c.req.path !== "/api/chat") !== !!body.recording || (body.action && attachment) || (body.imageOptions && !body.image)) {
      return c.json({ error: "bad_request", messagePl: "Wyślij jeden plik z opcjonalną wiadomością." }, 400);
    }
    if (attachment) {
      const b64 = attachment.base64;
      const limit = body.recording ? MAX_RECORDING_BYTES : MAX_ATTACHMENT_BYTES;
      if (!b64 || b64.length % 4 === 1 || Buffer.byteLength(b64, "base64") > limit || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
        return c.json({ error: "bad_attachment", messagePl: `Nie mogę odczytać pliku. Limit wynosi ${limit / 1024 ** 2} MB.` }, 400);
      }
      if (body.image && !imageMagicOk(body.image.mime, b64)) {
        return c.json({ error: "bad_image", messagePl: "Nie mogę odczytać tego pliku. Wyślij zdjęcie JPG, PNG lub WebP do 5 MB." }, 400);
      }
    }

    if (c.req.path === DICTATION_ROUTE && body.recording) {
      const { mime, base64 } = body.recording;
      if (!AUDIO_MIMES.some(value => value === mime)) return c.json({ messagePl: "Dyktowanie wymaga nagrania audio." }, 400);
      if (!ctx.cfg.openaiApiKey) return c.json({ messagePl: "Dyktowanie jest obecnie niedostępne." }, 503);
      if (budgetExceeded(ctx.db, ctx.cfg, ctx.now()) || clientBudgetExceeded(ctx.clientUsage, ctx.cfg, ip, ctx.now())) {
        return c.json({ messagePl: "Wyczerpano dzisiejszy limit transkrypcji." }, 429);
      }
      const analyze = createOpenAiVideoAnalyzer({ apiKey: ctx.cfg.openaiApiKey, fetchImpl: ctx.fetch, dataResidency: ctx.cfg.openaiDataResidency });
      let tokens = 0;
      try {
        const result = await analyze({ bytes: Buffer.from(base64, "base64"), mimeType: mime }, c.req.raw.signal);
        tokens = [result.usage, ...(result.additionalUsage ?? [])].reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        return c.json({ text: result.data.transcript.map(segment => segment.text).join(" ") });
      } catch (error) {
        if (error instanceof OpenAiVideoAnalysisError) tokens = error.usages.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        return c.json({ messagePl: error instanceof Error && error.message === "audio_no_speech"
          ? "Nie rozpoznano mowy. Spróbuj ponownie." : "Nie udało się przepisać nagrania. Spróbuj ponownie." }, 422);
      } finally {
        addTokens(ctx.db, ctx.now(), tokens);
        addClientTokens(ctx.clientUsage, ip, ctx.now(), tokens);
      }
    }

    // Streaming replies release the HTTP handler before the queued verification frees the file.
    if (body.recording && recordingQueueFull()) return recordingBusy(c);
    const owner = ownerFrom(c) ?? newChatOwner(ctx);
    const selected = chatSummary(ctx, owner.senderId, body.sessionId);
    if (body.sessionId !== undefined && !selected) return missingChat(c);
    // Older clients omit the selector and continue their last conversation.
    const session = selected ? findSession(ctx.db, selected.id)! : createWebChat(ctx, owner.senderId);

    const msg = buildWebInbound(ctx, {
      sessionId: session.id,
      senderId: session.senderId,
      text: body.text,
      action: body.action,
      image: body.image,
      document: body.document,
      recording: body.recording,
      imageOptions: body.imageOptions,
    });
    // Udział jednego klienta w dobowym budżecie (SEC-04): po jego wyczerpaniu ten klient dostaje komunikat
    // o budżecie zamiast nowego przebiegu silnika; trafienia w cache i polecenia działają, inni sprawdzają dalej.
    const acceptsProgress = c.req.header("accept")?.split(",").some((type) => type.trim() === CHAT_STREAM_CONTENT_TYPE);
    let onVerificationStart: InboundOptions["onVerificationStart"];
    const stages = new Set<VerificationStage>();
    let writeStage: InboundOptions["onActivity"];
    const started = acceptsProgress && new Promise<"verification-start">((resolve) => {
      onVerificationStart = () => resolve("verification-start");
    });
    const replyPromise = handleInbound(msg, ctx, {
      onReply: reply => recordWebTurn(ctx, msg, reply, body.fileName),
      clientOverBudget: () => clientBudgetExceeded(ctx.clientUsage, ctx.cfg, ip, ctx.now()),
      onRoutingTokens: (tokens) => addClientTokens(ctx.clientUsage, ip, ctx.now(), tokens),
      onVerificationStart,
      onActivity: acceptsProgress ? (stage) => {
        if (stages.has(stage)) return;
        stages.add(stage);
        writeStage?.(stage);
      } : undefined,
    }).then((reply): ChatResponse => {
      if (reply.report && !reply.report.cacheHit) {
        addClientTokens(ctx.clientUsage, ip, ctx.now(), reply.report.models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0));
      }
      return { sessionId: findSession(ctx.db, session.id) ? session.id : "", reply };
    });

    // Open a stream only when a new verification starts. Other replies keep their JSON status and cookie handling.
    const first = started ? await Promise.race([replyPromise, started]) : await replyPromise;
    if (first !== "verification-start" && first.reply.kind === "deleted") {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    } else {
      rememberOwner(c, owner.cookie);
    }
    if (first !== "verification-start") return c.json(first, first.reply.kind === "rate_limited" ? 429 : 200);

    c.header("Content-Type", CHAT_STREAM_CONTENT_TYPE);
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (output) => {
      let writes = output.writeln(JSON.stringify({ type: "verification-start" } satisfies ChatStreamEvent));
      writeStage = (stage) => {
        writes = writes.then(() => output.writeln(JSON.stringify({ type: "verification-stage", stage } satisfies ChatStreamEvent)));
      };
      // Early stages may have arrived before the client negotiated this stream.
      stages.forEach(writeStage);
      const reply = await replyPromise;
      writeStage = undefined;
      await writes;
      await output.writeln(JSON.stringify({ type: "reply", ...reply } satisfies ChatStreamEvent));
    }, async (err) => {
      ctx.log.error({ event: "chat_stream_error", error: err.name });
    });
  });

  app.delete("/api/session", async (c) => {
    const crossSite = crossSiteRejection(c, ctx, { requireJson: false });
    if (crossSite) return crossSite;
    const owner = ownerFrom(c);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    if (!owner) return c.json({ ok: true, deleted: { reports: 0, runs: 0, cache: 0, caseSenders: 0, sessions: 0 } });
    const deleted = await inTurnOrder(ctx, owner.senderId, () => eraseSender(ctx, owner.senderId));
    return c.json({ ok: true, deleted });
  });

  // ───────── administrator ─────────
  app.route("/api/admin", createAdminRoutes(ctx));

  // ───────── metryki Prometheus (token API analityka albo METRICS_TOKEN) ─────────
  app.get("/metrics", (c) => {
    if (!authorizeMetrics(ctx, c.req.raw)) {
      c.header("WWW-Authenticate", 'Bearer realm="fons-metrics"');
      return c.json({ error: "unauthorized", messagePl: "Wymagany token." }, 401);
    }
    try {
      ctx.metrics.setGauges({
        dailyTokens: tokensUsedToday(ctx.db, ctx.now()),
        corpusRecords: ctx.corpus.count(),
        buildPipeline: ctx.engine.pipelineVersion,
        buildSnapshot: ctx.engine.snapshotId(),
      });
    } catch {
      /* gauge’e są pomocnicze */
    }
    return new Response(ctx.metrics.render(), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
    });
  });

  // ───────── MCP (Streamable HTTP; token API analityka) ─────────
  let mcpHandler: Promise<((req: Request) => Promise<Response>) | null> | undefined;
  const loadMcp = (): Promise<((req: Request) => Promise<Response>) | null> => {
    mcpHandler ??= (async () => {
      try {
        const mod = (await (ctx.options.mcpLoader ?? defaultMcpLoader)()) as Partial<McpModule> | undefined;
        if (typeof mod?.createMcpHttpHandler !== "function") throw new Error("no_handler_export");
        return mod.createMcpHttpHandler({
          db: ctx.db,
          deps: ctx.engineDeps,
          cfg: ctx.cfg,
          // tokeny API mają rolę analityka: wszystkie narzędzia MCP
          authorize: (bearer) => (bearer && ctx.auth.tokens.authenticate(bearer) ? { ok: true, role: "analyst" } : { ok: false }),
        });
      } catch {
        ctx.log.warn({ event: "mcp_unavailable" });
        return null;
      }
    })();
    return mcpHandler;
  };
  const mcpRoute = async (c: Context): Promise<Response> => {
    // Uwierzytelnienie PRZED załadowaniem modułu: bez tokenu nic z MCP się nie wykonuje.
    if (!authenticateBearerRequest(ctx, c.req.raw)) {
      c.header("WWW-Authenticate", 'Bearer realm="fons-mcp"');
      return c.json({ error: "unauthorized", messagePl: "Wymagany token API." }, 401);
    }
    const handler = await loadMcp();
    if (!handler) return c.json({ error: "mcp_unavailable", messagePl: "Interfejs MCP nie jest dostępny w tej instalacji." }, 501);
    return handler(c.req.raw);
  };
  app.use("/mcp", bodyLimit({ maxSize: MCP_BODY_MAX, onError: (cc) => cc.json({ error: "payload_too_large" }, 413) }));
  app.all("/mcp", mcpRoute);
  app.all("/mcp/*", mcpRoute);

  // ───────── kanały wiadomości (webhook) ─────────
  app.post("/api/channels/chatloom/webhook", createChatLoomWebhook(ctx));
  app.post("/api/channels/:id/webhook", async (c) => {
    const adapter = ctx.channels.getWebhook(c.req.param("id"));
    if (!adapter) return c.json({ error: "not_configured", messagePl: "Ten kanał nie jest skonfigurowany." }, 501);

    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const res = await processWebhook(ctx, adapter, raw, headers, c.req.url);
    return c.json(res.body, res.status);
  });

  app.all("/api/*", (c) => c.json({ error: "not_found", messagePl: "Nie ma takiego adresu." }, 404));

  // ───────── statyczne WWW (produkcja) ─────────
  if (ctx.options.webDistDir) app.use("*", createStaticHandler(ctx.options.webDistDir));

  app.notFound((c) => c.text("Nie znaleziono.", 404));
  return app;
}
