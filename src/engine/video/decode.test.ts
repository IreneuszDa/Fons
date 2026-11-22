import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeVideo } from "./decode";
import { readVideo } from "./intake";
import { makeEnv } from "../../server/testkit";
import { FakeLlmProvider } from "../llm/fake";
import { memoryStore } from "../testing/stubs";
import { verifyInput } from "../verify";

const installed = ["ffmpeg", "ffprobe"].every(tool => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0);

async function movie(args: string[], webm = false) {
  const dir = await mkdtemp(join(tmpdir(), "fons-test-movie-"));
  try {
    const path = join(dir, webm ? "clip.webm" : "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-filter_threads", "1", ...args, "-threads", "1", path], { timeout: 30_000 });
    return { mimeType: webm ? "video/webm" : "video/mp4", bytes: await readFile(path) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("rejects cancelled jobs and out-of-bounds metadata before launching any decoder", async () => {
  const media = { mimeType: "video/mp4", bytes: Buffer.alloc(0), durationSeconds: 601 };
  await expect(decodeVideo(media, { includeAudio: true })).rejects.toThrow("video_too_long");
  await expect(decodeVideo(media, { includeAudio: true, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
});

it.skipIf(!installed)("decodes an audio-only recording with no fabricated frames and rejects a video disguised as audio", { timeout: 30_000 }, async () => {
  const sound = await movie(["-f", "lavfi", "-i", "sine=frequency=500:duration=0.5", "-c:a", "aac"]);
  const decoded = await decodeVideo({ ...sound, mimeType: "audio/mp4" }, { includeAudio: true });
  expect(decoded.frames).toEqual([]);
  expect(decoded.file).toMatchObject({ bytes: sound.bytes.length, audio: { codec: "aac", sampleRateHz: 44100, channels: 1 } });
  expect(decoded.audio?.[0]?.durationSeconds).toBeGreaterThan(0);
  const clip = await movie(["-f", "lavfi", "-i", "color=s=32x32:d=0.5", "-c:v", "mpeg4"]);
  await expect(decodeVideo({ ...clip, mimeType: "audio/mp4" }, { includeAudio: true })).rejects.toThrow("video_decode_failed");
  const llm = new FakeLlmProvider();
  const env = makeEnv({ cfg: { dailyTokenBudget: 0 }, engine: req => verifyInput(req, {
    llm, verifier: llm, singleKey: true, branches: [], db: env.db, store: memoryStore([]),
    fetchPage: vi.fn(), now: env.ctx.now, verdictMode: "rules",
  }) });
  try {
    const res = await env.app.request("/api/chat/recording", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Pokaż metadane tego nagrania.", recording: { mime: "audio/mp4", base64: sound.bytes.toString("base64") } }) });
    const { reply } = await res.json();
    expect(reply).toMatchObject({ kind: "answer", report: { status: "OK", mainVerdict: null, models: [],
      videoAnalysis: { status: "metadata_only", transcript: [], file: decoded.file } } });
    expect(await (await env.app.request("/api/report/" + reply.report.token)).json()).toMatchObject({ videoAnalysis: reply.report.videoAnalysis });
    expect(llm.calls).toHaveLength(0);
  } finally { env.db.close(); }
});

it("reports a missing system decoder", async () => {
  vi.stubEnv("PATH", "");
  try {
    const media = { mimeType: "video/mp4", bytes: Buffer.from([0]) };
    await expect(decodeVideo(media, { includeAudio: true })).rejects.toThrow("video_decoder_missing");
  } finally {
    vi.unstubAllEnvs();
  }
});

it.skipIf(!installed)("does not send a silent recording to Gemini or produce words from silence", { timeout: 30_000 }, async () => {
  const sound = await movie(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1", "-c:a", "aac"]);
  const analyze = vi.fn();
  const intake = await readVideo("", "upload_audio", "Przepisz nagranie", { provider: "gemini", load: vi.fn(), analyze },
    () => {}, undefined, { mime: "audio/mp4", base64: sound.bytes.toString("base64") });
  expect(intake.analysis).toMatchObject({ status: "unavailable", transcript: [], claimOrigins: [] });
  expect(intake.message).toContain("Nie rozpoznałem mowy");
  expect(analyze).not.toHaveBeenCalled();
});

describe.skipIf(!installed)("FFmpeg video decoder", { timeout: 30_000 }, () => {
  it("preserves variable-rate frame times and the audio offset, including when platform captions skip audio", async () => {
    const media = await movie([
      "-f", "lavfi", "-i", "color=c=red:s=48x80:r=10:d=0.3",
      "-itsoffset", "1.2", "-f", "lavfi", "-i", "sine=frequency=450:duration=1",
      "-vf", "setpts='if(eq(N,0),0,if(eq(N,1),24,46))'", "-fps_mode", "vfr", "-c:v", "mpeg4", "-c:a", "aac",
    ]);
    const v = await decodeVideo(media, { includeAudio: true });
    expect(v.durationSeconds).toBeCloseTo(4.7);
    expect(v.frames.map(frame => frame.seconds)).toEqual([0, 2.4, 4.6]);
    expect(v.frames.every(frame => frame.bytes.readUInt16BE(0) === 0xffd8)).toBe(true);
    expect(v.audio).toHaveLength(1);
    expect(v.audio![0]!.seconds).toBeCloseTo(1.2, 1);
    expect(v.audio![0]!.durationSeconds).toBeCloseTo(1, 1);
    expect(v.audio![0]!.bytes.toString("ascii", 8, 12)).toBe("WAVE");
    const captions = await decodeVideo(media, { includeAudio: false });
    expect(captions.frames.map(frame => frame.seconds)).toEqual([0, 2.4, 4.6]);
    expect(captions.audio).toBeUndefined();
  });

  it("reads WebM and preserves the difference between a silent and missing audio track", async () => {
    const image = ["-f", "lavfi", "-i", "color=c=blue:s=32x32:r=2:d=1"];
    const silent = await movie([...image, "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1",
      "-c:v", "libvpx", "-c:a", "libopus"], true);
    const result = await decodeVideo(silent, { includeAudio: true });
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.audio).toEqual([]);
    const mute = await movie([...image, "-c:v", "mpeg4"]);
    expect((await decodeVideo(mute, { includeAudio: true })).audio).toBeUndefined();
  });

  it("covers the full timeline with at most 32 frames and splits speech at a pause", { timeout: 45_000 }, async () => {
    const media = await movie(["-f", "lavfi", "-i", "color=s=32x32:r=2:d=54",
      "-f", "lavfi", "-i", "sine=frequency=390:sample_rate=16000:duration=54",
      "-af", "volume='if(between(t,20,24),0,1)':eval=frame", "-c:v", "mpeg4", "-c:a", "alac"]);
    const { frames, audio } = await decodeVideo(media, { includeAudio: true });
    expect(frames).toHaveLength(32);
    expect(frames.at(-1)!.seconds).toBeGreaterThan(51);
    expect(audio).toHaveLength(3);
    expect(audio!.every(a => a.durationSeconds <= 25)).toBe(true);
    expect(audio![0]!.durationSeconds).toBeCloseTo(20, 0);
    expect(audio![1]!.seconds).toBeCloseTo(24, 0);
    expect(audio!.at(-1)!.seconds + audio!.at(-1)!.durationSeconds).toBeCloseTo(54, 1);
  });

  it("rejects overlong packet timelines even when both declared durations are shorter", async () => {
    const media = await movie(["-f", "lavfi", "-i", "color=s=32x32:r=1/601:d=620", "-c:v", "libvpx"], true);
    // Matroska Duration. Intentionally shorten the declared double; the second packet is still at 601 s.
    const offset = media.bytes.indexOf(Buffer.from([0x44, 0x89, 0x88]));
    expect(offset).toBeGreaterThan(0);
    media.bytes.writeDoubleBE(1000, offset + 3);
    await expect(decodeVideo({ ...media, durationSeconds: 1 }, { includeAudio: false })).rejects.toThrow("video_too_long");
  });

  it("rejects text masquerading as MP4", async () => {
    await expect(decodeVideo({ bytes: Buffer.from("not a media file"), mimeType: "video/mp4" },
      { includeAudio: false })).rejects.toThrow("video_decode_failed");
  });
});
