import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchBlockedError, fetchPublicResource } from "../../security/fetch";
import { createSocialVideoLoader, loadSocialCaption, loadSocialVideo, MAX_VIDEO_SECONDS, socialVideoPlatform } from "./social-source";

vi.mock("../../security/fetch", async (original) => ({
  ...await original<typeof import("../../security/fetch")>(), fetchPublicResource: vi.fn(),
}));
const requests = vi.mocked(fetchPublicResource);
const get = vi.fn<typeof fetchPublicResource>();
const getEmbed = vi.fn<typeof fetchPublicResource>();
const tk = "https://www.tiktok.com/@polska/video/123456789";
const ig = "https://www.instagram.com/reel/Polska1/";
const clip = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
const cdn = "https://v16.tiktokcdn.com/video.mp4";
const bucket = "https://socialkit-downloads.s3.amazonaws.com/file.mp4";

function resource(url: string, data: Buffer | string, mime = "text/html") {
  return { finalUrl: url, status: 200, contentType: mime, mime, bytes: Buffer.from(data) };
}

function tikTokHtml(id = "123456789", playAddr = cdn, duration = 12, video = {}, item = {}) {
  const itemStruct = { id, desc: "Tekst autora", video: { duration, playAddr, ...video }, ...item };
  const scope = { "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct } } };
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: scope })}</script>`;
}

function instagramHtml(blocked: boolean, mediaUrl?: string) {
  const item = { shortcode: "Polska1", is_video: true, video_url: mediaUrl, video_duration: 10, edge_media_to_caption: { edges: [{ node: { text: "Opis rolki" } }] } };
  const payload = { context: { shortcode: "Polska1", copyright_blocked: blocked }, gql_data: { shortcode_media: item } };
  return `<script>init("PolarisEmbedSimple",${JSON.stringify({ contextJSON: JSON.stringify(payload) })})</script>`;
}

beforeEach(() => {
  get.mockReset();
  getEmbed.mockReset().mockResolvedValue(resource(tk, "{}", "application/json"));
  requests.mockReset().mockImplementation((url, opts) =>
    new URL(url).pathname === "/oembed" ? getEmbed(url, opts) : get(url, opts));
});

describe("social-video post links", () => {
  it.each([
    [tk, "tiktok"], ["https://vm.tiktok.com/ZabC/", "tiktok"], ["https://www.tiktok.com/t/ZXc/", "tiktok"],
    [ig + "?igsh=share", "instagram"], ["https://instagram.com/share/reel/abc123/", "instagram"],
    ["https://instagram.com/artist/reel/Polska1/", "instagram"], ["https://instagr.am/p/code/", "instagram"],
  ])("classifies %s", (url, platform) => expect(socialVideoPlatform(url)).toBe(platform));

  it.each(["https://www.instagram.com/artist/", "https://www.tiktok.com/@polska", "https://example.com/reel/abc/",
    "https://instagram.com.example.org/p/abc/", "https://user@instagram.com/p/abc/", "https://instagram.com:444/p/abc/"])(
    "leaves other URLs out of the video loader (%s)", url => expect(socialVideoPlatform(url)).toBeUndefined(),
  );

  it("resolves a shared link, binds the media to the destination post, and strips tracking parameters", async () => {
    get.mockResolvedValueOnce(resource(tk + "?tracking=abc", tikTokHtml())).mockResolvedValueOnce(resource(cdn, clip, "video/mp4"));
    const video = await loadSocialVideo("https://vm.tiktok.com/ZabC/");
    expect(video).toMatchObject({ platform: "tiktok", caption: "Tekst autora", url: tk, bytes: clip, durationSeconds: 12 });
    expect(requests.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/ZabC/", "/oembed", "/video.mp4"]);
    const policy = get.mock.calls[1]![1].allowUrl!;
    expect(policy(new URL("https://v1.tiktokcdn.com/m.mp4"))).toBe(true);
    expect(policy(new URL("https://v1.tiktokcdn.com.other.test/m.mp4"))).toBe(false);
  });

  it("requires the submitted post ID and platform storage, including on redirects", async () => {
    get.mockResolvedValueOnce(resource(tk, tikTokHtml("555"))).mockResolvedValueOnce(resource(tk, tikTokHtml("123456789", "https://example.org/other.mp4")));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "unavailable", caption: "" });
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "unavailable", caption: "Tekst autora" });
    expect(get).toHaveBeenCalledTimes(2);
    const policy = get.mock.calls[0]![1].allowUrl!;
    expect(policy(new URL("https://www.tiktok.com/@a/video/7"))).toBe(false);
    expect(policy(new URL("https://instagram.com/p/test/"))).toBe(false);
  });

  it("reads just the public captions without contacting a CDN or SocialKit", async () => {
    get.mockResolvedValueOnce(resource(tk, tikTokHtml()))
      .mockResolvedValueOnce(resource(ig, instagramHtml(false, "https://scontent.cdninstagram.com/clip")));
    await expect(loadSocialCaption(tk)).resolves.toEqual({ url: tk, caption: "Tekst autora" });
    await expect(loadSocialCaption(ig)).resolves.toEqual({ url: ig, caption: "Opis rolki" });
    expect(get.mock.calls.map(([raw]) => new URL(raw).hostname)).toEqual(["www.tiktok.com", "www.instagram.com"]);
    expect(get.mock.calls.every(([, opts]) => !opts.postJson)).toBe(true);
  });

  it("accepts an oEmbed description only for the requested post", async () => {
    const fallback = (id: string) => resource(tk, JSON.stringify({ type: "video", embed_product_id: id, title: "Opis oEmbed" }), "application/json");
    getEmbed.mockResolvedValueOnce(fallback("123456789"));
    get.mockResolvedValueOnce(resource(tk, ""));
    await expect(loadSocialCaption(tk)).resolves.toMatchObject({ caption: "Opis oEmbed" });
    getEmbed.mockResolvedValueOnce(fallback("987654321"));
    get.mockResolvedValueOnce(resource(tk, ""));
    await expect(loadSocialCaption(tk)).resolves.toMatchObject({ caption: "" });
    expect(requests.mock.calls[0]![0]).toBe(`https://www.tiktok.com/oembed?url=${encodeURIComponent(tk)}`);
  });

  it("returns complete oEmbed metadata without fetching the post, or retains it if the HTML is inaccessible", async () => {
    const thumbnailUrl = "https://p16.tiktokcdn-eu.com/poster.jpg";
    const embed = { type: "video", embed_product_id: "123456789", title: "Opis", author_name: "Autor", thumbnail_url: thumbnailUrl };
    getEmbed.mockResolvedValue(resource(tk, JSON.stringify(embed), "application/json"));
    await expect(loadSocialCaption(tk)).resolves.toEqual({ url: tk, caption: "Opis", author: "Autor", thumbnailUrl });
    expect(get).not.toHaveBeenCalled();
    get.mockRejectedValueOnce(new FetchBlockedError("http_error", "403", 403));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ url: tk, reason: "unavailable", caption: "Opis", author: "Autor", thumbnailUrl });
  });

  it("gets original public captions, then requests the smallest advertised video", async () => {
    const sub = "https://v16.tiktokcdn.com/pl.vtt";
    const small = "https://v16.tiktokcdn.com/480.mp4";
    const large = "https://v16.tiktokcdn.com/720.mp4";
    const video = { cover: "https://p16.tiktokcdn-eu.com/img.jpg", bitrateInfo: [
      { PlayAddr: { DataSize: "84000", UrlList: [large] } }, { PlayAddr: { DataSize: "64000", UrlList: [small] } },
    ], subtitleInfos: [{ Url: "https://attacker.test/sub.vtt" }, { Url: cdn + ".srt", Format: "srt" },
      { Url: sub, Format: "webvtt", IsOriginalCaption: true }] };
    const item = { author: { uniqueId: "Autor" } };
    const vtt = "\uFEFFWEBVTT\r\n\r\ncue-1\r\n00:01.200 --> 00:00:04.000 align:start\r\n<b>Woda</b> &amp; lód.";
    const subtitles = [{ seconds: 1.2, text: "Woda & lód." }];
    const page = resource(tk, tikTokHtml("123456789", cdn, 12, video, item));
    get.mockResolvedValueOnce(page).mockResolvedValueOnce(resource(sub, vtt, "text/vtt")).mockResolvedValueOnce(resource(small, clip, "video/mp4"));
    await expect(loadSocialVideo(tk)).resolves.toMatchObject({ bytes: clip, subtitles, author: "Autor", thumbnailUrl: video.cover });
    expect(get.mock.calls.map(([url]) => url)).toEqual([tk, sub, small]);
    expect(get.mock.calls[1]![1].allowUrl!(new URL("https://example.org/captions.vtt"))).toBe(false);
    get.mockClear().mockResolvedValueOnce(page).mockResolvedValueOnce(resource(sub, vtt, "text/vtt"));
    await expect(loadSocialCaption(tk, undefined, true)).resolves.toMatchObject({ subtitles });
    expect(get.mock.calls.map(([url]) => url)).toEqual([tk, sub]);
    get.mockResolvedValueOnce(page).mockResolvedValueOnce(resource(sub, vtt, "text/vtt"))
      .mockRejectedValue(new FetchBlockedError("http_error", "403", 403));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "unavailable", subtitles, url: tk });
  });

  it("respects a restricted post even when the JSON contains video and caption URLs", async () => {
    const page = tikTokHtml("123456789", cdn, 8, { subtitleInfos: { tracks: [{ Url: cdn + ".vtt" }] } }, { privateItem: true })
      + `<meta property="og:url" content="${tk}"><meta property="og:video" content="${cdn}">`;
    get.mockResolvedValueOnce(resource(tk, page));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "unavailable", caption: "" });
    expect(requests.mock.calls.map(([url]) => url)).toEqual([`https://www.tiktok.com/oembed?url=${encodeURIComponent(tk)}`, tk]);
  });

  it("preserves a caption if the video is unavailable, too long, or served as HTML", async () => {
    get.mockResolvedValueOnce(resource(tk, tikTokHtml())).mockResolvedValueOnce(resource(cdn, "<html>Unavailable</html>", "video/mp4"));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "unavailable", caption: "Tekst autora" });
    get.mockResolvedValueOnce(resource(tk, tikTokHtml("123456789", cdn, MAX_VIDEO_SECONDS + 1)));
    await expect(loadSocialVideo(tk)).rejects.toMatchObject({ reason: "too_large", caption: "Tekst autora" });
  });

  it("downloads a legacy TikTok item with a string author and unknown subtitle format", async () => {
    const id = "123456789";
    const legacy = { ItemModule: { [id]: { id, author: "Autor", video: { playAddr: cdn, subtitleInfos: {} } } } };
    get.mockResolvedValueOnce(resource(tk, `<script id="SIGI_STATE">${JSON.stringify(legacy)}</script>`))
      .mockResolvedValueOnce(resource(cdn, clip, "video/mp4"));
    await expect(loadSocialVideo(tk)).resolves.toMatchObject({ author: "Autor", bytes: clip });
  });

  it("downloads a matching Instagram variant when the first version exceeds the limit", async () => {
    const media = "https://a.fbcdn.net/public.mp4";
    const records = [{ code: "Other", video_url: media + "?other" }, { code: "Polska1", media_type: 2,
      video_versions: [{ url: media + "?large" }, { url: media }] }];
    const page = `<link rel="canonical" href="${ig}"><script type="application/json">${JSON.stringify(records)}</script>`;
    get.mockResolvedValueOnce(resource(ig, "")).mockResolvedValueOnce(resource(ig, page))
      .mockRejectedValueOnce(new FetchBlockedError("too_large", "size")).mockResolvedValueOnce(resource(media, clip, "video/mp4"));
    await expect(loadSocialVideo(ig)).resolves.toMatchObject({ bytes: clip });
    expect(get.mock.calls.slice(2).map(([url]) => url)).toEqual([media + "?large", media]);
  });

  it("reads only the matching captioned Instagram embed, respecting its explicit block", async () => {
    const media = "https://scontent.cdninstagram.com/clip";
    get.mockResolvedValueOnce(resource(ig, instagramHtml(false, media))).mockResolvedValueOnce(resource(media, clip, "application/octet-stream"));
    await expect(loadSocialVideo(ig)).resolves.toMatchObject({ caption: "Opis rolki", bytes: clip });
    get.mockResolvedValueOnce(resource(ig, instagramHtml(true, media)));
    await expect(loadSocialVideo(ig)).rejects.toMatchObject({ reason: "unavailable", caption: "Opis rolki" });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("uses the public Instagram post when the embed is unavailable and keeps any caption if fetching fails", async () => {
    const media = "https://a.fbcdn.net/public.mp4";
    const page = `<meta property="og:url" content="${ig}"><meta property="og:description" content="Opis"><meta property="og:video" content="${media}">`;
    get.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(resource(ig, page)).mockResolvedValueOnce(resource(media, clip, "video/mp4"));
    await expect(loadSocialVideo(ig)).resolves.toMatchObject({ caption: "Opis", bytes: clip });
    get.mockResolvedValueOnce(resource(ig, instagramHtml(false))).mockRejectedValueOnce(new Error("network"));
    await expect(loadSocialVideo(ig)).rejects.toMatchObject({ reason: "unavailable", caption: "Opis rolki" });
    get.mockRejectedValueOnce(new FetchBlockedError("http_error", "403", 403));
    await expect(loadSocialVideo(ig)).rejects.toMatchObject({ reason: "unavailable" });
    expect(get).toHaveBeenCalledTimes(6);
  });
});

describe("configured SocialKit downloader", () => {
  const load = createSocialVideoLoader("fake-test-key");
  const endpoint = "https://api.socialkit.dev/tiktok/download";
  const data = { url: tk, title: "Opis z posta", format: "mp4", durationSeconds: 4, fileSize: clip.length, downloadUrl: bucket };
  const reply = (fields = {}) => resource(endpoint, JSON.stringify({ success: true, data: { ...data, ...fields } }), "application/json");
  const publicPage = resource(tk, tikTokHtml("123456789", "", 12, {}, { desc: "" }));

  it("uses direct playback before a configured downloader and skips the provider for restricted or oversized posts", async () => {
    get.mockResolvedValueOnce(resource(tk, tikTokHtml())).mockResolvedValueOnce(resource(cdn, clip, "video/mp4"));
    await expect(load(tk)).resolves.toMatchObject({ bytes: clip, caption: "Tekst autora" });
    get.mockResolvedValueOnce(resource(tk, tikTokHtml("123456789", cdn, 8, {}, { privateItem: true })));
    await expect(load(tk)).rejects.toMatchObject({ reason: "unavailable" });
    get.mockResolvedValueOnce(resource(tk, tikTokHtml("123456789", cdn, MAX_VIDEO_SECONDS + 1)));
    await expect(load(tk)).rejects.toMatchObject({ reason: "too_large" });
    get.mockRejectedValueOnce(new FetchBlockedError("http_error", "403", 403));
    await expect(load(tk)).rejects.toMatchObject({ reason: "unavailable" });
    expect(get.mock.calls.map(([url]) => url)).not.toContain(endpoint);
  });

  it("keeps the official URL, available captions and author whether the provider succeeds or fails", async () => {
    const sub = "https://v16.tiktokcdn.com/test.vtt";
    const page = resource(tk, tikTokHtml("123456789", "", 10, {
      claInfo: { captionInfos: [{ isOriginalCaption: true, captionFormat: "webvtt", urlList: [sub] }] },
    }, { author: { uniqueId: "Autor" } }));
    const vtt = resource(sub, "WEBVTT\n\n00:00.000 --> 00:04.000\nTeza.", "text/vtt");
    const expected = { url: tk, caption: "Tekst autora", author: "Autor", subtitles: [{ seconds: 0, text: "Teza." }] };
    get.mockResolvedValueOnce(page).mockResolvedValueOnce(vtt).mockResolvedValueOnce(reply()).mockResolvedValueOnce(resource(bucket, clip, "video/mp4"));
    await expect(load("https://vm.tiktok.com/ZabC/")).resolves.toMatchObject(expected);
    expect(get.mock.calls[2]![1].postJson?.body).toMatchObject({ url: tk });
    get.mockResolvedValueOnce(page).mockResolvedValueOnce(vtt).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(load(tk)).rejects.toMatchObject({ ...expected, reason: "unavailable" });
  });

  it("sends only the normalized TikTok URL and keeps credentials out of S3 requests", async () => {
    get.mockResolvedValueOnce(publicPage).mockResolvedValueOnce(reply()).mockResolvedValueOnce(resource(bucket, clip, "video/mp4"));
    await expect(load(tk + "?share=abc")).resolves.toMatchObject({ bytes: clip, caption: "Opis z posta", durationSeconds: 4, url: tk });
    const [, api, storage] = get.mock.calls;
    expect(api![0]).toBe(endpoint);
    expect(api![1].postJson).toEqual({ body: { url: tk, format: "mp4", quality: "480p" }, headers: { "x-access-key": "fake-test-key" } });
    expect(api![1].allowUrl!(new URL("https://elsewhere.test"))).toBe(false);
    expect(storage![1].postJson).toBeUndefined();
    expect(storage![1].allowUrl!(new URL(bucket))).toBe(true);
    expect(storage![1].allowUrl!(new URL("https://other.s3.amazonaws.com/file"))).toBe(false);
    expect(storage![1].allowUrl!(new URL("https://socialkit-downloads.s3.eu-west-1.amazonaws.com/file"))).toBe(true);
  });

  it("checks post identity, media length and metadata limits", async () => {
    get.mockResolvedValueOnce(publicPage).mockResolvedValueOnce(reply({ url: tk.replace("123456789", "234567890") }));
    await expect(load(tk)).rejects.toMatchObject({ reason: "unavailable" });
    get.mockResolvedValueOnce(publicPage).mockResolvedValueOnce(reply({ durationSeconds: MAX_VIDEO_SECONDS + 2 }));
    await expect(load(tk)).rejects.toMatchObject({ reason: "too_large", caption: "Opis z posta" });
    get.mockResolvedValueOnce(publicPage).mockResolvedValueOnce(reply({ fileSize: clip.length + 1 })).mockResolvedValueOnce(resource(bucket, clip, "video/mp4"));
    await expect(load(tk)).rejects.toMatchObject({ reason: "unavailable", caption: "Opis z posta" });
  });
});
