import { z } from "zod";
import { fetchPublicResource } from "../../security/fetch";
import { parseWebVtt } from "./webvtt";

const mediaDomains = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-eu.com", "tiktokcdn-us.com", "tiktokv.com", "muscdn.com"];
export function tikTokMediaAllowed(url: URL) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && mediaDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

function allowedUrl(raw?: string) {
  const url = raw ? URL.parse(raw) : null;
  return url && tikTokMediaAllowed(url) ? url.href : undefined;
}

export interface TikTokMetadata {
  caption: string;
  author?: string;
  thumbnailUrl?: string;
}

function metadata(caption?: string, author?: string, thumbnail?: string): TikTokMetadata {
  const thumbnailUrl = allowedUrl(thumbnail);
  const name = author?.trim().slice(0, 128);
  return { caption: caption?.trim().slice(0, 8_000) ?? "", ...(name && { author: name }), ...(thumbnailUrl && { thumbnailUrl }) };
}

const embedSchema = z.object({
  type: z.literal("video"), embed_product_id: z.string(),
  title: z.string().optional(), author_name: z.string().optional(), thumbnail_url: z.string().optional(),
});

export async function readTikTokEmbed(post: URL, id: string, signal: AbortSignal): Promise<TikTokMetadata> {
  const url = new URL("https://www.tiktok.com/oembed");
  url.searchParams.set("url", post.href);
  try {
    const response = await fetchPublicResource(url.href, {
      mimeTypes: ["application/json"], allowUrl: u => u.href === url.href, signal, timeoutMs: 4_000, maxBytes: 64 * 1024,
    });
    const data = embedSchema.safeParse(JSON.parse(response.bytes.toString("utf8"))).data;
    if (data?.embed_product_id === id) return metadata(data.title, data.author_name, data.thumbnail_url);
  } catch {
    signal.throwIfAborted();
  }
  return { caption: "" };
}

const address = z.object({
  UrlList: z.array(z.string()).optional(), DataSize: z.coerce.number().positive().optional().catch(undefined),
});
const subtitleTrack = z.object({
  Url: z.string().optional(), Format: z.string().optional(), IsOriginalCaption: z.boolean().optional(),
});
const captionInfo = z.object({
  url: z.string().optional(), urlList: z.array(z.string()).optional(), captionFormat: z.string().optional(),
  isOriginalCaption: z.boolean().optional(),
});
const visibility = z.object({
  id: z.string(), privateItem: z.boolean().optional(), forFriend: z.boolean().optional(),
  secret: z.boolean().optional(), isProhibited: z.boolean().optional(), takeDown: z.number().optional(),
});
const item = z.object({
  desc: z.string().optional(),
  author: z.object({ uniqueId: z.string().optional(), nickname: z.string().optional() }).optional(),
  video: z.object({
    duration: z.number().optional(), playAddr: z.string().optional(), downloadAddr: z.string().optional(),
    cover: z.string().optional(), originCover: z.string().optional(), PlayAddrStruct: address.optional(),
    bitrateInfo: z.array(z.object({ Bitrate: z.number().optional(), PlayAddr: address.optional() })).optional(),
    subtitleInfos: z.array(subtitleTrack).optional(),
    claInfo: z.object({ captionInfos: z.array(captionInfo).optional() }).optional(),
  }).optional(),
});
const detailSchema = z.object({ __DEFAULT_SCOPE__: z.object({
  "webapp.video-detail": z.object({ statusCode: z.number().optional(), itemInfo: z.object({ itemStruct: z.unknown() }).nullish() }),
}) });

export function tikTokPageDetails(data: unknown, postId?: string) {
  const detail = detailSchema.safeParse(data).data?.__DEFAULT_SCOPE__["webapp.video-detail"];
  if (detail?.statusCode) return { restricted: true } as const;
  const raw = detail?.itemInfo?.itemStruct;
  if (!raw) return;
  // Check visibility before parsing optional playback fields, which can change shape independently.
  const status = visibility.safeParse(raw).data;
  if (!status || status.privateItem || status.forFriend || status.secret || status.isProhibited || status.takeDown) return { restricted: true } as const;
  if (status.id !== postId) return;
  const post = item.safeParse(raw).data;
  const video = post?.video;
  if (!post || !video) return;
  const formats = [...(video.bitrateInfo ?? [])].sort((a, b) =>
    (a.PlayAddr?.DataSize ?? Infinity) - (b.PlayAddr?.DataSize ?? Infinity) || (a.Bitrate ?? Infinity) - (b.Bitrate ?? Infinity));
  const smallest = formats[0]?.PlayAddr?.UrlList?.[0];
  // Reserve attempts for the standard playback and download URLs when variants have their own delivery requirements.
  const mediaUrls = [
    smallest, video.playAddr, video.downloadAddr, ...formats.map(f => f.PlayAddr?.UrlList?.[0]),
    ...(video.PlayAddrStruct?.UrlList ?? []), ...formats.flatMap(f => f.PlayAddr?.UrlList?.slice(1) ?? []),
  ].filter((raw): raw is string => Boolean(raw));
  const alternatives = video.claInfo?.captionInfos?.flatMap(track =>
    [track.url, ...(track.urlList ?? [])].map(Url => ({ Url, Format: track.captionFormat, IsOriginalCaption: track.isOriginalCaption }))) ?? [];
  const tracks = [...(video.subtitleInfos ?? []), ...alternatives]
    .filter(t => !t.Format || /^(?:web)?vtt$/i.test(t.Format))
    .sort((a, b) => Number(b.IsOriginalCaption === true) - Number(a.IsOriginalCaption === true));
  return {
    ...metadata(post.desc, post.author?.uniqueId || post.author?.nickname, video.cover || video.originCover),
    durationSeconds: video.duration, mediaUrls, subtitleUrls: tracks.map(t => allowedUrl(t.Url)).filter((u): u is string => !!u),
  };
}

export async function loadTikTokSubtitles(urls: string[], maxSeconds: number, signal: AbortSignal) {
  for (const url of [...new Set(urls)].slice(0, 2)) {
    try {
      const response = await fetchPublicResource(url, {
        mimeTypes: ["text/vtt", "text/plain", "application/octet-stream"], allowUrl: tikTokMediaAllowed,
        signal, timeoutMs: 3_000, maxBytes: 256 * 1024,
      });
      const rows = parseWebVtt(response.bytes.toString("utf8"), maxSeconds);
      if (rows.length) return rows;
    } catch {
      signal.throwIfAborted();
    }
  }
  return [];
}
