import { parseHTML } from "linkedom";
import { z } from "zod";
import { FetchBlockedError, fetchPublicResource } from "../../security/fetch";
import { parseWebVtt, type SubtitleSegment } from "./webvtt";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SocialVideoSourceError, videoMime } from "./social-source";

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const idPattern = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeVideoId(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return;
  let id: string | undefined;
  if (youtubeHosts.has(url.hostname)) {
    if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v") ?? undefined;
    else id = /^\/(?:shorts|embed|live)\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
  } else if (url.hostname === "youtu.be") {
    id = /^\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
  } else if (url.hostname === "www.youtube-nocookie.com" || url.hostname === "youtube-nocookie.com") {
    id = /^\/embed\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
  }
  return id && idPattern.test(id) ? id : undefined;
}

export function canonicalYouTubeUrl(raw: string): string | undefined {
  const id = parseYouTubeVideoId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
}

const embedData = z.object({
  type: z.literal("video"), title: z.string(), author_name: z.string().optional(), thumbnail_url: z.string().optional(),
});
const tracksSchema = z.object({
  captionTracks: z.array(z.object({ baseUrl: z.string(), kind: z.string().optional(), languageCode: z.string().optional() })),
  audioTracks: z.array(z.object({ defaultCaptionTrackIndex: z.number().int().optional() })).optional(),
  defaultAudioTrackIndex: z.number().int().optional(),
});
const playerData = z.object({
  videoDetails: z.object({
    videoId: z.string(), title: z.string().optional(), author: z.string().optional(),
    shortDescription: z.string().optional(), lengthSeconds: z.string().optional(),
    isLive: z.boolean().optional(), isUpcoming: z.boolean().optional(), isPrivate: z.boolean().optional(),
  }),
  microformat: z.object({ playerMicroformatRenderer: z.object({
    liveBroadcastDetails: z.object({ isLiveNow: z.boolean().optional() }).optional(),
  }).optional() }).optional(),
  captions: z.unknown().optional(),
  playabilityStatus: z.object({ status: z.string() }).nullish(),
  streamingData: z.object({ formats: z.array(z.unknown()).optional() }).nullish(),
});

const formatSchema = z.object({
  url: z.string(), mimeType: z.string(), contentLength: z.string().regex(/^\d+$/).optional(),
  bitrate: z.number().nonnegative().optional(), drmFamilies: z.array(z.unknown()).optional(), drmTrackType: z.string().optional(),
  signatureCipher: z.string().optional(), cipher: z.string().optional(),
});
type PublicFormat = z.infer<typeof formatSchema>;

function playbackUrl(url: URL): boolean {
  return url.protocol === "https:" && url.hostname.endsWith(".googlevideo.com") && url.pathname === "/videoplayback"
    && !url.username && !url.password && !url.port && !url.searchParams.has("range");
}

/** Progressive formats contain both streams. The public watch page also advertises video-only adaptive formats. */
function progressiveFormats(formats: unknown[]): PublicFormat[] {
  const playable: PublicFormat[] = [];
  for (const raw of formats) {
    const f = formatSchema.safeParse(raw).data;
    if (!f || f.cipher || f.signatureCipher || f.drmFamilies?.length || f.drmTrackType) continue;
    const url = URL.parse(f.url);
    if (!url || !playbackUrl(url) || !/^video\/mp4\s*;/i.test(f.mimeType)) continue;
    if (!/\b(?:avc[13]|av01|vp09|hev1|hvc1|mp4v)\b/i.test(f.mimeType) || !/\b(?:mp4a|opus|ac-3|ec-3)\b/i.test(f.mimeType)) continue;
    playable.push(f);
  }
  return playable.sort((a, b) => Number(a.contentLength ?? Infinity) - Number(b.contentLength ?? Infinity) ||
    (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity));
}

interface WatchMetadata {
  title?: string;
  author?: string;
  description?: string;
  durationSeconds?: number;
  captionTrack?: string;
  formats?: PublicFormat[];
}

function captionTrack(captions: unknown, id: string) {
  const metadata = z.object({ playerCaptionsTracklistRenderer: tracksSchema }).safeParse(captions).data?.playerCaptionsTracklistRenderer;
  if (!metadata) return;
  const index = metadata.audioTracks?.[metadata.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex;
  const tracks = metadata.captionTracks;
  const track = (index !== undefined ? tracks[index] : undefined) ?? tracks.find(t => t.kind !== "asr") ?? tracks[0];
  const url = track && URL.parse(track.baseUrl);
  if (url?.origin !== "https://www.youtube.com" || url.username || url.password || url.pathname !== "/api/timedtext" || url.searchParams.get("v") !== id) return;
  url.searchParams.set("fmt", "vtt");
  return url.href;
}

function watchMetadata(html: string, id: string): WatchMetadata {
  const doc = parseHTML(html).document;
  let metadata: WatchMetadata = {};
  let live = false;
  for (const script of doc.querySelectorAll("script")) {
    const js = (script.textContent ?? "").trim();
    const assignment = /^(?:var\s+)?ytInitialPlayerResponse\s*=\s*/.exec(js);
    if (!assignment) continue;
    try {
      const player = playerData.safeParse(JSON.parse(js.slice(assignment[0].length).replace(/;$/, ""))).data;
      if (player?.videoDetails.videoId !== id) continue;
      const { title, author, shortDescription, lengthSeconds, isLive, isUpcoming } = player.videoDetails;
      live = !!(isLive || isUpcoming || player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow);
      const status = player.playabilityStatus?.status;
      const publicTracks = !live && !player.videoDetails.isPrivate && (!status || status === "OK");
      const duration = Number(lengthSeconds);
      metadata = {
        title, author, description: shortDescription, captionTrack: publicTracks ? captionTrack(player.captions, id) : undefined,
        durationSeconds: !live && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined,
        formats: publicTracks && status === "OK"
          ? progressiveFormats(player.streamingData?.formats ?? []) : [],
      };
      break;
    } catch { /* Some watch pages expose only structured HTML metadata. */ }
  }
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
  if (!canonical || parseYouTubeVideoId(canonical) !== id) return metadata;
  const meta = (item: string) => doc.querySelector(`meta[itemprop="${item}"]`)?.getAttribute("content") ?? undefined;
  const length = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(meta("duration") ?? "");
  const duration = length ? Number(length[1] ?? 0) * 3600 + Number(length[2] ?? 0) * 60 + Number(length[3] ?? 0) : 0;
  return {
    ...metadata,
    title: metadata.title ?? doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? undefined,
    description: metadata.description ?? meta("description") ?? doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? undefined,
    durationSeconds: metadata.durationSeconds ?? (!live && Number.isFinite(duration) && duration > 0 && meta("isLiveBroadcast")?.toLowerCase() !== "true" ? duration : undefined),
  };
}

interface YouTubeMetadata {
  platform: "youtube";
  url: string;
  caption: string;
  title?: string;
  author?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  subtitles?: SubtitleSegment[];
}

export type YouTubePost = YouTubeMetadata & { youtubeUrl: string };

async function readYouTubePost(raw: string, signal?: AbortSignal): Promise<{ post: YouTubeMetadata; formats: PublicFormat[] }> {
  const url = canonicalYouTubeUrl(raw);
  if (!url) throw new Error("unsupported");
  const id = new URL(url).searchParams.get("v")!;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("format", "json");
  const [embedResult, watchResult] = await Promise.allSettled([
    fetchPublicResource(endpoint.href, {
      mimeTypes: ["application/json"], maxBytes: 64 * 1024, timeoutMs: 5000, signal,
      allowUrl: target => target.href === endpoint.href,
    }).then(r => embedData.parse(JSON.parse(r.bytes.toString("utf8")))),
    fetchPublicResource(url, {
      mimeTypes: ["text/html", "application/xhtml+xml"], maxBytes: 4 * 1024 * 1024, timeoutMs: 8000, signal,
      allowUrl: target => target.href === url,
    }).then(r => watchMetadata(r.bytes.toString("utf8"), id)),
  ]);
  signal?.throwIfAborted();
  const embed = embedResult.status === "fulfilled" ? embedResult.value : undefined;
  const page = watchResult.status === "fulfilled" ? watchResult.value : undefined;
  if (!embed && !page?.title && !page?.description && !page?.durationSeconds) throw new Error("unavailable");
  const title = embed?.title ?? page?.title;
  const thumbnail = URL.parse(embed?.thumbnail_url ?? "");
  let subtitles: SubtitleSegment[] | undefined;
  if (page?.captionTrack && page.durationSeconds && page.durationSeconds <= MAX_VIDEO_SECONDS) {
    try {
      const track = await fetchPublicResource(page.captionTrack, {
        mimeTypes: ["text/vtt", "application/octet-stream", "text/plain"], maxBytes: 256 * 1024, timeoutMs: 4000, signal,
        allowUrl: target => target.href === page.captionTrack,
      });
      const parsed = parseWebVtt(track.bytes.toString("utf8"), page.durationSeconds);
      if (parsed.length) subtitles = parsed;
    } catch { signal?.throwIfAborted(); }
  }
  const post: YouTubeMetadata = {
    platform: "youtube", url, title, author: embed?.author_name ?? page?.author,
    caption: (page?.description ?? "").trim().slice(0, 8000),
    thumbnailUrl: thumbnail?.origin === "https://i.ytimg.com" && !thumbnail.username && !thumbnail.password ? thumbnail.href : undefined,
    durationSeconds: page?.durationSeconds, ...(subtitles && { subtitles }),
  };
  return { post, formats: page?.formats ?? [] };
}

export async function loadYouTubePost(raw: string, signal?: AbortSignal): Promise<YouTubePost> {
  const { post } = await readYouTubePost(raw, signal);
  return { ...post, youtubeUrl: post.url };
}

class YouTubeMediaUnavailable extends SocialVideoSourceError {
  readonly title?: string;
  constructor(reason: "unavailable" | "too_large", post: YouTubeMetadata) {
    super(reason, post.caption, post);
    this.title = post.title;
  }
}

export async function loadYouTubeVideo(raw: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(35_000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const { post, formats } = await readYouTubePost(raw, active);
  if ((post.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) throw new YouTubeMediaUnavailable("too_large", post);
  if (!post.durationSeconds) throw new YouTubeMediaUnavailable("unavailable", post);
  const allowed = formats.filter(f => !f.contentLength || Number(f.contentLength) <= MAX_VIDEO_BYTES);
  let tooLarge = formats.length > 0 && allowed.length === 0;
  for (const format of allowed.slice(0, 2)) {
    const fileId = new URL(format.url).searchParams.get("id");
    try {
      const media = await fetchPublicResource(format.url, {
        mimeTypes: ["video/mp4", "application/octet-stream"], maxBytes: MAX_VIDEO_BYTES, timeoutMs: 14_000, signal: active,
        allowUrl: url => playbackUrl(url) && (!fileId || url.searchParams.get("id") === fileId),
      });
      if (media.status !== 200 || (format.contentLength && Number(format.contentLength) !== media.bytes.length)) continue;
      const mimeType = videoMime(media.bytes, media.mime);
      if (mimeType === "video/mp4") return { ...post, mimeType, bytes: media.bytes };
    } catch (error) {
      signal?.throwIfAborted();
      if (active.aborted) break;
      if (error instanceof FetchBlockedError && error.reason === "too_large") tooLarge = true;
    }
  }
  throw new YouTubeMediaUnavailable(tooLarge ? "too_large" : "unavailable", post);
}
