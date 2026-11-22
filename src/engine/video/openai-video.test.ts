import { describe, expect, it, vi } from "vitest";
import { parseFences } from "../llm/fence";
import { createOpenAiVideoAnalyzer, DEFAULT_OPENAI_VIDEO_MODEL, OPENAI_TRANSCRIPTION_MODEL } from "./openai-video";

const media = { bytes: Buffer.from("clip"), mimeType: "video/mp4", durationSeconds: 45, caption: "Treść opisu." };
const frames = [{ seconds: 1.25, bytes: Buffer.from("jpeg 1") }, { seconds: 33.5, bytes: Buffer.from("jpeg 2") }];
const audio = [ { seconds: 2, durationSeconds: 18, bytes: Buffer.from("wav 1") }, { seconds: 20, durationSeconds: 14, bytes: Buffer.from("wav 2") } ];
const speech = { source: "speech", sourceIndex: 0, quote: "Polska jest w NATO.", text: "Polska jest w NATO.", temporalKind: "stan", date: null };
const visual = { ...speech, source: "onscreen", sourceIndex: 1, quote: "Plansza z napisem XYZ." };
const observations = [{ frameIndex: 1, text: visual.quote }, { frameIndex: 20, text: "Nie było takiej klatki." }];
function complete(result: unknown) {
  return Response.json({
    model: DEFAULT_OPENAI_VIDEO_MODEL, usage: { prompt_tokens: 100, completion_tokens: 20 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
  });
}
function setup() {
  const decode = vi.fn(async () => ({ durationSeconds: 45, frames, audio }));
  const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const analyze = createOpenAiVideoAnalyzer({ apiKey: "test-key", fetchImpl, decode, dataResidency: "eu" });
  return { analyze, decode, fetchImpl };
}

describe("OpenAI frame analysis", () => {
  it("sends transcription and vision requests to OPENAI_BASE_URL when set", async () => {
    const decode = vi.fn(async () => ({ durationSeconds: 45, frames, audio }));
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const analyze = createOpenAiVideoAnalyzer({ apiKey: "test-key", fetchImpl, decode, dataResidency: "eu", baseUrl: "https://openrouter.ai/api/v1" });
    fetchImpl.mockResolvedValueOnce(Response.json({ text: "Polska jest" }))
      .mockResolvedValueOnce(Response.json({ text: "w NATO." }))
      .mockResolvedValueOnce(complete({ observations: [], claims: [speech] }));
    await analyze(media);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/audio/transcriptions", "https://openrouter.ai/api/v1/audio/transcriptions", "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("transcribes a voice note with timestamped segments without making a vision request", async () => {
    const { analyze, decode, fetchImpl } = setup();
    decode.mockResolvedValueOnce({ durationSeconds: 25, frames: [], audio: [audio[0]!] });
    fetchImpl.mockResolvedValueOnce(Response.json({ text: "Polska jest w NATO." }));
    const result = await analyze({ ...media, mimeType: "audio/wav" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toMatch(/\/audio\/transcriptions$/);
    expect(result.usage.purpose).toBe("video_transcription");
    expect(result.data).toEqual({ transcript: [{ seconds: 2, text: "Polska jest w NATO." }], observations: [], claims: [] });
  });
  it("transcribes decoded segments, uses sampled frame times and independently anchors every proposed claim", async () => {
    const { analyze, decode, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ text: "Polska jest" }))
      .mockResolvedValueOnce(Response.json({ text: "w NATO." }))
      .mockResolvedValueOnce(complete({ observations, claims: [
        speech, visual, { ...visual, sourceIndex: 0 }, { ...speech, quote: "Rzecz zmyślona." },
        { ...speech, source: "caption", sourceIndex: null, quote: media.caption }, { ...speech, sourceIndex: 1 },
      ] }));
    const { data, usage, additionalUsage } = await analyze(media);
    expect(decode).toHaveBeenCalledWith(media, expect.objectContaining({ includeAudio: true }));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://eu.api.openai.com/v1/audio/transcriptions", "https://eu.api.openai.com/v1/audio/transcriptions", "https://eu.api.openai.com/v1/chat/completions",
    ]);
    expect((fetchImpl.mock.calls[0]![1].body as FormData).get("model")).toBe(OPENAI_TRANSCRIPTION_MODEL);
    const body = JSON.parse(String(fetchImpl.mock.calls[2]![1].body));
    expect(body.store).toBe(false);
    expect(body.messages[1].content.slice(0, 2).map((item: {image_url: {url:string}}) => item.image_url.url)).toEqual(
      frames.map(frame => "data:image/jpeg;base64," + frame.bytes.toString("base64")));
    expect(data.transcript).toEqual([{ seconds: 2, text: "Polska jest" }, { seconds: 20, text: "w NATO." }]);
    expect(data.observations).toEqual([{ seconds: 33.5, text: visual.quote }]);
    expect(data.claims.map(c => [c.source, c.seconds, c.quote])).toEqual([
      ["speech", 2, speech.quote], ["onscreen", 33.5, visual.quote], ["caption", null, media.caption],
    ]);
    expect(usage).toMatchObject({ provider: "openai", purpose: "video_analysis", inputTokens: 100, outputTokens: 20 });
    expect(additionalUsage).toHaveLength(2);
    expect(additionalUsage?.[0]).toMatchObject({ purpose: "video_transcription", model: OPENAI_TRANSCRIPTION_MODEL, costUsd: 0.00135 });
  });

  it("reuses platform captions and never sends a transcription request or media URL", async () => {
    const { analyze, decode, fetchImpl } = setup();
    const subtitles = [{ seconds: 6.5, text: "Polska jest w NATO." }];
    fetchImpl.mockResolvedValueOnce(complete({ observations: [], claims: [speech] }));
    expect((await analyze({ ...media, subtitles })).data).toMatchObject({ transcript: subtitles, claims: [{ seconds: 6.5 }] });
    expect(decode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeAudio: false }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(analyze({ youtubeUrl: "https://youtu.be/abcdefghijk" })).rejects.toThrow("video_file_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("masks speech before vision and retains billable ASR and vision usage after invalid findings", async () => {
    const { analyze, decode, fetchImpl } = setup();
    decode.mockResolvedValueOnce({ durationSeconds: 45, frames, audio: [audio[0]!] });
    const raw = "Napisz do test@example.net.";
    fetchImpl.mockResolvedValueOnce(Response.json({ text: raw, usage: { type: "duration", seconds: 19 } })).mockResolvedValueOnce(complete({}));
    await expect(analyze(media)).rejects.toMatchObject({ reason: "schema", transcript: [{ seconds: 2, text: raw }], usages: [
      { purpose: "video_transcription", costUsd: 0.001425 }, { purpose: "video_analysis", inputTokens: 100, outputTokens: 20 },
    ] });
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1].body));
    const context = parseFences(body.messages[1].content.at(-1).text).find(f => f.label === "TRANSKRYPCJA");
    expect(context?.content).toContain("[EMAIL]");
    expect(context?.content).not.toContain("test@example.net");
  });

  it("accounts for the other parallel ASR request on quota failure without reporting a partial transcript as complete", async () => {
    const { analyze, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ text: "Dalsza wypowiedź." }));
    await expect(analyze(media)).rejects.toMatchObject({ reason: "budget", transcript: undefined, usages: [{ purpose: "video_transcription" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("records each billed vision attempt exactly once across a length retry, success=%s", async success => {
    const { analyze, decode, fetchImpl } = setup();
    decode.mockResolvedValueOnce({ frames, durationSeconds: 45, audio: [] });
    fetchImpl.mockResolvedValueOnce(Response.json({ model: DEFAULT_OPENAI_VIDEO_MODEL,
      usage: { prompt_tokens: 300, completion_tokens: 100 }, choices: [{ finish_reason: "length", message: { content: "" } }] }))
      .mockResolvedValueOnce(complete(success ? { observations: [], claims: [] } : {}));
    const analysis = analyze(media);
    if (success) {
      expect(await analysis).toMatchObject({ additionalUsage: [], usage: { inputTokens: 400, outputTokens: 120, costUsd: 0.0001 } });
    } else {
      await expect(analysis).rejects.toMatchObject({ usages: [
        { inputTokens: 300, outputTokens: 100, costUsd: 0.00008 }, { inputTokens: 100, outputTokens: 20, costUsd: 0.00002 },
      ] });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("analyzes silent clips with no speech and rejects invalid inputs before billing", async () => {
    const { analyze, decode, fetchImpl } = setup();
    decode.mockResolvedValueOnce({ frames, durationSeconds: 45, audio: [] });
    fetchImpl.mockResolvedValueOnce(complete({ observations: [], claims: [speech] }));
    expect(await analyze(media)).toMatchObject({ data: { transcript: [], claims: [] }, additionalUsage: [] });
    await expect(analyze({ ...media, durationSeconds: 601 })).rejects.toThrow("video_too_long");
    await expect(analyze(media, AbortSignal.abort())).rejects.toThrow("timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
