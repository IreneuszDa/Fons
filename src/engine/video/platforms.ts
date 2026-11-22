import type { VideoAnalysis } from "../../shared/contracts";
import { loadFacebookCaption, loadFacebookVideo, parseFacebookPost } from "./facebook";
import { createSocialVideoLoader as createShortVideoLoader, loadSocialCaption, socialVideoPlatform as shortVideoPlatform, type SocialVideo, type SocialVideoMetadata } from "./social-source";
import { canonicalYouTubeUrl, loadYouTubePost, loadYouTubeVideo, type YouTubePost } from "./youtube";

type Caption = SocialVideoMetadata & { url: string; caption: string; title?: string };
type Video = Caption & (Omit<SocialVideo, "platform"> & { platform: VideoAnalysis["platform"] } | YouTubePost);

export function socialVideoPlatform(url: string): Exclude<VideoAnalysis["platform"], "upload_audio" | "upload_video"> | undefined {
  if (canonicalYouTubeUrl(url)) return "youtube";
  return parseFacebookPost(url)?.platform ?? shortVideoPlatform(url);
}

/** Preserve the video ID, including query-based IDs. Discard share tokens in tracking parameters. */
export function publicPostUrl(raw: string): string {
  const youtube = canonicalYouTubeUrl(raw);
  if (youtube) return youtube;
  const facebook = parseFacebookPost(raw);
  if (facebook) return facebook.url.href;
  const url = new URL(raw);
  return url.origin + url.pathname;
}

export async function loadVideoCaption(url: string, signal?: AbortSignal): Promise<Caption> {
  if (canonicalYouTubeUrl(url)) return loadYouTubePost(url, signal);
  if (parseFacebookPost(url)) return loadFacebookCaption(url, signal);
  return loadSocialCaption(url, signal, true);
}

export function createVideoLoader(socialKitApiKey?: string, provider: "gemini" | "openai" = "gemini") {
  const loadShortVideo = createShortVideoLoader(socialKitApiKey);
  return async (url: string, signal?: AbortSignal): Promise<Video> => {
    if (canonicalYouTubeUrl(url)) return provider === "openai" ? loadYouTubeVideo(url, signal) : loadYouTubePost(url, signal);
    if (parseFacebookPost(url)) return loadFacebookVideo(url, signal);
    return loadShortVideo(url, signal);
  };
}
