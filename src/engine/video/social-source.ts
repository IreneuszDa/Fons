import { parseHTML } from "linkedom";
import { z } from "zod";
import { FetchBlockedError, fetchPublicResource } from "../../security/fetch";

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 600;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const videoTypes = ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"];
export type SocialVideoPlatform = "tiktok" | "instagram";
type VideoMime = "video/mp4" | "video/webm" | "video/quicktime";

export interface SocialVideo {
  platform: SocialVideoPlatform;
  url: string;
  caption: string;
  mimeType: VideoMime;
  durationSeconds?: number;
  bytes: Buffer;
}

export class SocialVideoSourceError extends Error {
  readonly caption: string;
  constructor(readonly reason: "unavailable" | "too_large" | "unsupported", caption = "") {
    super(reason);
    this.name = "SocialVideoSourceError";
    this.caption = caption.trim().slice(0, 8_000);
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
    const match = /^\/(?:@[\w.-]+\/video|share\/video)\/(\d{1,22})\/?$/.exec(pathname);
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

interface PostMetadata {
  caption: string;
  mediaUrls: string[];
  durationSeconds?: number;
}

const tikTokItem = z.object({
  id: z.string(), desc: z.string().optional(), video: z.object({
    duration: z.number().optional(), playAddr: z.string().optional(), downloadAddr: z.string().optional(),
    PlayAddrStruct: z.object({ UrlList: z.array(z.string()).optional() }).optional(),
  }),
});

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

function metadata(html: string, post: PostLink): PostMetadata {
  const doc = parseHTML(html).document;
  if (post.platform === "tiktok") {
    const script = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent;
    const detail = z.object({ __DEFAULT_SCOPE__: z.object({
      "webapp.video-detail": z.object({ statusCode: z.number().optional(), itemInfo: z.object({ itemStruct: tikTokItem }).optional() }),
    }) }).safeParse(script && parseJson(script)).data?.__DEFAULT_SCOPE__["webapp.video-detail"];
    if (detail && detail.statusCode) throw new SocialVideoSourceError("unavailable");
    const item = detail?.itemInfo?.itemStruct;
    if (item && item.id === post.id) {
      return {
        caption: item.desc ?? "", durationSeconds: item.video.duration,
        mediaUrls: [item.video.downloadAddr, item.video.playAddr, ...(item.video.PlayAddrStruct?.UrlList ?? [])]
          .filter((u): u is string => !!u),
      };
    }
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
  const canonical = parsePost(property("og:url"));
  if (!canonical?.id || canonical.platform !== post.platform || canonical.id !== post.id) {
    return { caption: "", mediaUrls: [] };
  }
  return {
    caption: property("og:description"),
    mediaUrls: ["og:video:secure_url", "og:video:url", "og:video"].map(property).filter(Boolean),
  };
}

const mediaDomains = {
  tiktok: ["tiktok.com", "tiktokcdn.com", "tiktokcdn-eu.com", "tiktokcdn-us.com", "tiktokv.com", "muscdn.com"],
  instagram: ["cdninstagram.com", "fbcdn.net", "instagram.com"],
};

function mediaAllowed(url: URL, platform: SocialVideoPlatform) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && mediaDomains[platform].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

function videoMime(bytes: Buffer, mime: string): VideoMime | undefined {
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

async function readPublicPost(rawUrl: string, active: AbortSignal) {
  const submitted = parsePost(rawUrl);
  if (!submitted) throw new SocialVideoSourceError("unsupported");
  let caption = "";
  try {
    let post = submitted;
    const getPost = (url: string) => fetchPublicResource(url, {
      mimeTypes: ["text/html", "application/xhtml+xml"], maxBytes: MAX_PAGE_BYTES, timeoutMs: 8_000, signal: active,
      allowUrl: u => {
        if (u.protocol !== "https:") return false;
        const target = parsePost(u.href);
        return target?.platform === submitted.platform && (!submitted.id || submitted.id === target.id);
      },
    });
    let details: PostMetadata = { caption: "", mediaUrls: [] };
    if (submitted.platform === "tiktok" || !submitted.id) {
      const page = await getPost(submitted.url.href);
      const resolved = parsePost(page.finalUrl);
      if (!resolved?.id) throw new SocialVideoSourceError("unavailable");
      post = resolved;
      details = metadata(page.bytes.toString("utf8"), post);
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
    active.throwIfAborted();
    if (err instanceof SocialVideoSourceError) throw new SocialVideoSourceError(err.reason, err.caption || caption);
    throw new SocialVideoSourceError("unavailable", caption);
  }
}

function withDeadline(signal: AbortSignal | undefined, ms: number) {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Metadata only. This path makes no paid provider requests and never contacts a media CDN. */
export async function loadSocialCaption(rawUrl: string, signal?: AbortSignal): Promise<{ url: string; caption: string }> {
  const active = withDeadline(signal, 18_000);
  try {
    const { post, details } = await readPublicPost(rawUrl, active);
    let caption = details.caption;
    if (!caption && post.platform === "tiktok" && post.id) {
      const endpoint = new URL("https://www.tiktok.com/oembed");
      endpoint.searchParams.set("url", post.url.href);
      const response = await fetchPublicResource(endpoint.href, {
        mimeTypes: ["application/json"], allowUrl: u => u.href === endpoint.href, signal: active, timeoutMs: 4_000, maxBytes: 64 * 1024,
      });
      const embed = z.object({ type: z.literal("video"), embed_product_id: z.string(), title: z.string().optional() })
        .safeParse(parseJson(response.bytes.toString("utf8"))).data;
      if (embed?.embed_product_id === post.id) caption = embed.title?.trim().slice(0, 8_000) ?? "";
    }
    return { url: post.url.href, caption };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof SocialVideoSourceError) throw err;
    throw new SocialVideoSourceError("unavailable");
  }
}

/** Retrieve only what the public post or the platform's public embed advertises. No session or credentials. */
export async function loadSocialVideo(rawUrl: string, signal?: AbortSignal): Promise<SocialVideo> {
  const active = withDeadline(signal, 32_000);
  let caption = "";
  try {
    const { post, details } = await readPublicPost(rawUrl, active);
    caption = details.caption;
    if ((details.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) throw new SocialVideoSourceError("too_large", caption);
    const urls = [...new Set(details.mediaUrls)].filter(raw => {
      const url = URL.parse(raw);
      return url && mediaAllowed(url, post.platform);
    }).slice(0, 3);
    for (const url of urls) {
      try {
        const media = await fetchPublicResource(url, {
          mimeTypes: videoTypes, maxBytes: MAX_VIDEO_BYTES, timeoutMs: 14_000, signal: active,
          allowUrl: u => mediaAllowed(u, post.platform),
        });
        const mimeType = videoMime(media.bytes, media.mime);
        if (mimeType) {
          return { platform: post.platform, url: post.url.href, caption, mimeType, bytes: media.bytes, durationSeconds: details.durationSeconds };
        }
      } catch (err) {
        active.throwIfAborted();
        if (err instanceof FetchBlockedError && err.reason === "too_large") throw new SocialVideoSourceError("too_large", caption);
      }
    }
    throw new SocialVideoSourceError("unavailable", caption);
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof SocialVideoSourceError) throw new SocialVideoSourceError(err.reason, err.caption || caption);
    throw new SocialVideoSourceError("unavailable", caption);
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
  return (url, signal) => {
    const post = parsePost(url);
    return post?.platform === "tiktok" ? loadSocialKitPost(post, socialKitApiKey, signal) : loadSocialVideo(url, signal);
  };
}
