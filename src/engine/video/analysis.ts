import { z } from "zod";
import { Claim, type DetectorHit, type LlmResponse, type ModelUsage, type VideoAnalysis } from "../../shared/contracts";
import { MAX_CLAIMS_LONG } from "../claims";
import { isolateFenceMarkers } from "../normalize";
import { detectInjection, maskPii, stripFlaggedSentences } from "../ports";
import { cleanText } from "../text";
import { MAX_VIDEO_SECONDS } from "./social-source";
import type { SubtitleSegment } from "./webvtt";

export function sanitizeVideoText(raw: string, location: DetectorHit["location"], out?: DetectorHit[]): string {
  const input = isolateFenceMarkers(raw);
  const hits = detectInjection(input, location);
  out?.push(...hits);
  return maskPii(cleanText(hits.length ? stripFlaggedSentences(input, hits) : input)).text;
}

export type VideoAnalyzerInput = {
  subtitles?: SubtitleSegment[];
  caption?: string | null;
  durationSeconds?: number;
  focus?: string;
} & ({ bytes: Uint8Array; mimeType: string } | { youtubeUrl: string });

const seconds = z.number().min(0).max(MAX_VIDEO_SECONDS);
const segment = z.object({ seconds: seconds.int(), text: z.string().trim().min(1).max(2000) });
export const platformSubtitles = z.array(segment.extend({ seconds })).max(1200);
export const analysisSchema = z.object({
  transcript: z.array(segment).max(MAX_VIDEO_SECONDS),
  observations: z.array(segment).max(200),
  claims: z.array(z.object({
    source: z.enum(["speech", "onscreen", "visual", "caption"]),
    seconds: seconds.nullable(),
    quote: z.string().trim().min(1).max(1000),
    text: z.string().trim().min(1).max(1000),
    temporalKind: Claim.shape.temporal.shape.kind,
    date: z.string().max(10).nullable(),
  })).max(MAX_CLAIMS_LONG),
});
export type VideoAnalysisData = z.infer<typeof analysisSchema>;
export type VideoAnalyzer = (video: VideoAnalyzerInput, signal?: AbortSignal) => Promise<
  LlmResponse<VideoAnalysisData> & { additionalUsage?: ModelUsage[]; file?: VideoAnalysis["file"] }
>;
