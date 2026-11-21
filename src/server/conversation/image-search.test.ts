import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeEnv } from "../testkit";
import { searchImage } from "./image-search";

const config = { reverseImageProvider: "google_vision" as const, googleVisionApiKey: "vision-test", factCheckApiKey: "review-test" };
let image: { base64: string; mime: string };

beforeAll(async () => {
  const bytes = await sharp({ create: { width: 1800, height: 100, channels: 3, background: "green" } }).withMetadata().png().toBuffer();
  image = { mime: "image/png", base64: bytes.toString("base64") };
});

describe("Google image search", () => {
  it("searches with a reduced metadata-free copy, returns public matches and requests fact-checks only for an exact image", async () => {
    const fullImage = "https://cdn.example.org/image.jpg";
    const vision = { responses: [{ webDetection: {
      webEntities: [{ description: "identity" }], visuallySimilarImages: [{ url: "https://similar.example.org/people" }],
      fullMatchingImages: [{ url: fullImage }], partialMatchingImages: [{ url: "javascript:ignored" }],
      pagesWithMatchingImages: [
        { pageTitle: "Archiwum", url: "https://www.nato.int/archiwum" },
        { pageTitle: "private title", url: "https://news.example.org/private-path" },
      ],
    } }] };
    const results = { results: [{ claim: { claimReview: [{ url: "https://demagog.org.pl/analizy/zdjecie", title: "Weryfikacja", publisher: { name: "Demagog" }, textualRating: "Fałsz" }] } }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(vision)).mockResolvedValueOnce(Response.json(results));
    const { ctx } = makeEnv({ cfg: config, fetch: fetcher });
    const result = await searchImage(image, ctx);
    expect(result).toMatchObject({
      status: "ok", factCheckStatus: "ok",
      matches: [
        { kind: "page", url: "https://www.nato.int/archiwum", title: "Archiwum" },
        { kind: "page", host: "news.example.org" }, { kind: "full", host: "cdn.example.org" },
      ],
      factChecks: [{ title: "Weryfikacja", rating: "Fałsz", publisher: "Demagog" }],
    });
    for (const text of ["identity", "similar.example", "private-path", "private title"]) expect(JSON.stringify(result)).not.toContain(text);
    const [visionUrl, upload] = fetcher.mock.calls[0]!;
    const [lookupUrl, lookup] = fetcher.mock.calls[1]!;
    expect(String(visionUrl)).toContain("https://vision.googleapis.com/v1/images:annotate?");
    expect(new Headers(upload?.headers).get("x-goog-api-key")).toBe(config.googleVisionApiKey);
    const body = JSON.parse(String(upload?.body)).requests[0];
    expect(body.features).toEqual([{ type: "WEB_DETECTION", maxResults: 20 }]);
    const meta = await sharp(Buffer.from(body.image.content, "base64")).metadata();
    expect(meta).toMatchObject({ width: 1600, format: "jpeg" });
    expect(meta.exif).toBeUndefined();
    const lookupAddress = new URL(String(lookupUrl));
    expect(lookupAddress.pathname).toBe("/v1alpha1/claims:imageSearch");
    expect(lookupAddress.searchParams.get("imageUri")).toBe(fullImage);
    expect(new Headers(lookup?.headers).get("x-goog-api-key")).toBe(config.factCheckApiKey);
    expect(lookup?.body).toBeUndefined();
  });

  it("reports an empty index result separately from a service failure; partial matches never trigger Fact Check Tools", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ responses: [{}] }))
      .mockResolvedValueOnce(Response.json({ responses: [{ webDetection: { partialMatchingImages: [{ url: "https://images.example.org/a" }] } }] }))
      .mockResolvedValueOnce(Response.json({ responses: [{ error: { code: 7 } }] }));
    const { ctx } = makeEnv({ cfg: config, fetch: fetcher });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "ok", matches: [], factCheckStatus: "not_applicable" });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "ok", matches: [{ kind: "partial" }], factCheckStatus: "not_applicable" });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("enforces the daily reservation even when multiple images are submitted concurrently", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ responses: [{ webDetection: {} }] }));
    const { ctx } = makeEnv({ cfg: { ...config, reverseImageDailyCap: 1 }, fetch: fetcher });
    const results = await Promise.all([searchImage(image, ctx), searchImage(image, ctx)]);
    expect(results.map(r => r.status).sort()).toEqual(["ok", "unavailable"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains web matches when the fact-check service is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ responses: [{ webDetection: { fullMatchingImages: [{ url: "https://images.example.org/a" }] } }] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const { ctx } = makeEnv({ cfg: config, fetch: fetcher });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "ok", matches: [{ kind: "full" }], factCheckStatus: "unavailable" });
  });

  it("skips disabled providers and invalid images without paying for a Google request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { ctx } = makeEnv({ cfg: { ...config, reverseImageProvider: "off" }, fetch: fetcher });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "disabled" });
    ctx.cfg.reverseImageProvider = "google_vision";
    expect(await searchImage({ ...image, base64: "aW52YWxpZA==" }, ctx)).toMatchObject({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM image_search_usage").get()).toEqual({ n: 0 });
  });

  it("charges a short retry to the cap and pauses after another Google rate limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429, headers: { "Retry-After": "0" } }));
    const { ctx } = makeEnv({ cfg: config, fetch: fetcher });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "unavailable" });
    expect(await searchImage(image, ctx)).toMatchObject({ status: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ctx.db.prepare("SELECT requests FROM image_search_usage").get()).toEqual({ requests: 2 });
  });
});
