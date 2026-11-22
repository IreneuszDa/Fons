import { parseHTML } from "linkedom";
import { z } from "zod";
import { FetchBlockedError, fetchPublicResource } from "../../security/fetch";
import { loadTikTokSubtitles, readTikTokEmbed, tikTokMediaAllowed, tikTokPageDetails } from "./tiktok";
import type { SubtitleSegment } from "./webvtt";

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
import { MAX_RECORDING_SECONDS } from "../../shared/attachments";
export const MAX_VIDEO_SECONDS = MAX_RECORDING_SECONDS;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const videoTypes = ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"];
export type SocialVideoPlatform = "tiktok" | "instagram";
type VideoMime = "video/mp4" | "video/webm" | "video/quicktime";

export interface SocialVideoMetadata {
  author?: string;
  thumbnailUrl?: string;
  subtitles?: SubtitleSegment[];
}

export interface SocialVideo extends SocialVideoMetadata {
  platform: SocialVideoPlatform;
  url: string;
  caption: string;
  mimeType: VideoMime;
  durationSeconds?: number;
  bytes: Buffer;
}

export class SocialVideoSourceError extends Error {
  readonly caption: string;
  readonly author?: string;
  readonly thumbnailUrl?: string;
  readonly subtitles?: SubtitleSegment[];
  readonly url?: string;
  constructor(
    readonly reason: "unavailable" | "too_large" | "unsupported", caption = "",
    metadata: SocialVideoMetadata & { url?: string } = {}, readonly confirmedPublicVideo = false,
  ) {
    super(reason);
    this.name = "SocialVideoSourceError";
    this.caption = caption.trim().slice(0, 8_000);
    this.author = metadata.author;
    this.thumbnailUrl = metadata.thumbnailUrl;
    this.subtitles = metadata.subtitles;
    this.url = metadata.url;
  }
}

interface PostLink {
  platform: SocialVideoPlatform;
  url: URL;
  /** Share links only acquire an ID after the platform redirects to the post. */
  id?: string;
}

function parsePost(raw: string): PostLink | undefined {
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) return;
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  const { hostname, pathname } = url;
  if (["www.tiktok.com", "tiktok.com", "m.tiktok.com"].includes(hostname)) {
    const match = /^\/(?:(?:@|%40)[\w.-]+\/video|share\/video)\/(\d{1,22})\/?$/.exec(pathname);
    if (match) return { platform: "tiktok", url, id: match[1] };
    if (/^\/t\/[A-Za-z0-9_-]+\/?$/.test(pathname)) return { platform: "tiktok", url };
  }
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(hostname) && /^\/[A-Za-z0-9_-]+\/?$/.test(pathname)) {
    return { platform: "tiktok", url };
  }
  if (["www.instagram.com", "instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"].includes(hostname)) {
    if (/^\/share\/(?:(?:reel|p)\/)?[\w-]+\/?$/.test(pathname)) return { platform: "instagram", url };
    const match = /^\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]{1,32})\/?$/.exec(pathname);
    if (match) return { platform: "instagram", url, id: match[1] };
  }
}

export function socialVideoPlatform(rawUrl: string): SocialVideoPlatform | undefined {
  return parsePost(rawUrl)?.platform;
}

/** Stable media identifier across alternative post paths and share parameters. */
export function socialPostId(rawUrl: string): string | undefined {
  const post = parsePost(rawUrl);
  return post?.id ? `${post.platform}:${post.id}` : undefined;
}

interface PostMetadata extends SocialVideoMetadata {
  caption: string;
  mediaUrls: string[];
  durationSeconds?: number;
  subtitleUrls?: string[];
  confirmedPublicVideo?: boolean;
}

const instagramEmbed = z.object({
  context: z.object({ shortcode: z.string(), copyright_blocked: z.boolean().optional() }),
  gql_data: z.object({ shortcode_media: z.object({
    shortcode: z.string(), is_video: z.boolean(), video_url: z.string().nullish(), video_duration: z.number().nullish(),
    edge_media_to_caption: z.object({ edges: z.array(z.object({ node: z.object({ text: z.string() }) })) }).optional(),
  }).nullish() }).optional(),
});

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

// Public post pages may carry the matching media object inside a nested JSON script.
function instagramPageVideo(doc: ReturnType<typeof parseHTML>["document"], id: string) {
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    const json = script.textContent ?? "";
    if (!json.includes(id) || !(json.includes("video_versions") || json.includes("video_url"))) continue;
    const pending: unknown[] = [parseJson(json)];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      const node = value as Record<string, unknown>;
      if (node.shortcode === id || node.code === id) {
        if (node.is_video === false || (node.media_type !== undefined && node.media_type !== 2)) continue;
        const owner = node.owner ?? node.user;
        if (owner && typeof owner === "object" && "is_private" in owner && owner.is_private === true) {
          throw new SocialVideoSourceError("unavailable");
        }
        const variants = Array.isArray(node.video_versions) ? node.video_versions : [];
        const mediaUrls = [node.video_url, ...variants.map(v => v?.url)].filter((v): v is string => typeof v === "string");
        if (mediaUrls.length) return { mediaUrls, durationSeconds: typeof node.video_duration === "number" ? node.video_duration : undefined };
      }
      for (const child of Object.values(node)) if (child && typeof child === "object") pending.push(child);
    }
  }
}

function metadata(html: string, post: PostLink): PostMetadata {
  const doc = parseHTML(html).document;
  if (post.platform === "tiktok") {
    const script = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent;
    const legacy = doc.getElementById("SIGI_STATE")?.textContent;
    const item = tikTokPageDetails(script && parseJson(script), post.id, legacy && parseJson(legacy));
    if (item?.restricted) throw new SocialVideoSourceError("unavailable");
    if (item) return { ...item, confirmedPublicVideo: true };
  } else {
    for (const script of doc.querySelectorAll("script")) {
      const js = script.textContent ?? "";
      if (!js.includes("PolarisEmbedSimple")) continue;
      // The public embed serializes its post context as a JSON string inside its initialization script.
      const literal = /"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(js)?.[1];
      const nested = literal && parseJson(literal);
      const embed = typeof nested === "string" ? instagramEmbed.safeParse(parseJson(nested)).data : undefined;
      if (!embed || embed.context.shortcode !== post.id) continue;
      const item = embed.gql_data?.shortcode_media;
      const caption = item?.edge_media_to_caption?.edges[0]?.node.text ?? "";
      if (embed.context.copyright_blocked || !item || item.shortcode !== post.id) throw new SocialVideoSourceError("unavailable", caption);
      if (!item.is_video) throw new SocialVideoSourceError("unsupported", caption);
      return { caption, durationSeconds: item.video_duration ?? undefined, mediaUrls: item.video_url ? [item.video_url] : [] };
    }
  }

  // Only page-level metadata for this exact post. Embedded players or recommended posts may refer to other clips.
  const property = (name: string) => doc.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ?? "";
  const canonical = parsePost(property("og:url") || doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "");
  if (!canonical?.id || canonical.platform !== post.platform || canonical.id !== post.id) {
    return { caption: "", mediaUrls: [] };
  }
  const embedded = post.platform === "instagram" ? instagramPageVideo(doc, canonical.id) : undefined;
  const mediaUrls = [...["og:video:secure_url", "og:video:url", "og:video"].map(property).filter(Boolean), ...(embedded?.mediaUrls ?? [])];
  const thumbnail = URL.parse(property("og:image"));
  return { durationSeconds: embedded?.durationSeconds, caption: property("og:description").trim().slice(0, 8_000), mediaUrls,
    confirmedPublicVideo: mediaUrls.some(raw => { const url = URL.parse(raw); return url && mediaAllowed(url, post.platform); }),
    ...(thumbnail && mediaAllowed(thumbnail, post.platform) && { thumbnailUrl: thumbnail.href }),
  };
}

const mediaDomains = {
  instagram: ["cdninstagram.com", "fbcdn.net", "instagram.com"],
};

function mediaAllowed(url: URL, platform: SocialVideoPlatform) {
  if (platform === "tiktok") return tikTokMediaAllowed(url);
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && mediaDomains[platform].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

export function videoMime(bytes: Buffer, mime: string): VideoMime | undefined {
  if (bytes.length < 12) return;
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12);
    if (["avif", "avis", "mif1", "msf1", "heic", "heix", "hevc", "hevx", "M4A "].includes(brand)) return;
    if (mime === "video/mp4" || mime === "video/quicktime" || mime === "application/octet-stream") {
      return brand === "qt  " ? "video/quicktime" : "video/mp4";
    }
  }
  if (bytes.readUInt32BE(0) === 0x1a45dfa3 && bytes.subarray(0, 128).includes("webm") && mime !== "video/mp4" && mime !== "video/quicktime") {
    return "video/webm";
  }
}

async function readPublicPost(rawUrl: string, active: AbortSignal, includeMedia: boolean) {
  const submitted = parsePost(rawUrl);
  if (!submitted) throw new SocialVideoSourceError("unsupported");
  let caption = "";
  let post = submitted;
  let details: PostMetadata = { caption: "", mediaUrls: [] };
  try {
    const getPost = (url: string) => fetchPublicResource(url, {
      mimeTypes: ["text/html", "application/xhtml+xml"], maxBytes: MAX_PAGE_BYTES, timeoutMs: 8_000, signal: active,
      allowUrl: u => {
        if (u.protocol !== "https:") return false;
        const target = parsePost(u.href);
        return target?.platform === submitted.platform && (!submitted.id || submitted.id === target.id);
      },
    });
    let sharedPage: Awaited<ReturnType<typeof getPost>> | undefined;
    if (!submitted.id) {
      const page = await getPost(submitted.url.href);
      const resolved = parsePost(page.finalUrl);
      if (!resolved?.id) throw new SocialVideoSourceError("unavailable");
      post = resolved;
      sharedPage = page;
    }
    if (post.platform === "tiktok" && post.id) {
      const embed = await readTikTokEmbed(post.url, post.id, active);
      details = { ...details, ...embed };
      if (includeMedia || !embed.caption || !embed.author || !embed.thumbnailUrl) {
        const page = sharedPage ?? await getPost(post.url.href);
        const parsed = metadata(page.bytes.toString("utf8"), post);
        details = { ...parsed, ...embed, caption: embed.caption || parsed.caption };
      }
      return { post, details };
    }
    if (sharedPage) {
      details = metadata(sharedPage.bytes.toString("utf8"), post);
      caption = details.caption;
    }
    if (post.platform === "instagram" && !details.mediaUrls.length) {
      const embed = new URL(`https://www.instagram.com/p/${post.id}/embed/captioned/`);
      try {
        const page = await fetchPublicResource(embed.href, {
          mimeTypes: ["text/html", "application/xhtml+xml"], maxBytes: MAX_PAGE_BYTES, timeoutMs: 8_000, signal: active,
          allowUrl: u => u.origin === embed.origin && u.pathname === embed.pathname,
        });
        details = metadata(page.bytes.toString("utf8"), post);
        caption = details.caption || caption;
      } catch (err) {
        active.throwIfAborted();
        if (err instanceof SocialVideoSourceError || (err instanceof FetchBlockedError &&
          (err.reason === "scheme" || [401, 403, 429].includes(err.httpStatus ?? 0)))) throw err;
      }
      if (submitted.id && !details.mediaUrls.length) {
        const direct = await getPost(post.url.href);
        details = metadata(direct.bytes.toString("utf8"), post);
      }
    }
    details.caption = (details.caption || caption).trim().slice(0, 8_000);
    return { post, details };
  } catch (err) {
    const info = { ...details, url: post.url.href };
    if (err instanceof SocialVideoSourceError) throw new SocialVideoSourceError(err.reason, err.caption || details.caption || caption, info);
    throw new SocialVideoSourceError("unavailable", details.caption || caption, info);
  }
}

function withDeadline(signal: AbortSignal | undefined, ms: number) {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Public metadata and optionally WebVTT. This path never downloads video. */
export async function loadSocialCaption(rawUrl: string, signal?: AbortSignal, includeSubtitles = false): Promise<SocialVideoMetadata & { url: string; caption: string }> {
  const active = withDeadline(signal, 18_000);
  try {
    const { post, details } = await readPublicPost(rawUrl, active, includeSubtitles);
    let subs: SubtitleSegment[] = [];
    if (includeSubtitles && details.subtitleUrls?.length && (details.durationSeconds ?? 0) <= MAX_VIDEO_SECONDS) {
      try { subs = await loadTikTokSubtitles(details.subtitleUrls, details.durationSeconds || MAX_VIDEO_SECONDS, active); }
      catch { signal?.throwIfAborted(); }
    }
    return { url: post.url.href, caption: details.caption, ...(details.author && { author: details.author }),
      ...(details.thumbnailUrl && { thumbnailUrl: details.thumbnailUrl }), ...(subs.length && { subtitles: subs }) };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof SocialVideoSourceError) {
      if (err.url && (err.caption || err.author || err.thumbnailUrl)) {
        return { url: err.url, caption: err.caption, author: err.author, thumbnailUrl: err.thumbnailUrl };
      }
      throw err;
    }
    throw new SocialVideoSourceError("unavailable");
  }
}

/** Retrieve only what the public post or the platform's public embed advertises. No session or credentials. */
export async function loadSocialVideo(rawUrl: string, signal?: AbortSignal): Promise<SocialVideo> {
  const active = withDeadline(signal, 32_000);
  let caption = "";
  let metadata: SocialVideoMetadata & { url?: string } = {};
  let confirmedPublicVideo = false;
  try {
    const { post, details } = await readPublicPost(rawUrl, active, true);
    caption = details.caption;
    confirmedPublicVideo = details.confirmedPublicVideo === true;
    metadata = { url: post.url.href, author: details.author, thumbnailUrl: details.thumbnailUrl };
    if ((details.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) throw new SocialVideoSourceError("too_large", caption, metadata);
    if (details.subtitleUrls?.length) {
      const rows = await loadTikTokSubtitles(details.subtitleUrls, details.durationSeconds || MAX_VIDEO_SECONDS, active);
      if (rows.length) metadata.subtitles = rows;
    }
    const urls = [...new Set(details.mediaUrls)].filter(raw => {
      const url = URL.parse(raw);
      return url && mediaAllowed(url, post.platform);
    }).slice(0, 3);
    let exceededSize = false;
    for (const url of urls) {
      try {
        const media = await fetchPublicResource(url, {
          mimeTypes: videoTypes, maxBytes: MAX_VIDEO_BYTES, timeoutMs: 14_000, signal: active,
          allowUrl: u => mediaAllowed(u, post.platform),
        });
        const mimeType = videoMime(media.bytes, media.mime);
        if (mimeType) {
          return { ...metadata, platform: post.platform, url: post.url.href, caption, mimeType, bytes: media.bytes, durationSeconds: details.durationSeconds };
        }
      } catch (err) {
        active.throwIfAborted();
        if (err instanceof FetchBlockedError && err.reason === "too_large") exceededSize = true;
      }
    }
    throw new SocialVideoSourceError(exceededSize ? "too_large" : "unavailable", caption, metadata, confirmedPublicVideo);
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof SocialVideoSourceError) throw err;
    throw new SocialVideoSourceError("unavailable", caption, metadata, confirmedPublicVideo);
  }
}

const socialKitReply = z.object({
  success: z.literal(true),
  data: z.object({
    url: z.string(), title: z.string(), format: z.literal("mp4"), durationSeconds: z.number().nonnegative(),
    fileSize: z.number().int().positive(), downloadUrl: z.string(),
  }),
});

/** SocialKit's documented download bucket, including its regional S3 addressing variant. */
function isSocialKitStorage(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password
    && /^socialkit-downloads\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
}

async function loadSocialKitPost(post: PostLink, key: string, signal?: AbortSignal): Promise<SocialVideo> {
  const active = withDeadline(signal, 60_000);
  let caption = "";
  try {
    const endpoint = "https://api.socialkit.dev/tiktok/download";
    const raw = await fetchPublicResource(endpoint, {
      mimeTypes: ["application/json"], maxBytes: 64 * 1024, timeoutMs: 45_000, signal: active,
      allowUrl: url => url.href === endpoint,
      postJson: { headers: { "x-access-key": key }, body: { url: post.url.href, format: "mp4", quality: "480p" } },
    });
    const info = socialKitReply.safeParse(parseJson(raw.bytes.toString("utf8"))).data?.data;
    if (!info) throw new SocialVideoSourceError("unavailable");
    const returned = parsePost(info.url);
    if (returned?.platform !== "tiktok" || (post.id ? returned.id !== post.id :
      returned.url.href.replace(/\/$/, "") !== post.url.href.replace(/\/$/, ""))) throw new SocialVideoSourceError("unavailable");
    caption = info.title.trim().slice(0, 8_000);
    if (info.fileSize > MAX_VIDEO_BYTES || info.durationSeconds > MAX_VIDEO_SECONDS) {
      throw new SocialVideoSourceError("too_large", caption);
    }
    const media = await fetchPublicResource(info.downloadUrl, {
      mimeTypes: ["video/mp4", "application/octet-stream"], allowUrl: isSocialKitStorage,
      signal: active, timeoutMs: 20_000, maxBytes: info.fileSize,
    });
    const mimeType = videoMime(media.bytes, media.mime);
    if (media.bytes.length !== info.fileSize || mimeType !== "video/mp4") throw new SocialVideoSourceError("unavailable", caption);
    return { platform: "tiktok", url: returned.url.href, mimeType, bytes: media.bytes, caption, durationSeconds: info.durationSeconds };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof SocialVideoSourceError) throw err;
    throw new SocialVideoSourceError("unavailable", caption);
  }
}

export function createSocialVideoLoader(socialKitApiKey?: string): typeof loadSocialVideo {
  if (!socialKitApiKey) return loadSocialVideo;
  return async (url, signal) => {
    try {
      return await loadSocialVideo(url, signal);
    } catch (direct) {
      signal?.throwIfAborted();
      if (!(direct instanceof SocialVideoSourceError) || direct.reason !== "unavailable" || !direct.confirmedPublicVideo) throw direct;
      const post = direct.url && parsePost(direct.url);
      if (!post || post.platform !== "tiktok" || !post.id) throw direct;
      const metadata = { url: post.url.href, author: direct.author, thumbnailUrl: direct.thumbnailUrl, subtitles: direct.subtitles };
      try {
        const video = await loadSocialKitPost(post, socialKitApiKey, signal);
        return { ...video, ...metadata, caption: direct.caption || video.caption };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof SocialVideoSourceError) throw new SocialVideoSourceError(error.reason, direct.caption || error.caption, metadata);
        throw direct;
      }
    }
  };
}
