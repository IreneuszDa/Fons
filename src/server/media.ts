import { createOpenAiVideoAnalyzer, OpenAiVideoAnalysisError } from "../engine/video/openai-video";
import { addTokens } from "./budget";
import type { MediaItem, ServerContext } from "./context";

export function attachmentBase64Ok(base64: string, maxBytes: number): boolean {
  return base64.length % 4 !== 1 && Buffer.byteLength(base64, "base64") <= maxBytes
    && /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
}

export function imageMagicOk(mime: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 32), "base64");
  if (mime === "image/png") return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === "image/jpeg") return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
}

export async function transcribeAudio(
  ctx: ServerContext, { base64, mime }: MediaItem, signal: AbortSignal, onTokens?: (tokens: number) => void,
): Promise<string> {
  const analyze = createOpenAiVideoAnalyzer({
    apiKey: ctx.cfg.openaiApiKey, fetchImpl: ctx.fetch, dataResidency: ctx.cfg.openaiDataResidency,
  });
  let tokens = 0;
  try {
    const result = await analyze({ bytes: Buffer.from(base64, "base64"), mimeType: mime }, signal);
    tokens = [result.usage, ...(result.additionalUsage ?? [])].reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
    return result.data.transcript.map(segment => segment.text).join(" ");
  } catch (error) {
    if (error instanceof OpenAiVideoAnalysisError) tokens = error.usages.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
    throw error;
  } finally {
    addTokens(ctx.db, ctx.now(), tokens);
    onTokens?.(tokens);
  }
}
