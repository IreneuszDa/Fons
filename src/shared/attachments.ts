import type { VideoAnalysis } from "./contracts";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_TEXT_CHARS = 4000;
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DOCUMENT_MIMES = ["text/plain", "application/pdf"] as const;
export const AUDIO_MIMES = ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm"] as const;
export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const RECORDING_MIMES = [...AUDIO_MIMES, ...VIDEO_MIMES] as const;
export const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 600;

export type ChatImage = { mime: (typeof IMAGE_MIMES)[number]; base64: string };
export type ChatDocument = { mime: (typeof DOCUMENT_MIMES)[number]; base64: string };
export type ChatRecording = { mime: (typeof RECORDING_MIMES)[number]; base64: string };
export function mediaClaimSubject(analysis: VideoAnalysis): string {
  if (analysis.status === "caption_only") return "opisu posta";
  return analysis.platform === "upload_audio" ? "nagrania audio" : "filmu";
}
export type ImageOptions = { searchWeb?: boolean };
