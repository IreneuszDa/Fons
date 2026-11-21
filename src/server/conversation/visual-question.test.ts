import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "../../engine/testing/stubs";
import { FakeLlmProvider } from "../../engine/llm/fake";
import type { FetchedPage } from "../../security/fetch";
import type { ImageSearchResult } from "../../shared/image-search";
import { makeEnv } from "../testkit";
import { readMatchedCaptions } from "./image-captions";
import { answerVisualQuestion } from "./visual-question";

const publication = "https://www.prezydent.pl/fotografie/spotkanie";
const citation = { url: publication, title: "Spotkanie", quote: "Prezydent RP podczas konferencji." };
const picture = { mime: "image/jpeg", base64: "cleanPixels" };
const google: ImageSearchResult = {
  status: "ok", messagePl: "ok", matches: [], factCheckStatus: "not_applicable", factChecks: [],
};

function environment(provider = new FakeLlmProvider(), html = "", finalUrl = publication) {
  const { ctx } = makeEnv();
  const fetcher = vi.fn(async (): Promise<FetchedPage> => ({
    finalUrl, title: citation.title, rawHtml: html, rawText: "", cleanText: "", hiddenSegments: [], status: 200, contentType: "text/html",
  }));
  ctx.engineDeps = {
    llm: provider, verifier: provider, singleKey: true, store: memoryStore([]), db: ctx.db,
    branches: [], fetchPage: fetcher, now: ctx.now, verdictMode: "rules",
  };
  return { ctx, fetcher };
}

describe("captions of the actual matching photograph", () => {
  const pages = [{ url: publication, fullMatchingImages: [{ url: "https://www.prezydent.pl/media/exact.jpg" }] }];
  it("binds a full match to its caption by resource URL and ignores the article title, unrelated figures, and alt text from other OG images", async () => {
    const { ctx } = environment(undefined, `<html><head>
      <meta property="og:image" content="/media/other.jpg"><meta property="og:image:alt" content="Inny polityk">
      </head><body><h1>Wizyta premiera</h1>
      <figure><picture><source srcset="/media/exact.jpg 700w"><img src="tiny.jpg"></picture><figcaption>${citation.quote}</figcaption></figure>
      <figure><img src="/media/other.jpg" alt="Inny polityk"><figcaption>Prezydent innego kraju</figcaption></figure>
      </body></html>`);
    expect(await readMatchedCaptions(ctx, pages, [])).toEqual([citation]);
  });

  it("does not read pages for merely similar images or accept an unlisted publication after redirect", async () => {
    const { ctx, fetcher } = environment(undefined, '<img src="/media/exact.jpg" alt="Prezydent">', "https://example.org/page");
    expect(await readMatchedCaptions(ctx, [{ url: publication }, { ...pages[0], url: "https://example.org/news" }], [])).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readMatchedCaptions(ctx, pages, [])).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("ignores a caption shared across multiple different photographs", async () => {
    const { ctx } = environment(undefined, '<figure><img src="/media/exact.jpg"><img src="other.jpg"><figcaption>Wiele osób</figcaption></figure>');
    expect(await readMatchedCaptions(ctx, pages, [])).toEqual([]);
  });

  const heading = "Jan Testowy – Prezydent Rzeczypospolitej Polskiej";
  const portrait = '<img src="/media/exact.jpg" alt="20250722-PKN-14055.jpg [364.44 KB]">';
  const biography = (body: string) => `<html><body><h1>${heading}</h1><main class="articles-single__description">
    ${body}<p>Urząd ten objął 6 sierpnia 2025 roku.</p></main></body></html>`;

  it.each(["/prezydent/biografia", "/prezydent"])("uses the unique exact portrait in the dedicated official biography at %s", async path => {
    const url = `https://www.prezydent.pl${path}`;
    const { ctx } = environment(undefined, biography(portrait), url);
    expect(await readMatchedCaptions(ctx, [{ ...pages[0], url }], [])).toEqual([{ url, title: heading, quote: heading, kind: "official_profile" }]);
  });

  it("does not attribute a generic page, ambiguous gallery, or outside-the-biography photo to the president", async () => {
    const bioUrl = "https://www.prezydent.pl/prezydent/biografia";
    for (const [url, html] of [
      [publication, biography(portrait)],
      [bioUrl, biography(portrait + '<img src="someone-else.jpg">')],
      [bioUrl, biography('<img src="someone-else.jpg">').replace("<main", portrait + "<main")],
      [bioUrl, biography(portrait).replace(heading, "Archiwum ceremonii")],
    ] as const) {
      const { ctx } = environment(undefined, html, url);
      expect(await readMatchedCaptions(ctx, [{ ...pages[0], url }], [])).toEqual([]);
    }
  });
});

describe("answers about the picture", () => {
  it("uses the actual pixels for an observation, keeps usage and masks contact data", async () => {
    const model = new FakeLlmProvider({ supportsVision: true, override: () => ({ answerPl: "Czerwony. mail@example.org", citationIndex: -1 }) });
    const { ctx } = environment(model);
    const result = await answerVisualQuestion(ctx, "Jaki kolor ma prostokąt?", [picture], [], "visual");
    expect(model.calls).toMatchObject([{ images: 1, purpose: "image_question" }]);
    expect(result).toMatchObject({ textPl: "Czerwony. [EMAIL]", citations: [], unavailable: false, models: [{ purpose: "image_question" }] });
  });

  it("answers a person question using a verified caption and reports the exact published text", async () => {
    const model = new FakeLlmProvider({ override: () => ({ relation: "confirms", captionIndex: 0 }) });
    const { ctx } = environment(model);
    const result = await answerVisualQuestion(ctx, "Czy to jest prezydent Polski?", [picture], [{ ...google, captions: [citation] }], "identity");
    expect(model.calls).toMatchObject([{ images: 0, purpose: "image_caption" }]);
    expect(result.textPl).toMatch(/^Tak\./);
    expect(result.textPl).toContain(citation.quote);
    expect(result.citations).toEqual([citation]);
  });

  it("attributes an exact official profile portrait to the biography and preserves this evidence even without a model", async () => {
    const model = new FakeLlmProvider({ override: () => ({ relation: "confirms", captionIndex: 0 }) });
    const { ctx } = environment(model);
    const profile = { kind: "official_profile" as const, url: "https://www.prezydent.pl/prezydent/biografia", title: "Biografia",
      quote: "Jan Testowy – Prezydent Rzeczypospolitej Polskiej" };
    const run = () => answerVisualQuestion(ctx, "Czy to jest prezydent Polski?", [picture], [{ ...google, captions: [profile] }], "identity");
    const answered = await run();
    expect(answered.textPl).toContain("Tak, to Jan Testowy. To samo zdjęcie jest w oficjalnym biogramie");
    expect(answered.citations).toEqual([profile]);
    delete ctx.engineDeps;
    expect((await run()).textPl).toContain("Kancelarii Prezydenta");
  });

  it("does not treat a page title or invalid caption selection as identification", async () => {
    const model = new FakeLlmProvider({ supportsVision: true, override: req => req.purpose === "image_caption"
      ? { relation: "confirms", captionIndex: 5 } : { subject: "person", printedLabel: "" } });
    const { ctx } = environment(model);
    const source = { ...google, matches: [{ kind: "page" as const, host: "www.prezydent.pl", url: publication, title: "Prezydent RP" }] };
    for (const search of [source, { ...source, captions: [citation] }]) {
      const result = await answerVisualQuestion(ctx, "Czy to jest prezydent Polski?", [picture], [search], "identity");
      expect(result.textPl).toContain("tożsamoś");
      expect(result.textPl).not.toMatch(/^Tak\./);
      expect(result.citations).toEqual([]);
    }
  });

  it("distinguishes an inscription on the picture from a source and handles missing providers", async () => {
    const model = new FakeLlmProvider({ supportsVision: true, override: () => ({ subject: "person", printedLabel: "Prezydent RP" }) });
    const { ctx } = environment(model);
    const result = await answerVisualQuestion(ctx, "Kto to?", [picture], [google], "identity");
    expect(result.textPl).toContain("Na obrazie widnieje podpis „Prezydent RP”");
    expect(result.citations).toEqual([]);
    delete ctx.engineDeps;
    expect(await answerVisualQuestion(ctx, "Co widać?", [picture], [], "visual")).toMatchObject({ unavailable: true, citations: [], models: [] });
  });
});
