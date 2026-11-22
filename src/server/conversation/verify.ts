/**
 * Przepływ weryfikacji: cache → bezpiecznik budżetu → silnik → zapis (raport, dziennik, zdarzenia,
 * sprawa moderatora). Wszystko, co dotyczy użytkownika, powstaje DOPIERO po udanym zapisie.
 */
import { reportEvidence, VerdictReport, type ConversationReply, type InboundMessage } from "../../shared/contracts";
import { socialVideoPlatform } from "../../engine/video/platforms";
import { asksForMediaMetadata } from "../../engine/video/intake";
import { asksAboutDemagogReview } from "../../engine/retrieval/google-claimreview";
import { appendRun } from "../audit";
import { addTokens, budgetExceeded } from "../budget";
import { computeCacheKey, getCached, putCached } from "../cache";
import type { EngineRequest, ServerContext } from "../context";
import { recordUnresolved, type CaseOutcome } from "../moderator/cases";
import { currentRequestId } from "../observability/logger";
import { observeVerification } from "../observability/http";
import { saveReport } from "../reports";
import { saveSessionState, type SessionRow } from "../sessions";
import { newRequestId, newToken, safeHttpUrl, truncate } from "../util";
import { analyzeImage, UnreadableImage } from "./analyze-image";
import type { InboundOptions } from "./index";
import { linksIn } from "./history";
import { BUDGET_TEXT, CASE_FAILED_TEXT, IMAGE_REJECTED_TEXT, QR, TECH_ERROR_TEXT, TOO_LONG_TEXT, caseNote, shortAnswerFor, shortAnswerText, statusTextFor, verdictText } from "./templates";

export interface BuiltRequest {
  req?: EngineRequest;
  reject?: ConversationReply;
  /** Zamaskowany podgląd wejścia do dziennika (gdy silnik nie zwróci raportu). */
  logInput: string;
  mediaRefs: string[];
}

function statusReply(text: string): ConversationReply {
  return { kind: "status", textPl: text, quickReplies: [QR.help] };
}

function logUrl(raw: string): string {
  const u = safeHttpUrl(raw);
  if (!u) return "[adres]";
  const p = new URL(u);
  return `${p.origin}${p.pathname}`; // bez zapytania i fragmentu — mogą zawierać dane osobowe
}

export function buildEngineRequest(msg: InboundMessage, ctx: ServerContext): BuiltRequest {
  const mediaRefs = msg.images.map((i) => i.dataRef);
  const text = msg.text.trim();
  if (msg.recording) {
    const recording = ctx.media.get(msg.recording.dataRef);
    const logInput = "[nagranie]";
    if (!recording) return { reject: statusReply("Dodaj nagranie ponownie."), logInput, mediaRefs };
    if (text.length > ctx.options.maxInputChars) return { reject: statusReply(TOO_LONG_TEXT(ctx.options.maxInputChars)), logInput, mediaRefs };
    return { req: { kind: "recording", recording, text, channel: msg.channel, receivedAt: msg.receivedAt }, logInput, mediaRefs };
  }

  if (msg.images.length > 0) {
    const images = [];
    for (const img of msg.images) {
      const m = ctx.media.get(img.dataRef);
      if (!m) return { reject: statusReply(IMAGE_REJECTED_TEXT), logInput: "[obraz]", mediaRefs };
      images.push({ mime: m.mime, base64: m.base64 });
    }
    if (text.length > ctx.options.maxInputChars) {
      return { reject: statusReply(TOO_LONG_TEXT(ctx.options.maxInputChars)), logInput: "[obraz]", mediaRefs };
    }
    return {
      req: { kind: "image", images, imageOptions: msg.imageOptions, ...(text ? { text } : {}),
        ...(msg.compareImages && images.length === 2 && { imageFocus: "comparison" }), channel: msg.channel, receivedAt: msg.receivedAt },
      logInput: "[obraz]",
      mediaRefs,
    };
  }

  if (text.length > ctx.options.maxInputChars) {
    return { reject: statusReply(TOO_LONG_TEXT(ctx.options.maxInputChars)), logInput: "", mediaRefs };
  }
  // Mobile share sheets include the scheme, but a post address pasted by hand can start at the host.
  const withScheme = text.replace(/(?<!\S)(?:[\w-]+\.)*(?:tiktok\.com|instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.me|youtube\.com|youtube-nocookie\.com|youtu\.be)\//gi, host => "https://" + host);
  const links = linksIn(withScheme);
  const videos = links.filter(url => socialVideoPlatform(url));
  if (videos.length && links.length > 1) {
    return { reject: statusReply("Wklej osobno link do filmu, który chcesz sprawdzić."), logInput: "", mediaRefs };
  }
  if (links.length === 1) {
    const url = links[0]!;
    const focus = withScheme.replace(url, "").trim();
    return {
      req: { kind: "url", url, ...(/\p{L}/u.test(focus) && { text: focus }), channel: msg.channel, receivedAt: msg.receivedAt },
      logInput: logUrl(url), mediaRefs,
    };
  }
  return {
    req: { kind: "text", text, channel: msg.channel, receivedAt: msg.receivedAt },
    logInput: truncate(ctx.security.maskPii(text).text, 1000),
    mediaRefs,
  };
}

function mainClaimText(report: VerdictReport): string {
  const main = report.claims.find((c) => c.isMain) ?? report.claims[0];
  return main?.text?.trim() || report.inputEchoMasked;
}

export function resultUrlFor(ctx: ServerContext, token: string): string {
  return `${ctx.cfg.publicBaseUrl.replace(/\/+$/, "")}/w/${token}`;
}

export async function runVerification(
  ctx: ServerContext,
  msg: InboundMessage,
  session: SessionRow,
  built: { req: EngineRequest; logInput: string },
  opts: Pick<InboundOptions, "clientOverBudget" | "onVerificationStart" | "onActivity"> = {},
): Promise<ConversationReply> {
  const t0 = performance.now();
  const { req } = built;
  const now = ctx.now();
  const nowIso = now.toISOString();
  // Identyfikator żądania HTTP (X-Request-Id) jest też identyfikatorem przebiegu i raportu;
  // gdy ten sam identyfikator był już użyty w dzienniku (kilka weryfikacji w jednym żądaniu), losujemy nowy.
  const httpReqId = currentRequestId();
  const requestId =
    httpReqId && !ctx.db.prepare("SELECT 1 FROM runs WHERE request_id = ?").get(httpReqId) ? httpReqId : newRequestId();
  const owner = { senderId: session.senderId, sessionId: session.id };

  const logRun = (p: {
    status: string;
    verdict: string | null;
    report?: VerdictReport;
    cacheHit: boolean;
    input: string;
  }): void => {
    appendRun(ctx.db, {
      requestId,
      createdAt: nowIso,
      channel: msg.channel,
      inputKind: req.kind,
      inputMasked: p.input,
      senderId: session.senderId,
      sessionId: session.id,
      status: p.status,
      verdict: p.verdict,
      recordIds: p.report ? [...new Set([
        ...reportEvidence(p.report).map(e => e.recordId),
        ...(p.report.imageAnalysis?.images.flatMap(image => image.localSearch?.matches.flatMap(match => match.recordId ? [match.recordId] : []) ?? []) ?? []),
      ])] : [],
      models: p.cacheHit || !p.report ? [] : p.report.models,
      timingsMs: p.cacheHit || !p.report ? {} : p.report.timingsMs,
      costUsd: p.cacheHit || !p.report ? 0 : p.report.costUsd,
      latencyMs: performance.now() - t0,
      cacheHit: p.cacheHit,
      securityEventCount: p.report?.securityEvents.length ?? 0,
      unavailable: p.cacheHit ? [] : (p.report?.unavailableBranches ?? []),
      pipelineVersion: ctx.engine.pipelineVersion,
      snapshotId: ctx.engine.snapshotId(),
    });
    observeVerification(ctx, {
      reqId: requestId,
      report: p.report,
      status: p.status,
      verdict: p.verdict,
      channel: msg.channel,
      cacheHit: p.cacheHit,
      latencyMs: performance.now() - t0,
    });
  };

  // 1. cache (trafienie nic nie kosztuje, więc przed bezpiecznikiem budżetu)
  // A URL can change or disappear. Read the current public article before reusing a result.
  const articleRead = req.kind === "url" && req.url && !socialVideoPlatform(req.url)
    ? await ctx.engine.readArticle?.(req) : undefined;
  const digest = computeCacheKey(ctx, req, articleRead?.ok ? articleRead.normalized : undefined);
  const privateAttachment = req.kind === "recording" || req.kind === "image" || !!msg.document;
  const key = privateAttachment ? `${session.id}:${digest}` : digest;
  const freshIndex = req.kind === "text" && asksAboutDemagogReview(req.text ?? "");
  const canCache = !freshIndex && articleRead?.ok !== false;
  const cached = canCache ? getCached(ctx.db, key, now) : undefined;
  let base: VerdictReport;
  let cacheHit = false;

  if (cached) {
    base = cached;
    cacheHit = true;
  } else {
    // Rozmowa mogła właśnie wyczerpać budżet. Trafienia w cache pozostają bezpłatne.
    const localMetadata = req.kind === "recording" && asksForMediaMetadata(req.text ?? "");
    const needsModel = !localMetadata && (req.kind !== "image" || !["origin", "copies", "context", "comparison"].includes(req.imageFocus ?? ""));
    if (needsModel && (opts.clientOverBudget?.() || budgetExceeded(ctx.db, ctx.cfg, now))) {
      logRun({ status: "NIEPELNE", verdict: null, cacheHit: false, input: built.logInput });
      return statusReply(BUDGET_TEXT);
    }
    // 3. silnik
    try {
      opts.onVerificationStart?.();
      const request = { ...req, requestId, onActivity: opts.onActivity };
      const raw = req.kind === "image" ? await analyzeImage(ctx, request) : await ctx.engine.verify(request, articleRead);
      const parsed = VerdictReport.safeParse(raw);
      if (!parsed.success) throw new Error("report_schema");
      base = parsed.data;
    } catch (error) {
      if (error instanceof UnreadableImage) return statusReply("Nie udało się odczytać obrazu. Wyślij statyczny plik JPG, PNG lub WebP do 32 megapikseli.");
      // treść błędu (dostawcy, sieci) nigdy nie trafia do użytkownika ani do logu
      logRun({ status: "AWARIA", verdict: null, cacheHit: false, input: built.logInput });
      return statusReply(TECH_ERROR_TEXT);
    }
  }

  // 4. kopia raportu dla tego użytkownika: nowy token, nowy identyfikator, cacheHit
  const report: VerdictReport = {
    ...base,
    id: requestId,
    token: newToken(),
    createdAt: nowIso,
    cacheHit,
    moderatorCase: undefined,
    costUsd: cacheHit ? 0 : base.costUsd,
    ...(cacheHit && base.costStatus && { costStatus: undefined }),
    // druga linia obrony: wejście w raporcie i w logu jest zawsze zamaskowane
    inputEchoMasked: ctx.security.maskPii(base.inputEchoMasked).text,
  };
  if (report.status !== "OK") {
    report.mainVerdict = null; // status techniczny nigdy nie jest werdyktem
    report.verdicts = [];
  }
  if (!cacheHit && canCache) putCached(ctx.db, key, report, now, owner, { liveSearch: ctx.cfg.liveSearch });

  // 5. pętla informacji: tylko status OK i brak dowodów
  let outcome: CaseOutcome | undefined;
  let caseFailed = false;
  if (report.status === "OK" && report.mainVerdict === "BRAK_DOWODOW") {
    try {
      outcome = await recordUnresolved(ctx, { text: mainClaimText(report), senderId: session.senderId, channel: msg.channel });
      report.moderatorCase = { caseId: outcome.caseId, action: outcome.action };
    } catch {
      caseFailed = true; // zapis się nie udał: żadnej wzmianki o sprawie w raporcie
    }
  }

  // 6. zapisy
  saveReport(ctx.db, report, owner, now);
  logRun({ status: report.status, verdict: report.mainVerdict, report, cacheHit, input: report.inputEchoMasked });
  const insEv = ctx.db.prepare(
    `INSERT INTO security_events (request_id, sender_id, session_id, created_at, source, location, record_id, pattern, excerpt, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ev of report.securityEvents) {
    insEv.run(requestId, session.senderId, session.id, nowIso, cacheHit ? "cache_replay" : "engine", ev.location, ev.recordId ?? null, ev.pattern, ctx.security.maskPii(ev.excerpt).text, ev.severity);
  }
  if (!cacheHit) addTokens(ctx.db, now, report.models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0));
  saveSessionState(ctx, session.id, { ...session.state, pending: undefined, lastReportToken: report.token });

  // 7. odpowiedź
  const note = outcome ? caseNote(outcome) : caseFailed ? CASE_FAILED_TEXT : undefined;
  const resultUrl = resultUrlFor(ctx, report.token);
  if (report.imageAnalysis?.only) {
    return { kind: "image_analysis", report, textPl: report.summaryPl, quickReplies: [], resultUrl };
  }
  if (report.status !== "OK") {
    return { kind: "status", report, textPl: statusTextFor(report), quickReplies: [QR.help], resultUrl };
  }
  if (report.inputMode === "transcription") {
    const textPl = "Automatyczna transkrypcja\n\n" + report.summaryPl;
    return { kind: "transcription", report, textPl, shortAnswer: { bodyPl: textPl, sources: [] }, quickReplies: [], resultUrl };
  }
  if (report.videoAnalysis?.status === "metadata_only") {
    return { kind: "answer", report, textPl: report.summaryPl, shortAnswer: { bodyPl: report.summaryPl, sources: [] }, quickReplies: [], resultUrl };
  }
  if (report.answer || report.inputMode !== "claim" || (!report.videoAnalysis && !report.imageAnalysis)) {
    const shortAnswer = shortAnswerFor(report, note);
    return { kind: report.answer || report.questionParts ? "answer" : "verdict", report, shortAnswer,
      textPl: shortAnswerText(shortAnswer, report), quickReplies: [], resultUrl };
  }
  return {
    kind: "verdict", report, textPl: verdictText(report), quickReplies: [], resultUrl,
  };
}
