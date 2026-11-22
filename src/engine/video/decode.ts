import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LlmUnavailableError } from "../../shared/contracts";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } from "./social-source";

const exec = promisify(execFile);
const MAX_FRAMES = 32;
const MAX_PIXELS = 4096 * 4096;
const SAMPLE_RATE = 16_000;

export interface DecodedVideo {
  durationSeconds: number;
  frames: { seconds: number; bytes: Buffer }[];
  wav?: Buffer;
  audio?: { seconds: number; durationSeconds: number; bytes: Buffer }[];
}

function failure(code = "video_decode_failed") {
  return new LlmUnavailableError("provider_error", code);
}

async function run(tool: "ffmpeg" | "ffprobe", args: string[], signal: AbortSignal, maxBuffer: number) {
  signal.throwIfAborted();
  try {
    const { stdout } = await exec(tool, args, {
      encoding: "buffer", signal, maxBuffer, killSignal: "SIGKILL", windowsHide: true,
      env: { PATH: process.env.PATH, LANG: "C" },
    });
    return stdout;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw failure("video_decoder_missing");
    throw failure();
  }
}

// Read actual packet endpoints as well as the container duration, including audio when using platform
// subtitles. Short or absent metadata must not turn a long clip into a billable short one.
function timeline(probe: Buffer, audioOnly: boolean) {
  const ends = new Map<number, number>();
  let video: number | undefined;
  let audio: number | undefined;
  let start = 0;
  let declaredDuration = 0;
  for (const line of probe.toString("utf8").split("\n")) {
    const packet = /^packet\|stream_index=(\d+)\|pts_time=([-\d.]+)\|duration_time=([\d.]+|N\/A)/.exec(line);
    if (packet) {
      const index = Number(packet[1]);
      const end = Number(packet[2]) + (Number(packet[3]) || 0);
      ends.set(index, Math.max(ends.get(index) ?? -Infinity, end));
      continue;
    }
    if (line.startsWith("stream|") || line.startsWith("format|")) {
      const fields = Object.fromEntries(line.split("|").slice(1).map(field => field.split("=")));
      if (line.startsWith("format|")) {
        start = Number(fields.start_time) || 0;
        declaredDuration = Number(fields.duration) || 0;
      } else if (fields.codec_type === "video" && fields["disposition:attached_pic"] === "0" && video === undefined) {
        const pixels = Number(fields.width) * Number(fields.height);
        if (!(pixels > 0 && pixels <= MAX_PIXELS)) throw failure();
        video = Number(fields.index);
      } else if (fields.codec_type === "audio" && audio === undefined) {
        audio = Number(fields.index);
      }
    }
  }
  if (audioOnly ? audio === undefined || video !== undefined : video === undefined) throw failure();
  const end = Math.max(video === undefined ? 0 : ends.get(video) ?? 0, audio === undefined ? 0 : ends.get(audio) ?? 0);
  const duration = Math.max(end - start, declaredDuration);
  if (!Number.isFinite(duration) || duration <= 0) throw failure("video_duration_unknown");
  // Packet times are printed to microseconds. Adding two rounded numbers can overshoot the limit.
  if (duration > MAX_VIDEO_SECONDS + 0.000002) throw failure("video_too_long");
  return { video, audio, duration: Math.min(duration, MAX_VIDEO_SECONDS) };
}

function wav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function audioChunks(pcm: Buffer): NonNullable<DecodedVideo["audio"]> {
  const blockSamples = SAMPLE_RATE / 50;
  const blockBytes = blockSamples * 2;
  const levels = [];
  for (let offset = 0; offset < pcm.length; offset += blockBytes) {
    const end = Math.min(offset + blockBytes, pcm.length);
    let power = 0;
    for (let i = offset; i + 1 < end; i += 2) power += pcm.readInt16LE(i) ** 2;
    levels.push(power / Math.max(1, (end - offset) / 2));
  }
  const chunks = [];
  // Preserve media time across pauses. Prefer a quiet boundary in the last 5s of each 25s window.
  const quiet = 16 ** 2;
  let first = 0;
  while (first < levels.length) {
    while (first < levels.length && levels[first]! <= quiet) first++;
    if (first === levels.length) break;
    let next = Math.min(first + 25 * 50, levels.length);
    if (next < levels.length) {
      for (let i = next - 1; i >= next - 5 * 50; i--) {
        if (levels[i]! <= quiet) { next = i + 1; break; }
      }
    }
    let last = next;
    while (last > first && levels[last - 1]! <= quiet) last--;
    const data = pcm.subarray(first * blockBytes, last * blockBytes);
    chunks.push({ seconds: first / 50, durationSeconds: data.length / (SAMPLE_RATE * 2), bytes: wav(data) });
    first = next;
  }
  return chunks;
}

export async function decodeVideo(
  media: { bytes: Uint8Array; mimeType: string; durationSeconds?: number },
  options: { includeAudio: boolean; probeOnly?: boolean; continuousAudio?: boolean; signal?: AbortSignal },
): Promise<DecodedVideo> {
  options.signal?.throwIfAborted();
  if (media.bytes.length > MAX_VIDEO_BYTES) throw failure("video_too_large");
  if ((media.durationSeconds ?? 0) > MAX_VIDEO_SECONDS) throw failure("video_too_long");
  const formats: Record<string, string> = {
    "video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska",
    "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "matroska", "audio/mp4": "mov",
  };
  const format = formats[media.mimeType];
  if (!media.bytes.length || !format) throw failure();
  const audioOnly = media.mimeType.startsWith("audio/");
  const deadline = AbortSignal.timeout(90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const dir = await mkdtemp(join(tmpdir(), "fons-video-"));
  try {
    const path = join(dir, "source");
    await writeFile(path, media.bytes, { mode: 0o600, signal });
    // Force one of the supported demuxers and disable MOV external track references. Only our
    // private input file is needed. In particular, no remote protocols or playlist demuxers run.
    const mov = format === "mov";
    const input = ["-v", "error", "-max_alloc", String(128 * 1024 ** 2), "-protocol_whitelist", "file",
      "-max_pixels", String(MAX_PIXELS), "-max_streams", "16", "-format_whitelist", format === "matroska" ? "matroska,webm" : format,
      "-f", format, ...(mov ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : [])];
    const rows = await run("ffprobe", [...input, "-i", path, "-show_entries",
      "packet=stream_index,pts_time,duration_time:stream=index,codec_type,width,height:stream_disposition=attached_pic:format=duration,start_time",
      "-of", "compact"], signal, 16 * 1024 ** 2);
    const info = timeline(rows, audioOnly);
    const result: DecodedVideo = { frames: [], durationSeconds: info.duration };
    if (options.probeOnly) return result;
    const decode = ["-nostdin", "-copyts", "-start_at_zero", "-filter_threads", "1", "-threads", "1", ...input, "-i", path];
    if (!audioOnly) {
      const interval = Math.max(1, info.duration / MAX_FRAMES);
      // Sample the first original frame in each interval. Its filename is the actual PTS in ms,
      // even when a variable-rate recording has no frame exactly on the desired boundary.
      const select = `select='isnan(prev_selected_t)+gt(floor(t/${interval}),floor(prev_selected_t/${interval}))'`;
      const scale = "scale=w='min(iw,768)':h='min(ih,768)':force_original_aspect_ratio=decrease:force_divisible_by=2";
      await run("ffmpeg", [...decode, "-map", `0:${info.video}`, "-vf", select + "," + scale,
        "-fps_mode", "passthrough", "-frames:v", String(MAX_FRAMES), "-c:v", "mjpeg", "-threads", "1", "-q:v", "4",
        "-enc_time_base", "1:1000", "-frame_pts", "1", join(dir, "frame-%012d.jpg")], signal, 256 * 1024);
      for (const name of (await readdir(dir)).sort()) {
        const match = /^frame-(\d+)\.jpg$/.exec(name);
        if (!match) continue;
        const seconds = Number(match[1]) / 1000;
        if (seconds > info.duration + 0.001) throw failure();
        result.frames.push({ seconds: Math.min(seconds, info.duration), bytes: await readFile(join(dir, name), { signal }) });
      }
      if (!result.frames.length) throw failure();
    }
    if (options.includeAudio && info.audio !== undefined) {
      const pcm = await run("ffmpeg", [...decode, "-map", `0:${info.audio}`, "-vn", "-sn", "-dn",
        "-af", `aresample=${SAMPLE_RATE}:async=1:first_pts=0`, "-ac", "1", "-ar", String(SAMPLE_RATE),
        "-t", String(MAX_VIDEO_SECONDS), "-f", "s16le", "pipe:1"], signal, MAX_VIDEO_SECONDS * SAMPLE_RATE * 2 + 65_536);
      if (options.continuousAudio) result.wav = wav(pcm);
      else result.audio = audioChunks(pcm);
    }
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (deadline.aborted) throw new LlmUnavailableError("timeout");
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
