import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchBlockedError, fetchPublicResource } from "../../security/fetch";
import { loadFacebookCaption, loadFacebookVideo, parseFacebookPost } from "./facebook";

vi.mock("../../security/fetch", async original => ({
  ...await original<typeof import("../../security/fetch")>(), fetchPublicResource: vi.fn(),
}));
const get = vi.mocked(fetchPublicResource);
const post = "https://www.facebook.com/reel/123/";
const short = "https://fb.watch/AbCd/";
const cdn = "https://video.example.fbcdn.net/clip.mp4";
const image = "https://scontent.example.fbcdn.net/poster.jpg";
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
const page = `<meta property="og:url" content="${post}"><meta property="og:title" content="Tytuł | Autor | Facebook">
  <meta property="og:description" content="Opis wpisu"><meta property="og:image" content="${image}">`;

function resource(url: string, data: string | Buffer, mime = "text/html") {
  return { finalUrl: url, bytes: Buffer.from(data), status: 200, mime, contentType: mime };
}

beforeEach(() => get.mockReset());

describe("public Facebook video", () => {
  it.each([post, "https://m.facebook.com/watch/?v=123&t=20", "https://www.facebook.com/video.php?v=123",
    "https://www.facebook.com/artist/videos/123", "https://www.facebook.com/artist/videos/a-title/123"])("recognizes %s", raw => {
    expect(parseFacebookPost(raw)).toMatchObject({ platform: "facebook", id: "123" });
  });

  it.each([short, "https://fb.me/AbC", "https://www.facebook.com/share/r/AbC/", "https://facebook.com/share/v/AbC/",
    "https://www.facebook.com/share/p/AbC/", "https://www.facebook.com/share/AbC/"])("recognizes shared link %s", raw => {
    expect(parseFacebookPost(raw)?.platform).toBe("facebook");
    expect(parseFacebookPost(raw)?.id).toBeUndefined();
  });

  it.each(["https://facebook.com/watch", "https://facebook.com/watch?v=123&v=456", "https://facebook.com/artist/",
    "https://facebook.com.evil.test/reel/123", "https://facebook.com/login", "https://person@fb.watch/abc", "https://m.fb.me/page",
    "https://fb.me:123/"]
  )("keeps other pages out of the media loader %s", raw => expect(parseFacebookPost(raw)).toBeUndefined());

  it("resolves a short link and reads only same-post metadata in caption mode", async () => {
    get.mockResolvedValueOnce(resource(post, page));
    await expect(loadFacebookCaption(short)).resolves.toEqual({ url: post, caption: "Opis wpisu", author: "Autor", thumbnailUrl: image });
    expect(get).toHaveBeenCalledTimes(1);
    const policy = get.mock.calls[0]![1].allowUrl!;
    expect(policy(new URL(post))).toBe(true);
    expect(policy(new URL("https://www.facebook.com/login"))).toBe(false);
    expect(policy(new URL("https://m.facebook.com.evil.test/reel/123"))).toBe(false);
  });

  it("retains the watch ID and requires the exact post after every redirect", async () => {
    get.mockResolvedValueOnce(resource(post, page.replace(post, "https://www.facebook.com/reel/999/")));
    await expect(loadFacebookVideo("https://www.facebook.com/watch/?v=123&tracking=remove")).rejects.toMatchObject({ reason: "unavailable", caption: "" });
    const [address, opts] = get.mock.calls[0]!;
    expect(address).toBe("https://www.facebook.com/watch/?v=123");
    expect(opts.allowUrl!(new URL("https://www.facebook.com/watch/?v=999"))).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("downloads an MP4 from the official public embed and selects the requested video's SD stream", async () => {
    const response = { instances: [["x", ["VideoConfig"], [{ videoData: [
      { video_id: "999", sd_src: cdn.replace("clip", "wrong") },
      { video_id: "123", sd_src: cdn, hd_src: cdn.replace("clip", "hd") },
    ] }]]] };
    const embed = `<script>requireLazy(["ServerJS"],function(){s.handle(${JSON.stringify(response)});requireLazy([])});</script>`;
    const withPlayerLink = page + '<meta property="og:video" content="https://www.facebook.com/plugins/video.php?href=...">';
    get.mockResolvedValueOnce(resource(post, withPlayerLink)).mockResolvedValueOnce(resource(post, embed)).mockResolvedValueOnce(resource(cdn, mp4, "video/mp4"));
    await expect(loadFacebookVideo(short)).resolves.toMatchObject({ platform: "facebook", url: post, author: "Autor", caption: "Opis wpisu", bytes: mp4 });
    expect(get.mock.calls[1]![0]).toBe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(post)}&show_text=false`);
    const [videoUrl, opts] = get.mock.calls[2]!;
    expect(videoUrl).toBe(cdn);
    expect(opts.allowUrl!(new URL("https://cdn.fbcdn.net.evil.test/clip.mp4"))).toBe(false);
  });

  it("uses page-level MP4 without a second page request, preserving metadata on a size limit", async () => {
    const html = page + `<meta property="og:video:secure_url" content="${cdn}">`;
    get.mockResolvedValueOnce(resource(post, html)).mockRejectedValueOnce(new FetchBlockedError("too_large"));
    await expect(loadFacebookVideo(post)).rejects.toMatchObject({ reason: "too_large", caption: "Opis wpisu", author: "Autor", thumbnailUrl: image, url: post });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("never treats suggested videos or an HTML response as the clip", async () => {
    const html = page + '<script type="application/json">{"__typename":"Video","id":"321","browser_native_sd_url":"https://xx.fbcdn.net/other.mp4"}</script>';
    get.mockResolvedValueOnce(resource(post, html)).mockResolvedValueOnce(resource(post, "<html>Log in</html>"));
    await expect(loadFacebookVideo(post)).rejects.toMatchObject({ reason: "unavailable", caption: "Opis wpisu" });
    get.mockResolvedValueOnce(resource(post, page + `<meta property="og:video" content="${cdn}">`))
      .mockResolvedValueOnce(resource(cdn, "<html>login required</html>", "application/octet-stream"));
    await expect(loadFacebookVideo(post)).rejects.toMatchObject({ reason: "unavailable", caption: "Opis wpisu" });
    expect(get).toHaveBeenCalledTimes(4);
  });
});
