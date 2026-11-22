import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicResource } from "../../security/fetch";
import { canonicalYouTubeUrl, loadYouTubePost, loadYouTubeVideo, parseYouTubeVideoId } from "./youtube";
import { createVideoLoader } from "./platforms";
import { MAX_VIDEO_BYTES } from "./social-source";

vi.mock("../../security/fetch", async importOriginal => ({ ...await importOriginal<typeof import("../../security/fetch")>(), fetchPublicResource: vi.fn() }));
const fetchMock = vi.mocked(fetchPublicResource);
const id = "jNQXAC9IVRw";
const watch = `https://www.youtube.com/watch?v=${id}`;
const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const captions = `https://www.youtube.com/api/timedtext?v=${id}&lang=en`;
const embed = { type: "video", title: "At the zoo", author_name: "jawed", thumbnail_url: thumb };
const mediaUrl = "https://rr1.example.googlevideo.com/videoplayback?id=opaque01";
const bytes = Buffer.from("0000ftypisom media");
const mp4 = { mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', url: mediaUrl, contentLength: String(bytes.length) };

function sources(html: string, oEmbed: unknown = embed) {
  fetchMock.mockImplementation(async (raw, options) => {
    const url = new URL(raw);
    expect(options.allowUrl?.(url)).toBe(true);
    expect(options.allowUrl?.(new URL("https://example.org/"))).toBe(false);
    let data: string;
    let mime: string;
    if (url.pathname === "/oembed") {
      if (!oEmbed) throw new Error("oEmbed unavailable");
      expect(url.searchParams.get("url")).toBe(watch);
      data = JSON.stringify(oEmbed);
      mime = "application/json";
    } else if (url.pathname === "/watch") {
      data = html;
      mime = "text/html";
    } else if (url.pathname === "/videoplayback") {
      expect(options.allowUrl?.(new URL(mediaUrl.replace("opaque01", "other")))).toBe(false);
      expect(options.maxBytes).toBe(MAX_VIDEO_BYTES);
      return { finalUrl: raw, status: 200, mime: "video/mp4", contentType: "video/mp4", bytes };
    } else {
      expect(url.searchParams.get("fmt")).toBe("vtt");
      expect(url.href.startsWith(captions)).toBe(true);
      data = "WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nElephants have long trunks.\n";
      mime = "text/vtt";
    }
    return { finalUrl: raw, status: 200, mime, contentType: mime, bytes: Buffer.from(data) };
  });
}

function player(overrides: Record<string, unknown> = {}, baseUrl = captions, playerFields: Record<string, unknown> = {}) {
  const data = {
    videoDetails: { videoId: id, title: "At the zoo", lengthSeconds: "19", shortDescription: "An elephant", ...overrides },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl }] } },
    ...playerFields,
  };
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify(data)};</script>`;
}

describe("YouTube public video sources", () => {
  beforeEach(() => { fetchMock.mockReset(); });
  it.each([watch, `https://m.youtube.com/shorts/${id}?si=share`, `https://youtu.be/${id}?t=3`, `https://www.youtube-nocookie.com/embed/${id}`])("canonicalizes %s", url => {
    expect(canonicalYouTubeUrl(url)).toBe(watch);
  });
  it.each(["https://www.youtube.com/@jawed", watch + "&v=another_ID0", "https://youtube.com/shorts/invalid", watch.replace("youtube.com", "youtube.com.example.org"), watch.replace("//www", "//a:b@www"), watch.replace("/watch", ":8000/watch")])("leaves non-video or unauthenticated-origin mismatch outside the video route: %s", url => {
    expect(parseYouTubeVideoId(url)).toBeUndefined();
  });
  it("loads oEmbed, the matching player's description/duration, and available public WebVTT", async () => {
    sources(player());
    await expect(loadYouTubePost(`https://youtube.com/shorts/${id}`)).resolves.toEqual({
      platform: "youtube", url: watch, youtubeUrl: watch, caption: "An elephant",
      title: embed.title, author: embed.author_name, thumbnailUrl: thumb, durationSeconds: 19,
      subtitles: [{ seconds: 2, text: "Elephants have long trunks." }],
    });
  });
  it("keeps metadata only if the watch page instead describes another video", async () => {
    sources(player({ videoId: "01234567890" }) + '<link rel="canonical" href="https://www.youtube.com/watch?v=01234567890"><meta itemprop="duration" content="PT10S">');
    const post = await loadYouTubePost(watch);
    expect(post.title).toBe(embed.title);
    expect(post.caption).toBe("");
    expect(post.durationSeconds).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("can read structured duration and description without player JSON or oEmbed", async () => {
    sources(`<link rel="canonical" href="${watch}"><meta itemprop="duration" content="PT1H2M3S"><meta itemprop="description" content="Opis filmu">`, null);
    await expect(loadYouTubePost(watch)).resolves.toMatchObject({ durationSeconds: 3723, caption: "Opis filmu" });
  });
  it.each([[{ isLive: true }, captions, undefined], [{ lengthSeconds: "601" }, captions, 601], [{}, captions.replace("www.youtube.com", "other.example"), 19], [{}, captions.replace(id, "01234567890"), 19]] as const)("avoids captions for live, oversized or mismatched targets", async (overrides, link, expectedSeconds) => {
    sources(player(overrides, link));
    const post = await loadYouTubePost(watch);
    expect(post.durationSeconds).toBe(expectedSeconds);
    expect(post.subtitles).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hands OpenAI the smallest direct multiplexed MP4, and keeps Gemini on its canonical URL", async () => {
    sources(player({}, captions, { playabilityStatus: { status: "OK" }, streamingData: {
      formats: [{ ...mp4, url: mediaUrl + "&large=1", contentLength: "5000000" }, mp4],
    } }));
    const input = `https://youtube.com/shorts/${id}`;
    const openai = await createVideoLoader(undefined, "openai")(input);
    expect(openai).toMatchObject({ platform: "youtube", url: watch, title: embed.title, bytes, mimeType: "video/mp4", durationSeconds: 19 });
    expect(openai).not.toHaveProperty("youtubeUrl");
    expect(fetchMock.mock.calls.map(([url]) => url).filter(url => url.startsWith(mediaUrl))).toEqual([mediaUrl]);
    await expect(createVideoLoader(undefined, "gemini")(input)).resolves.toMatchObject({ youtubeUrl: watch });
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith(mediaUrl))).toHaveLength(1);
  });

  it.each([
    { formats: [{ ...mp4, url: "https://untrusted.example/file.mp4" }] },
    { formats: [{ ...mp4, url: mediaUrl + "&range=0-100" }] },
    { formats: [{ ...mp4, mimeType: 'video/mp4; codecs="avc1.4D401E"' }] },
    { formats: [{ ...mp4, signatureCipher: "opaque" }] },
    { formats: [{ ...mp4, drmFamilies: ["WIDEVINE"] }] },
    { adaptiveFormats: [mp4] },
  ])("retains the public transcript when a direct audiovisual format is unavailable", async streamingData => {
    sources(player({}, captions, { playabilityStatus: { status: "OK" }, streamingData }));
    await expect(loadYouTubeVideo(watch)).rejects.toMatchObject({
      reason: "unavailable", url: watch, title: embed.title, caption: "An elephant", author: embed.author_name, thumbnailUrl: thumb,
      subtitles: [{ seconds: 2, text: "Elephants have long trunks." }],
    });
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("videoplayback"))).toHaveLength(0);
  });

  it.each([
    [{ videoId: "01234567890" }, "OK", mp4, "unavailable"], [{ isLive: true }, "OK", mp4, "unavailable"],
    [{ isPrivate: true }, "OK", mp4, "unavailable"], [{}, "LOGIN_REQUIRED", mp4, "unavailable"],
    [{ lengthSeconds: "601" }, "OK", mp4, "too_large"], [{}, "OK", { ...mp4, contentLength: String(MAX_VIDEO_BYTES + 1) }, "too_large"],
  ] as const)("checks the player identity, public status and limits before fetching the file", async (overrides, status, format, reason) => {
    sources(player(overrides, captions, { playabilityStatus: { status }, streamingData: { formats: [format] } }));
    await expect(loadYouTubeVideo(watch)).rejects.toMatchObject({ reason });
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("videoplayback"))).toHaveLength(0);
  });
});
