import { describe, expect, it, vi } from "vitest";
import { parseFences } from "../llm/fence";
import { priceFor } from "../llm/pricing";
import { createGeminiVideoAnalyzer, DEFAULT_GEMINI_VIDEO_MODEL, type GeminiVideoAnalysis } from "./gemini";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } from "./social-source";
import { subtitleStart } from "./webvtt";

const video = { bytes: Buffer.from("film"), mimeType: "video/mp4", durationSeconds: 15, caption: "Opis autora", focus: "Co słychać?" };
const silent: GeminiVideoAnalysis = { transcript: [], observations: [], claims: [] };
const speech = { source: "speech", seconds: 2, quote: "Polska należy do NATO.", text: "Polska należy do NATO.", temporalKind: "stan", date: null } as const;
const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 400, thoughtsTokenCount: 100, totalTokenCount: 1500 };

function completion(data: unknown, finishReason = "STOP") {
  return Response.json({
    candidates: [{ finishReason, content: { parts: [{ thought: true, text: "ukryte" }, { text: JSON.stringify(data) }] } }],
    usageMetadata, modelVersion: DEFAULT_GEMINI_VIDEO_MODEL,
  });
}

function setup(response: Response) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { analyze: createGeminiVideoAnalyzer({ apiKey: "test-key", fetchImpl }), fetchImpl };
}

function box(type: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, bytes]);
}

function movie(seconds: number, version: 0 | 1): Buffer {
  const header = Buffer.alloc(version === 0 ? 20 : 32);
  header[0] = version;
  header.writeUInt32BE(1000, version === 0 ? 12 : 20);
  if (version === 0) header.writeUInt32BE(seconds * 1000, 16);
  else header.writeBigUInt64BE(BigInt(seconds * 1000), 24);
  return Buffer.concat([box("mdat", Buffer.from("mvhd")), box("moov", box("mvhd", header))]);
}

describe("Gemini video analysis", () => {
  it("passes the actual video and fenced context; keeps quotes matched to their source and start time", async () => {
    const printed = { ...speech, source: "onscreen", quote: "1999", seconds: 4 };
    const caption = { ...speech, source: "caption", quote: video.caption, seconds: null };
    const data = {
      transcript: [{ seconds: 2, text: speech.quote }, { seconds: 0, text: "Powitanie." }],
      observations: [{ seconds: 4, text: "Na planszy rok 1999" }],
      claims: [speech, printed, caption, { ...speech, seconds: 4 }, { ...speech, source: "caption", seconds: null }, { ...speech, quote: video.focus }],
    };
    const { analyze, fetchImpl } = setup(completion(data));
    const result = await analyze(video);
    expect(result.data.claims).toEqual([speech, printed, caption]);
    expect(result.data.transcript.map((item) => item.seconds)).toEqual([0, 2]);
    expect(result.usage).toMatchObject({ provider: "gemini", purpose: "video_analysis", inputTokens: 1000, outputTokens: 500 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_VIDEO_MODEL}:generateContent`);
    expect(init).toMatchObject({ redirect: "error", headers: { "x-goog-api-key": "test-key" } });
    const body = JSON.parse(String(init?.body));
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "video/mp4", data: video.bytes.toString("base64") } });
    expect(parseFences(body.contents[0].parts[1].text).map(({ label, content }) => [label, content])).toEqual([
      ["OPIS_POSTA", video.caption], ["TEMAT", video.focus],
    ]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toEqual(["transcript", "observations", "claims"]);
  });

  it.each([0, 1] as const)("derives duration from mvhd version %i when the platform omits it; allows silent clips", async (version) => {
    const { analyze } = setup(completion(silent));
    expect((await analyze({ bytes: movie(10, version), mimeType: "video/quicktime" })).data).toEqual(silent);
  });

  it("submits only the canonical watch URL for a public YouTube Short with a known duration", async () => {
    const { analyze, fetchImpl } = setup(completion(silent));
    await analyze({ youtubeUrl: "https://m.youtube.com/shorts/jNQXAC9IVRw?si=shared", durationSeconds: 19 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).contents[0].parts[0]).toEqual({
      fileData: { mimeType: "video/mp4", fileUri: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
    });
  });

  it("blocks unknown URLs, unmeasured YouTube videos and long videos before sending to Google", async () => {
    const { analyze, fetchImpl } = setup(completion(silent));
    await expect(analyze({ youtubeUrl: "https://example.org/video.mp4", durationSeconds: 5 })).rejects.toThrow("video_url");
    const youtubeUrl = "https://youtu.be/jNQXAC9IVRw";
    await expect(analyze({ youtubeUrl, subtitles: [{ seconds: 0, text: "hello" }] })).rejects.toThrow("video_duration_unknown");
    await expect(analyze({ youtubeUrl, durationSeconds: 601 })).rejects.toThrow("video_too_long");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses public subtitles for speech quotes while retaining Gemini's visual observations", async () => {
    const captionedSpeech = { ...speech, seconds: 2.42 };
    const subtitles = [{ seconds: captionedSpeech.seconds, text: speech.quote }];
    const fakeQuote = "Inne słowa.";
    const { analyze, fetchImpl } = setup(completion({
      transcript: [{ seconds: 3, text: fakeQuote }], observations: [{ seconds: 5, text: "Mapa." }],
      claims: [captionedSpeech, { ...speech, seconds: 3, quote: fakeQuote }],
    }));
    const { data } = await analyze({ ...video, subtitles });
    expect(data).toEqual({ transcript: subtitles, observations: [{ seconds: 5, text: "Mapa." }], claims: [captionedSpeech] });
    const context = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).contents[0].parts[1].text;
    expect(parseFences(context).find(f => f.label === "NAPISY")?.content).toBe(JSON.stringify(subtitles));
  });

  it("anchors a sentence split across consecutive platform cues at the selected occurrence", async () => {
    const subtitles = [
      { seconds: 0, text: "Na początku: Polska" }, { seconds: 1, text: "należy do NATO." },
      { seconds: 4.25, text: "Powtarzam: Polska" }, { seconds: 6, text: "należy do NATO. Następny temat." },
    ];
    const valid = { ...speech, seconds: 4.25 };
    const { analyze } = setup(completion({ ...silent, claims: [
      valid, { ...speech, seconds: 6 }, { ...speech, seconds: null }, { ...valid, quote: "Polska do NATO." },
    ] }));
    expect((await analyze({ ...video, subtitles })).data.claims).toEqual([valid]);
    expect(subtitleStart(subtitles, valid.quote)).toBe(0);
    expect(subtitleStart(subtitles, valid.quote, 4.25)).toBe(4.25);
    expect(subtitleStart(subtitles, valid.quote, 1)).toBeUndefined();
  });

  it("distinguishes exhausted credits from other provider failures", async () => {
    const { analyze } = setup(new Response(null, { status: 402 }));
    await expect(analyze(video)).rejects.toThrow("gemini_credits_depleted");
  });

  it("rejects long, large and unmeasurable inputs before calling Google", async () => {
    const { analyze, fetchImpl } = setup(completion(silent));
    await expect(analyze({ ...video, bytes: movie(MAX_VIDEO_SECONDS + 1, 0) })).rejects.toThrow("video_too_long");
    await expect(analyze({ ...video, durationSeconds: MAX_VIDEO_SECONDS + 1 })).rejects.toThrow("video_too_long");
    await expect(analyze({ ...video, bytes: new Uint8Array(MAX_VIDEO_BYTES + 1) })).rejects.toThrow("video_too_large");
    await expect(analyze({ ...video, durationSeconds: undefined })).rejects.toThrow("video_duration_unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not issue an unconfigured or cancelled request and hides upstream HTTP details", async () => {
    const { analyze, fetchImpl } = setup(new Response("private provider context", { status: 429 }));
    await expect(createGeminiVideoAnalyzer({ fetchImpl })(video)).rejects.toThrow("no_key");
    await expect(analyze(video, AbortSignal.abort())).rejects.toThrow("timeout");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(analyze(video)).rejects.toThrow("rate_limit");
  });

  describe("Files API for HD clips", () => {
    const large = { ...video, bytes: Buffer.alloc(12 * 1024 * 1024 + 1), durationSeconds: 250 };
    const origin = "https://generativelanguage.googleapis.com";
    const sessionUrl = `${origin}/upload/v1beta/files?upload_id=mock`;
    function filesApi(options: {
      state?: string;
      finalizeFailure?: boolean;
      duration?: string;
      generation?: () => Response;
      cancelOnPoll?: AbortController;
    } = {}) {
      let name = "";
      const events: string[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        if (url === `${origin}/upload/v1beta/files`) {
          events.push("start");
          name = JSON.parse(String(init?.body)).file.name;
          expect(name).toMatch(/^files\/[a-z0-9-]{1,40}$/);
          expect(init?.headers).toMatchObject({ "x-goog-upload-header-content-length": String(large.bytes.byteLength) });
          return new Response(null, { headers: { "x-goog-upload-url": sessionUrl } });
        }
        if (url === sessionUrl) {
          events.push("finalize");
          expect(init?.headers).not.toHaveProperty("x-goog-api-key");
          expect(init?.body).toBeInstanceOf(Uint8Array);
          if (options.finalizeFailure) throw new Error("lost response");
          return Response.json({ file: { name, state: options.state ?? "PROCESSING" } });
        }
        if (url === `${origin}/v1beta/${name}`) {
          if (init?.method === "DELETE") {
            events.push("delete");
            expect(init.signal?.aborted).toBe(false);
            return new Response(null, { status: 204 });
          }
          events.push("poll");
          if (options.cancelOnPoll) {
            options.cancelOnPoll.abort();
            throw new Error("cancelled");
          }
          return Response.json({ name, state: "ACTIVE", videoMetadata: { videoDuration: options.duration ?? "250s" } });
        }
        events.push("generate");
        const body = JSON.parse(String(init?.body));
        expect(body.contents[0].parts[0]).toEqual({ fileData: { mimeType: "video/mp4", fileUri: `${origin}/v1beta/${name}` } });
        expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(8192);
        return options.generation?.() ?? completion(silent);
      });
      return { events, analyze: createGeminiVideoAnalyzer({ apiKey: "test-key", fetchImpl }) };
    }
    it("uploads binary, waits for ACTIVE, sends fileData and deletes the file", async () => {
      const { analyze, events } = filesApi();
      expect((await analyze({ ...large, durationSeconds: undefined })).data).toEqual(silent);
      expect(events).toEqual(["start", "finalize", "poll", "generate", "delete"]);
    });
    it("deletes an already ACTIVE file even when inference is refused", async () => {
      const { analyze, events } = filesApi({ state: "ACTIVE", generation: () => completion(silent, "SAFETY") });
      await expect(analyze(large)).rejects.toMatchObject({ reason: "refusal", usage: { inputTokens: 1000 } });
      expect(events).toEqual(["start", "finalize", "generate", "delete"]);
    });
    it.each([
      [{ state: "FAILED" }, "video_processing_failed", ["start", "finalize", "delete"]],
      [{ finalizeFailure: true }, "connection", ["start", "finalize", "delete"]],
      [{ duration: "601s" }, "video_too_long", ["start", "finalize", "poll", "delete"]],
    ] as const)("cleans up and skips inference after processing or upload failure", async (options, message, events) => {
      const api = filesApi(options);
      await expect(api.analyze(large)).rejects.toThrow(message);
      expect(api.events).toEqual(events);
    });
    it("cancels polling without cancelling deletion", async () => {
      const controller = new AbortController();
      const { analyze, events } = filesApi({ cancelOnPoll: controller });
      await expect(analyze(large, controller.signal)).rejects.toThrow("timeout");
      expect(events).toEqual(["start", "finalize", "poll", "delete"]);
    });
  });

  it.each([
    [() => completion(silent, "MAX_TOKENS"), "schema"],
    [() => completion(silent, "SAFETY"), "refusal"],
    [() => completion({ ...silent, transcript: [{ seconds: 16, text: "Po zakończeniu filmu" }] }), "schema"],
    [() => completion({ ...silent, observations: false }), "schema"],
    [() => Response.json({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata }), "refusal"],
  ] as const)("rejects unusable model output, retaining the provider token usage", async (response, reason) => {
    const { analyze } = setup(response());
    await expect(analyze(video)).rejects.toMatchObject({ reason, usage: { inputTokens: 1000, outputTokens: 500 } });
  });

  it("reflects the scheduled 3.8 Flash list-price change", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-12-31T23:59:59Z"));
      expect(priceFor(DEFAULT_GEMINI_VIDEO_MODEL, "gemini")).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75, estimate: false });
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      expect(priceFor(DEFAULT_GEMINI_VIDEO_MODEL, "gemini")).toEqual({ inputPerMTok: 1.5, outputPerMTok: 7.5, estimate: false });
    } finally { vi.useRealTimers(); }
  });
});
