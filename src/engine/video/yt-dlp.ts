import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SocialVideoSourceError, socialPostId, videoMime, type SocialVideo } from "./social-source";

const worker = fileURLToPath(new URL("../../../scripts/social-video.py", import.meta.url));
const python = fileURLToPath(new URL("../../../.cache/video-tools/bin/python", import.meta.url));
const execute = promisify(execFile);
const reply = z.object({ status: z.enum(["ok", "unsupported", "unavailable", "too_large"]),
  caption: z.string().optional(), author: z.string().optional(), duration: z.number().nonnegative().nullish() });

export async function recoverSocialVideo(original: SocialVideoSourceError, signal?: AbortSignal): Promise<SocialVideo> {
  const url = original.url;
  const id = url && socialPostId(url);
  if (!url || !id) throw original;
  const platform = id.startsWith("instagram:") ? "instagram" : "tiktok";
  const dir = await mkdtemp(join(tmpdir(), "fons-social-"));
  try {
    const file = join(dir, "video");
    const { stdout } = await execute(python, ["-I", worker, platform, url, id.slice(platform.length + 1), file,
      String(MAX_VIDEO_BYTES), String(MAX_VIDEO_SECONDS)], {
      signal, timeout: 35_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
    });
    const result = reply.parse(JSON.parse(stdout));
    if (result.status === "too_large") throw new SocialVideoSourceError("too_large", original.caption, original);
    if (result.status !== "ok") throw original;
    const bytes = await readFile(file, { signal });
    const mimeType = videoMime(bytes, "application/octet-stream");
    if (!mimeType || bytes.length > MAX_VIDEO_BYTES) throw original;
    return { platform, url, bytes, mimeType, caption: original.caption || result.caption || "",
      author: original.author || result.author, durationSeconds: result.duration ?? undefined,
      subtitles: original.subtitles, thumbnailUrl: original.thumbnailUrl };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SocialVideoSourceError) throw error;
    throw original;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
