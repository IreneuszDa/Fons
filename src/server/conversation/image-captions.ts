import { parseHTML } from "linkedom";
import { z } from "zod";
import { catalogSourceForUrl } from "../../corpus/catalog";
import { parsePresidentPage, PRESIDENT_URL } from "../../corpus/ingest/state-officials";
import { fetchPage } from "../../security/fetch";
import type { ImageCitation } from "../../shared/image-search";
import type { ServerContext } from "../context";

interface PageWithImages {
  url?: string;
  fullMatchingImages?: { url?: string }[];
}

function resourceUrl(value: string | null | undefined, base?: string): string | undefined {
  if (!value) return;
  const u = URL.parse(value, base);
  if (!u || !["https:", "http:"].includes(u.protocol) || u.username || u.password || u.port) return;
  u.hash = "";
  return u.href;
}

function sourceText(value: string | null | undefined, ctx: ServerContext): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  if (!text || text.length > 300 || ctx.security.hasInjection?.(text) || ctx.security.maskPii(text).masked) return;
  return text;
}

const presidentProfile = new URL(PRESIDENT_URL);

function isPresidentialProfile(url: string): boolean {
  const page = new URL(url);
  const path = page.pathname.replace(/\/$/, "");
  return page.origin === presidentProfile.origin && !page.search && (path === presidentProfile.pathname || path === "/prezydent");
}

/** Read only the caption belonging to the exact resource on the page. Article titles often name other people. */
function findCaptions(html: string, base: string, title: string, exactUrls: Set<string>, ctx: ServerContext) {
  const { document } = parseHTML(html);
  const matches = (raw?: string | null) => exactUrls.has(resourceUrl(raw, base) ?? "");
  const captions = new Set<string>();
  const articleImages = isPresidentialProfile(base) ? document.querySelectorAll(".articles-single__description img") : [];
  let matchedProfile = false;
  let matchedImage = false;
  for (const image of document.querySelectorAll("img")) {
    const resources = ["src", "data-src", "data-original"].map(attr => image.getAttribute(attr));
    const sources = [image, ...Array.from(image.closest("picture")?.querySelectorAll("source") ?? [])];
    for (const source of sources) {
      for (const attr of ["srcset", "data-srcset"]) {
        for (const entry of source.getAttribute(attr)?.split(",") ?? []) resources.push(entry.trim().split(/\s+/u)[0] ?? null);
      }
    }
    if (!resources.some(matches)) continue;
    matchedImage = true;
    if (articleImages.length === 1 && image === articleImages[0]) matchedProfile = true;
    const figure = image.closest("figure");
    const attached = figure?.querySelectorAll("img").length === 1 ? figure.querySelector("figcaption")?.textContent : undefined;
    for (const value of [attached, image.getAttribute("alt")]) {
      const quote = sourceText(value, ctx);
      if (quote && !/^[^\s]*\.(?:jpe?g|png|webp)(?:\s*\[[^\]]*\])?$/i.test(quote)) captions.add(quote);
    }
  }
  // OG permits several images, each followed by its own image:alt.
  let matchedOgImage = false;
  for (const meta of document.querySelectorAll("meta[property]")) {
    const property = meta.getAttribute("property")?.toLowerCase();
    if (property === "og:image" || property === "og:image:url") {
      matchedOgImage = matches(meta.getAttribute("content"));
      if (matchedOgImage) matchedImage = true;
    }
    if (property === "og:image:alt" && matchedOgImage) {
      const quote = sourceText(meta.getAttribute("content"), ctx);
      if (quote) captions.add(quote);
    }
  }
  const items: ImageCitation[] = [...captions].slice(0, 4).map(quote => ({ url: base, title, quote }));
  if (matchedProfile) {
    const profile = parsePresidentPage(html);
    const heading = sourceText(profile?.heading, ctx);
    if (profile?.officeSentences.length && heading) items.unshift({ kind: "official_profile", url: base, title: heading, quote: heading });
  }
  return { matchedImage, captions: items };
}

export async function readMatchedPublications(
  ctx: ServerContext, pages: PageWithImages[], globalImages: { url?: string }[],
) {
  const fetcher = ctx.engineDeps?.fetchPage ?? fetchPage;
  const candidates = new Map<string, Set<string>>();
  for (const page of pages) {
    const url = resourceUrl(page.url);
    if (!url || !catalogSourceForUrl(url)) continue;
    const exact = candidates.get(url) ?? new Set<string>();
    for (const item of [...(page.fullMatchingImages ?? []), ...globalImages]) {
      const imageUrl = resourceUrl(item.url);
      if (imageUrl) exact.add(imageUrl);
    }
    if (exact.size) candidates.set(url, exact);
  }
  const prioritized = [...candidates].sort(([a], [b]) => Number(isPresidentialProfile(b)) - Number(isPresidentialProfile(a)));
  const results = await Promise.all(prioritized.slice(0, 3).map(async ([url, exact]) => {
    try {
      const page = await fetcher(url, { timeoutMs: 4500, maxBytes: 1_500_000, allowUrl: u => !!catalogSourceForUrl(u.href) });
      const source = catalogSourceForUrl(page.finalUrl);
      if (!source || !page.rawHtml || !resourceUrl(page.finalUrl)) return [];
      const title = sourceText(page.title, ctx) ?? source.publisher;
      const { matchedImage, captions } = findCaptions(page.rawHtml, page.finalUrl, title, exact, ctx);
      if (!matchedImage) return [];
      const day = page.publishedAt?.slice(0, 10);
      const publishedAt = day && z.iso.date().safeParse(day).success && day <= ctx.now().toISOString().slice(0, 10) ? day : undefined;
      return [{ url, publishedAt, captions }];
    } catch {
      return [];
    }
  }));
  return results.flat();
}
