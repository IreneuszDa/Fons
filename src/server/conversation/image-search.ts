import { isIP } from "node:net";
import { cleanImage } from "../../engine/image/intake";
import { z } from "zod";
import { catalogSourceForUrl } from "../../corpus/catalog";
import type { ImageSearchResult } from "../../shared/image-search";
import type { ServerContext } from "../context";
import { dayKey } from "../util";

type Image = { mime: string; base64: string };
const LIMIT = 20;
const WEB_DETECTION = "https://vision.googleapis.com/v1/images:annotate";
const FACT_CHECK = "https://factchecktools.googleapis.com/v1alpha1/claims:imageSearch";
const ImageUrl = z.object({ url: z.string().optional() });
const PageMatch = ImageUrl.extend({ pageTitle: z.string().optional(), fullMatchingImages: z.array(ImageUrl).optional() });
const WebDetection = z.object({
  fullMatchingImages: z.array(ImageUrl).default([]),
  partialMatchingImages: z.array(ImageUrl).default([]),
  pagesWithMatchingImages: z.array(PageMatch).default([]),
});
const Annotation = z.object({
  responses: z.array(z.object({
    error: z.object({ code: z.number().optional() }).optional(),
    webDetection: WebDetection.optional(),
  })).length(1),
});
const Review = z.object({
  url: z.string().optional(), title: z.string().optional(), textualRating: z.string().optional(),
  publisher: z.object({ name: z.string().optional() }).optional(),
});
const ClaimResults = z.object({
  results: z.array(z.object({ claim: z.object({ claimReview: z.array(Review).default([]) }) })).default([]),
});

function publicUrl(raw?: string): URL | undefined {
  if (!raw || raw.length > 3000 || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  const host = url.hostname.replace(/\.$/, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port
    || !host.includes(".") || isIP(host) || /\.(?:local|localhost|internal|test|invalid)$/i.test(host)) return undefined;
  url.hash = "";
  return url;
}

function cleanLabel(value: string | undefined, ctx: ServerContext, max: number): string | undefined {
  const text = value?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return text && !ctx.security.hasInjection?.(text) ? ctx.security.maskPii(text).text : undefined;
}

function matchesFrom(web: z.infer<typeof WebDetection>, ctx: ServerContext): ImageSearchResult["matches"] {
  const matches: ImageSearchResult["matches"] = [];
  const seen = new Set<string>();
  const add = (kind: "full" | "partial" | "page", raw?: string, title?: string) => {
    const url = publicUrl(raw);
    if (!url || matches.length >= LIMIT) return;
    const host = url.hostname;
    const showPage = kind === "page" && catalogSourceForUrl(url.href);
    const key = kind + ":" + (showPage ? url.href : host);
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ host, kind, ...(showPage ? { url: url.href, title: cleanLabel(title, ctx, 200) } : {}) });
  };
  for (const p of web.pagesWithMatchingImages) add("page", p.url, p.pageTitle);
  for (const i of web.fullMatchingImages) add("full", i.url);
  for (const i of web.partialMatchingImages) add("partial", i.url);
  return matches;
}

function reserve(ctx: ServerContext): boolean {
  const cap = ctx.cfg.reverseImageDailyCap ?? 500;
  if (!Number.isSafeInteger(cap) || cap <= 0) return false;
  return ctx.db.prepare(`INSERT INTO image_search_usage(day, requests) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET requests = requests + 1 WHERE requests < ?`).run(dayKey(ctx.now()), cap).changes === 1;
}

function result(status: ImageSearchResult["status"], messagePl: string): ImageSearchResult {
  return { status, messagePl, matches: [], factChecks: [], factCheckStatus: "not_applicable" };
}

async function findFactChecks(ctx: ServerContext, fullImage: URL, out: ImageSearchResult): Promise<void> {
  if (!ctx.cfg.factCheckApiKey) {
    out.factCheckStatus = "unavailable";
    out.factCheckMessagePl = "Do wyszukania fact-checków potrzebny jest klucz Fact Check Tools API.";
    return;
  }
  const url = new URL(FACT_CHECK);
  url.searchParams.set("imageUri", fullImage.href);
  url.searchParams.set("pageSize", "10");
  try {
    const res = await ctx.fetch(url, { headers: { "X-Goog-Api-Key": ctx.cfg.factCheckApiKey }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("fact_check_unavailable");
    const { results } = ClaimResults.parse(await res.json());
    const seen = new Set<string>();
    for (const { claim } of results) {
      for (const review of claim.claimReview) {
        const page = publicUrl(review.url);
        if (!page || seen.has(page.href) || out.factChecks.length >= 10) continue;
        seen.add(page.href);
        out.factChecks.push({
          url: page.href, title: cleanLabel(review.title, ctx, 200) ?? page.hostname,
          publisher: cleanLabel(review.publisher?.name, ctx, 100) ?? page.hostname,
          rating: cleanLabel(review.textualRating, ctx, 100),
        });
      }
    }
    out.factCheckStatus = "ok";
  } catch {
    out.factCheckStatus = "unavailable";
    out.factCheckMessagePl = "Google Fact Check Tools nie zwróciło wyniku wyszukiwania dla tego obrazu.";
  }
}

const cooldownUntil = new WeakMap<ServerContext, number>();
const limited = () => result("unavailable", "Wyszukiwanie obrazem w Google osiągnęło limit. Spróbuj później.");

export async function searchImage(image: Image, ctx: ServerContext): Promise<ImageSearchResult> {
  if (ctx.cfg.reverseImageProvider !== "google_vision") return result("disabled", "Wyszukiwanie obrazem w Google jest wyłączone.");
  if (!ctx.cfg.googleVisionApiKey) return result("unavailable", "Do wyszukiwania obrazem potrzebny jest klucz Google Cloud Vision API.");
  if ((cooldownUntil.get(ctx) ?? 0) > ctx.now().getTime()) return limited();
  let copy: Buffer;
  try {
    copy = await cleanImage(image, 1600);
  } catch {
    return result("unavailable", "Nie udało się odczytać obrazu. Wybierz plik JPG, PNG lub WebP do 32 megapikseli.");
  }

  const endpoint = new URL(WEB_DETECTION);
  endpoint.searchParams.set("fields", "responses(error/code,webDetection(fullMatchingImages/url,partialMatchingImages/url,pagesWithMatchingImages(url,pageTitle,fullMatchingImages/url)))");
  const request = JSON.stringify({ requests: [{ image: { content: copy.toString("base64") }, features: [{ type: "WEB_DETECTION", maxResults: LIMIT }] }] });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!reserve(ctx)) return limited();
      const res = await ctx.fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": ctx.cfg.googleVisionApiKey },
        body: request, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) {
        const retry = res.headers.get("Retry-After");
        if (attempt === 0 && retry !== null && /^[012]$/.test(retry.trim())) {
          await new Promise(resolve => setTimeout(resolve, Number(retry) * 1000));
          continue;
        }
        cooldownUntil.set(ctx, ctx.now().getTime() + 60_000);
        return limited();
      }
      if (res.status === 403 || res.status === 401) return result("unavailable", "Google odmówiło dostępu do Cloud Vision. Sprawdź włączenie API, rozliczenia i uprawnienia klucza.");
      if (!res.ok) throw new Error("vision_http_error");
      const response = Annotation.parse(await res.json()).responses[0]!;
      if (response.error?.code === 8) return limited();
      if (response.error) throw new Error("vision_annotation_error");
      const web = response.webDetection ?? WebDetection.parse({});
      const out = result("ok", "Wyniki z indeksu Google Cloud Vision. Dopasowanie może dotyczyć całego obrazu lub jego fragmentu.");
      out.matches = matchesFrom(web, ctx);
      if (!out.matches.length) out.messagePl = "Google Cloud Vision nie zwróciło dopasowań w swoim indeksie.";
      const fullImages = [...web.fullMatchingImages, ...web.pagesWithMatchingImages.flatMap(page => page.fullMatchingImages ?? [])];
      const fullImage = fullImages.map(i => publicUrl(i.url)).find(url => url !== undefined);
      if (fullImage) await findFactChecks(ctx, fullImage, out);
      return out;
    }
  } catch {
    return result("unavailable", "Google Cloud Vision nie zwróciło wyniku wyszukiwania. Spróbuj ponownie za chwilę.");
  }
  return limited();
}
