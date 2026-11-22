import { describe, expect, it, vi } from "vitest";
import { asksAboutDemagogReview, demagogReviewPages, googleIndexMessage } from "./google-claimreview";

const target = "https://demagog.org.pl/wypowiedzi/darmowa-komunikacja-dla-65-latkow-tylko-we-wroclawiu-sprawdzamy/";
const claim = (url: string, textualRating = "Fałsz") => ({
  text: "Wrocław jest jedynym miastem z bezpłatnymi przejazdami dla 65-latków.",
  claimReview: [{ url, title: "Darmowa komunikacja dla 65-latków", textualRating }],
});

describe("indeks Google dla pytania o weryfikację Demagoga", () => {
  it("rozpoznaje pytanie o sprawdzenie, odróżnia je od pytania o samo zdarzenie", () => {
    expect(asksAboutDemagogReview("Czy Demagog sprawdzał, czy Wrocław był jedynym miastem?")).toBe(true);
    expect(asksAboutDemagogReview("Czy Wrocław był jedynym miastem?")).toBe(false);
    expect(asksAboutDemagogReview("Dlaczego w analizie Demagoga jest 650 mln zł?")).toBe(false);
  });
  it("stronicuje wyniki, ogranicza wydawcę i wysyła klucz jedynie w nagłówku", async () => {
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ claims: [claim("https://demagog.org.pl/inny/")], nextPageToken: "page2" }))
      .mockResolvedValueOnce(Response.json({ claims: [claim(target, "Częściowa prawda"), claim("https://example.org/jakis-artykul")] }));
    const results = [];
    for await (const page of demagogReviewPages("secret", mock, "transport")) results.push(page);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ status: "page", reviews: [{ url: target, rating: "Częściowa prawda" }] });
    const [url, opts] = mock.mock.calls[1]!;
    const endpoint = new URL(String(url));
    expect(endpoint.searchParams.get("pageToken")).toBe("page2");
    expect(endpoint.searchParams.get("reviewPublisherSiteFilter")).toBe("demagog.org.pl");
    expect(endpoint.searchParams.get("query")).toBe("transport");
    expect(endpoint.searchParams.has("maxAgeDays")).toBe(false);
    expect(endpoint.href).not.toContain("secret");
    expect(opts?.headers).toMatchObject({ "X-Goog-Api-Key": "secret" });
  });
  it("zachowuje odrębne statusy błędów, nie myląc pustej strony z awarią", async () => {
    const mock = vi.fn<typeof fetch>();
    const lookup = async (key?: string) => {
      const pages = [];
      for await (const page of demagogReviewPages(key, mock, "transport")) pages.push(page);
      return pages;
    };
    expect(await lookup()).toEqual([{ status: "unavailable", reason: "no_key" }]);
    expect(mock).not.toHaveBeenCalled();
    for (const [status, reason] of [[403, "access"], [429, "quota"], [500, "provider"]] as const) {
      mock.mockResolvedValueOnce(new Response(null, { status }));
      expect(await lookup("key")).toEqual([{ status: "unavailable", reason }]);
    }
    mock.mockResolvedValueOnce(Response.json({ error: { details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 }));
    expect(await lookup("key")).toEqual([{ status: "unavailable", reason: "access" }]);
    for (const invalid of [null, { error: { code: 403 } }, { claims: "bad" }]) {
      mock.mockResolvedValueOnce(Response.json(invalid));
      expect(await lookup("key")).toEqual([{ status: "unavailable", reason: "provider" }]);
    }
    mock.mockResolvedValueOnce(Response.json({}));
    expect(await lookup("key")).toEqual([{ status: "page", reviews: [] }]);
    expect(googleIndexMessage({ status: "unavailable", reason: "access" })).toBe("Nie mogę teraz sprawdzić indeksu Google z powodu błędu dostępu.");
    mock.mockImplementation(async () => Response.json({ nextPageToken: "repeat" }));
    expect((await lookup("key")).at(-1)).toEqual({ status: "unavailable", reason: "incomplete" });
  });
});
