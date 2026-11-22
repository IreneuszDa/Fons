import { parseHTML } from "linkedom";
import { fetchPublicResource, FetchBlockedError } from "../../security/fetch";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SocialVideoSourceError, videoMime } from "./social-source";

interface FacebookPost {
  platform: "facebook";
  url: URL;
  id?: string;
}

interface FacebookMetadata {
  caption: string;
  mediaUrls: string[];
  author?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

const pageHosts = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"]);
const shortHosts = new Set(["fb.watch", "fb.me"]);
const idPattern = /^\d{1,25}$/;

export function parseFacebookPost(raw: string, acceptPostPermalink = false): FacebookPost | undefined {
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return;
  const path = url.pathname;
  let id: string | undefined;
  let keepVideoQuery = false;
  if (shortHosts.has(url.hostname)) {
    if (!/^\/[A-Za-z0-9_-]{1,150}\/?$/.test(path)) return;
  } else if (pageHosts.has(url.hostname)) {
    if (/^\/(?:watch\/?|video\.php)$/.test(path)) {
      const values = url.searchParams.getAll("v");
      if (values.length !== 1 || !idPattern.test(values[0]!)) return;
      id = values[0];
      keepVideoQuery = true;
    } else if (!/^\/share\/(?:(?:r|v|p)\/)?[A-Za-z0-9_-]{1,150}\/?$/.test(path)) {
      id = /^\/(?:reels?|(?:[\w.-]+\/)?videos(?:\/[\w.-]+)?)\/(\d{1,25})\/?$/.exec(path)?.[1];
      if (!id && acceptPostPermalink) id = /^\/[\w.-]+\/posts\/(\d{1,25}|pfbid[\w-]{1,150})\/?$/.exec(path)?.[1];
      if (!id) return;
    }
  } else return;
  url.protocol = "https:";
  url.hash = "";
  url.search = "";
  if (keepVideoQuery && id) url.searchParams.set("v", id);
  return { platform: "facebook", url, ...(id && { id }) };
}

function facebookMediaAllowed(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && (pageHosts.has(url.hostname) || url.hostname === "fbcdn.net" || url.hostname.endsWith(".fbcdn.net"));
}

function mediaUrl(value: unknown): string | undefined {
  const url = typeof value === "string" && URL.parse(value);
  return url && facebookMediaAllowed(url) ? url.href : undefined;
}

function clean(value: unknown, max = 8_000): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined;
}

function authorFromTitle(title: string) {
  const parts = title.split(/\s+\|\s+/);
  const hasStats = /wyświetleń|reakcji|views|reactions/i.test(parts[0]!);
  if (hasStats) parts.shift();
  if (parts.length > 2 && parts.at(-1) === "Facebook") parts.pop();
  const author = parts.at(-1);
  if (parts.length >= 2 && (author !== "Facebook" || hasStats)) return author;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readPlayerData(doc: ReturnType<typeof parseHTML>["document"], id: string, details: FacebookMetadata) {
  for (const script of doc.querySelectorAll("script")) {
    const raw = script.textContent ?? "";
    if (!raw.includes('"' + id + '"')) continue;
    let payload: unknown;
    try {
      if (script.getAttribute("type") === "application/json") {
        payload = JSON.parse(raw);
      } else {
        // The official embed gives its initialization data to ServerJS.handle(). Parse the JSON argument only.
        const start = raw.indexOf(".handle({");
        const end = raw.indexOf(");requireLazy", start);
        if (start < 0 || end < 0 || !raw.includes('"VideoConfig"')) continue;
        payload = JSON.parse(raw.slice(start + ".handle(".length, end));
      }
    } catch { continue; }
    const nodes: unknown[] = [payload];
    while (nodes.length) {
      const next = nodes.pop();
      if (!next || typeof next !== "object") continue;
      for (const child of Object.values(next)) {
        if (child && typeof child === "object") nodes.push(child);
      }
      const data = record(next);
      if (!data || (data.video_id !== id && !(data.id === id && data.__typename === "Video"))) continue;
      if (data.is_live_stream === true || data.is_playable === false || data.is_video_broadcast === true) continue;
      const delivery = record(data.videoDeliveryLegacyFields);
      for (const value of [data.sd_src, data.browser_native_sd_url, delivery?.browser_native_sd_url, data.playable_url,
        data.hd_src, data.browser_native_hd_url, delivery?.browser_native_hd_url, data.playable_url_quality_hd]) {
        const address = mediaUrl(value);
        if (address && !details.mediaUrls.includes(address)) details.mediaUrls.push(address);
      }
      const preferredThumbnail = record(data.preferred_thumbnail);
      details.thumbnailUrl ??= mediaUrl(record(preferredThumbnail?.image)?.uri ?? preferredThumbnail?.uri ?? record(data.thumbnailImage)?.uri);
      details.author ??= clean(record(data.owner)?.name, 200);
      if (!details.caption) details.caption = clean(record(data.savable_description)?.text) ?? "";
      if (typeof data.playable_duration_in_ms === "number" && data.playable_duration_in_ms > 0) {
        details.durationSeconds ??= data.playable_duration_in_ms / 1_000;
      }
    }
  }
}

const htmlOptions = { mimeTypes: ["text/html", "application/xhtml+xml"], maxBytes: 3 * 1024 * 1024, timeoutMs: 8_000 };

async function readFacebookPost(raw: string, signal: AbortSignal, includeMedia: boolean) {
  const submitted = parseFacebookPost(raw);
  if (!submitted) throw new SocialVideoSourceError("unsupported");
  const page = await fetchPublicResource(submitted.url.href, {
    ...htmlOptions, signal,
    allowUrl: url => {
      const next = parseFacebookPost(url.href, !submitted.id);
      return url.protocol === "https:" && !!next && (!submitted.id || next.id === submitted.id);
    },
  });
  const final = parseFacebookPost(page.finalUrl, !submitted.id);
  if (!final || (submitted.id && final.id !== submitted.id)) throw new SocialVideoSourceError("unavailable");
  const doc = parseHTML(page.bytes.toString("utf8")).document;
  const meta = (key: string) => doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content") ?? "";
  const canonicalRaw = meta("og:url") || doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonical = canonicalRaw && parseFacebookPost(canonicalRaw, true);
  if (canonicalRaw && (!canonical || !canonical.id || (final.id && canonical.id !== final.id))) {
    throw new SocialVideoSourceError("unavailable");
  }
  const post = canonical || final;
  if (!post.id) throw new SocialVideoSourceError("unavailable");
  const details: FacebookMetadata = { caption: "", mediaUrls: [] };
  if (canonical) {
    details.caption = clean(meta("og:description") || meta("description")) ?? "";
    details.author = clean(meta("author") || authorFromTitle(meta("og:title")), 200);
    details.thumbnailUrl = mediaUrl(meta("og:image:secure_url") || meta("og:image") || meta("twitter:image"));
    for (const key of ["og:video:secure_url", "og:video:url", "og:video"]) {
      const address = mediaUrl(meta(key));
      if (!address) continue;
      const url = new URL(address);
      if (pageHosts.has(url.hostname) && (url.pathname === "/plugins/video.php" || parseFacebookPost(address))) continue;
      if (!details.mediaUrls.includes(address)) details.mediaUrls.push(address);
    }
    const duration = Number(meta("video:duration"));
    if (Number.isFinite(duration) && duration > 0) details.durationSeconds = duration;
  }
  if (includeMedia || !details.caption || !details.author || !details.thumbnailUrl) readPlayerData(doc, post.id, details);
  if (includeMedia && canonical && !details.mediaUrls.length && !post.url.pathname.includes("/posts/")) {
    const embed = new URL("https://www.facebook.com/plugins/video.php");
    embed.searchParams.set("href", post.url.href);
    embed.searchParams.set("show_text", "false");
    try {
      const player = await fetchPublicResource(embed.href, { ...htmlOptions, signal, allowUrl: url => url.href === embed.href });
      readPlayerData(parseHTML(player.bytes.toString("utf8")).document, post.id, details);
    } catch {
      // Keep the page metadata even if its public embed is unavailable.
      if (signal.aborted) throw new SocialVideoSourceError("unavailable", details.caption, { ...details, url: post.url.href });
    }
  }
  return { url: post.url.href, ...details };
}

function deadline(signal: AbortSignal | undefined, ms: number) {
  const timer = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

export async function loadFacebookCaption(raw: string, signal?: AbortSignal) {
  try {
    const { url, caption, author, thumbnailUrl } = await readFacebookPost(raw, deadline(signal, 10_000), false);
    return { url, caption, author, thumbnailUrl };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SocialVideoSourceError) throw error;
    throw new SocialVideoSourceError("unavailable");
  }
}

export async function loadFacebookVideo(raw: string, signal?: AbortSignal) {
  const active = deadline(signal, 32_000);
  let post: Awaited<ReturnType<typeof readFacebookPost>> | undefined;
  try {
    post = await readFacebookPost(raw, active, true);
    const { url, caption, author, thumbnailUrl, durationSeconds } = post;
    if ((durationSeconds ?? 0) > MAX_VIDEO_SECONDS) throw new SocialVideoSourceError("too_large", caption, post);
    let tooLarge = false;
    for (const address of post.mediaUrls.slice(0, 3)) {
      try {
        const media = await fetchPublicResource(address, {
          mimeTypes: ["video/mp4", "application/octet-stream"], maxBytes: MAX_VIDEO_BYTES, timeoutMs: 14_000, signal: active,
          allowUrl: facebookMediaAllowed,
        });
        const mimeType = videoMime(media.bytes, media.mime);
        if (mimeType === "video/mp4") {
          return { platform: "facebook" as const, url, caption, author, thumbnailUrl, durationSeconds, bytes: media.bytes, mimeType };
        }
      } catch (error) {
        active.throwIfAborted();
        if (error instanceof FetchBlockedError && error.reason === "too_large") tooLarge = true;
      }
    }
    throw new SocialVideoSourceError(tooLarge ? "too_large" : "unavailable", caption, post);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SocialVideoSourceError) throw error;
    throw new SocialVideoSourceError("unavailable", post?.caption, post);
  }
}
