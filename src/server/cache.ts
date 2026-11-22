/**
 * Cache obliczeń (PLAN §3): klucz = hash(znormalizowane wejście) + migawka + wersja potoku.
 * TTL 48 h; 15 min gdy gałąź opcjonalna była niedostępna albo gdy sprawdzanie korzysta ze źródeł na żywo
 * (stan „na teraz”: alerty, ostrzeżenia dla podróżujących); zapisujemy wyłącznie status OK.
 */
import { createHash } from "node:crypto";
import { VerdictReport } from "../shared/contracts";
import { relativeWindowDay } from "../security/dates";
import { publicPostUrl, socialVideoPlatform } from "../engine/video/platforms";
import { selectedVideoProvider } from "./config";
import type { Db, EngineRequest, ServerContext } from "./context";
import { sha256Hex } from "./util";

export const CACHE_TTL_MS = 48 * 3_600_000;
export const CACHE_TTL_DEGRADED_MS = 15 * 60_000;
/** Wynik oparty na źródłach pobieranych na żywo szybko się starzeje („czy jest teraz alert?”). */
export const CACHE_TTL_LIVE_MS = 15 * 60_000;

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|igshid$|ref$)/i;

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
    keep.sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return url.trim();
  }
}

/** Usuwa parametry śledzące z każdego adresu http(s) w tekście (np. mc_eid pierwszego zgłaszającego — SEC-08). */
export function stripTrackingParams(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      if (![...u.searchParams.keys()].some((k) => TRACKING_PARAMS.test(k))) return url;
      for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return url;
    }
  });
}

function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Klucz cache z wejścia po maskowaniu PII i zamianie dat względnych na bezwzględne. */
export function computeCacheKey(ctx: ServerContext, req: EngineRequest): string {
  const receivedAt = new Date(req.receivedAt);
  let normalized: string;
  if (req.kind === "url" && req.url) {
    normalized = canonicalUrl(req.url);
    if (socialVideoPlatform(req.url)) {
      const provider = selectedVideoProvider(ctx.cfg);
      const model = provider === "openai" ? ctx.cfg.openaiVideoModel : ctx.cfg.geminiVideoModel;
      const enabled = provider === "openai" ? !!ctx.cfg.openaiApiKey : provider === "gemini" && !!ctx.cfg.geminiApiKey;
      normalized = JSON.stringify([publicPostUrl(req.url), provider, model ?? "default", enabled,
        provider === "openai" ? ctx.cfg.openaiDataResidency : undefined, !!ctx.cfg.socialKitApiKey]);
    }
    // The same article can be submitted for different claims.
    if (req.text?.trim()) {
      const note = normalizeText(ctx.security.resolveRelativeDates(ctx.security.maskPii(req.text).text, receivedAt));
      normalized = JSON.stringify([normalized, note]);
    }
  } else if (req.kind === "image") {
    const h = createHash("sha256");
    for (const img of req.images ?? []) h.update(img.mime).update(img.base64);
    const caption = ctx.security.maskPii(req.text ?? "").text;
    normalized = JSON.stringify(["image-analysis-v4", h.digest("hex"), normalizeText(ctx.security.resolveRelativeDates(caption, receivedAt)), req.imageOptions?.searchWeb, req.imageFocus]);
  } else {
    const masked = ctx.security.maskPii(req.text ?? "").text;
    normalized = normalizeText(ctx.security.resolveRelativeDates(masked, receivedAt));
  }
  const asOf = relativeWindowDay(req.text ?? "", receivedAt);
  if (asOf) normalized = JSON.stringify([normalized, asOf]);
  return sha256Hex(
    // Źródła na żywo zmieniają wynik, więc wynik z zamkniętego korpusu nie może być podany po ich włączeniu (i odwrotnie).
    [req.kind, normalized, ctx.engine.snapshotId(), ctx.engine.pipelineVersion, ctx.cfg.verdictMode, ctx.cfg.liveSearch ? "live" : "closed"].join(
      "\u0001",
    ),
  );
}

export function getCached(db: Db, key: string, now: Date): VerdictReport | undefined {
  const row = db
    .prepare("SELECT report_json, expires_at FROM computation_cache WHERE cache_key = ?")
    .get(key) as { report_json: string; expires_at: string } | undefined;
  if (!row) return undefined;
  if (row.expires_at <= now.toISOString()) {
    db.prepare("DELETE FROM computation_cache WHERE cache_key = ?").run(key);
    return undefined;
  }
  try {
    return VerdictReport.parse(JSON.parse(row.report_json));
  } catch {
    db.prepare("DELETE FROM computation_cache WHERE cache_key = ?").run(key);
    return undefined;
  }
}

/** Zapisuje wynik do cache. Zwraca false, gdy status nie kwalifikuje się do zapisu. */
export function putCached(
  db: Db,
  key: string,
  report: VerdictReport,
  now: Date,
  owner: { senderId?: string; sessionId?: string },
  opts: { liveSearch?: boolean } = {},
): boolean {
  if (report.status !== "OK") return false;
  if (report.videoAnalysis && report.videoAnalysis.status !== "analyzed") return false;
  if (report.imageAnalysis?.images.some(({ provenance, search }) =>
    provenance.credential === "unavailable" || (search && (search.status !== "ok" || search.factCheckStatus === "unavailable")))) return false;
  // Klucz skasowany przez „usuń moje dane” (SEC-02): wynik trafia tylko do pytającego, nie do cache.
  try {
    const tomb = db.prepare("SELECT until FROM cache_tombstones WHERE cache_key = ?").get(key) as { until: string } | undefined;
    if (tomb && tomb.until > now.toISOString()) return false;
  } catch {
    /* starsza baza bez tabeli nagrobków — zachowanie jak dawniej */
  }
  const ttl =
    report.unavailableBranches.length > 0 ? CACHE_TTL_DEGRADED_MS : (opts.liveSearch || report.videoAnalysis || report.imageAnalysis?.images.some(image => image.search)) ? CACHE_TTL_LIVE_MS : CACHE_TTL_MS;
  // Wynik współdzielony: bez identyfikatorów śledzących pierwszego zgłaszającego w adresie wejścia.
  const stored: VerdictReport = {
    ...report,
    token: "",
    moderatorCase: undefined,
    cacheHit: false,
    inputEchoMasked: stripTrackingParams(report.inputEchoMasked),
  };
  db.prepare(
    `INSERT OR REPLACE INTO computation_cache (cache_key, report_json, created_at, expires_at, sender_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    JSON.stringify(stored),
    now.toISOString(),
    new Date(now.getTime() + ttl).toISOString(),
    owner.senderId ?? null,
    owner.sessionId ?? null,
  );
  return true;
}

export function invalidateCache(db: Db, opts: { key?: string; all?: boolean }): number {
  if (opts.all) return db.prepare("DELETE FROM computation_cache").run().changes;
  if (opts.key) return db.prepare("DELETE FROM computation_cache WHERE cache_key = ?").run(opts.key).changes;
  return 0;
}
