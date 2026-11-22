import { afterEach, expect, it, vi } from "vitest";
import { createVideoLoader } from "./platforms";
import { SocialVideoSourceError } from "./social-source";
import { recoverSocialVideo } from "./yt-dlp";

const { direct } = vi.hoisted(() => ({ direct: vi.fn() }));
vi.mock("./social-source", async original => ({
  ...await original<typeof import("./social-source")>(), createSocialVideoLoader: () => direct,
}));
vi.mock("./yt-dlp", () => ({ recoverSocialVideo: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const load = createVideoLoader(undefined, "openai");
const url = "https://www.instagram.com/reel/Polska1/";

it("recovers a missing file through the production loader using the resolved post", async () => {
  const error = new SocialVideoSourceError("unavailable", "Opis", { url });
  const video = { platform: "instagram" as const, caption: "Opis", url, mimeType: "video/mp4" as const, bytes: Buffer.from("movie") };
  direct.mockRejectedValue(error);
  vi.mocked(recoverSocialVideo).mockResolvedValue(video);
  await expect(load("https://www.instagram.com/share/reel/test/")).resolves.toBe(video);
  expect(recoverSocialVideo).toHaveBeenCalledWith(error, undefined);
});

it.each([
  new SocialVideoSourceError("unavailable", "", { url }, false, true),
  new SocialVideoSourceError("too_large"),
  new SocialVideoSourceError("unsupported"),
])("preserves explicit restrictions, size limits and unsupported posts", async error => {
  direct.mockRejectedValue(error);
  await expect(load(url)).rejects.toBe(error);
  expect(recoverSocialVideo).not.toHaveBeenCalled();
});
