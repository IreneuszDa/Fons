import { describe, expect, it, vi } from "vitest";
import { createDemagogTopicIndex } from "./demagog-topic";
import type { LlmProvider } from "../../shared/contracts";

const today = new Date("2026-11-22");
const url = "https://demagog.org.pl/fake_news/euro-w-polsce-jeszcze-w-tym-roku-nie-ma-takiej-decyzji/";
const text = "W 2026 roku w Polsce ma zostać wprowadzone euro.";
const title = "Euro w Polsce jeszcze w tym roku? Nie ma takiej decyzji";
const response = () => Response.json({ claims: [{ text, claimReview: [{ title, url, textualRating: "Fałsz", reviewDate: "2026-10-20" }] }] });

describe("sprawdzenie publikacji bez wpisu przygotowanego dla scenariusza", () => {
  it("dopasowuje pełną tezę spoza przykładów i odsyła do oryginalnej recenzji", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response());
    const r = await createDemagogTopicIndex("key", fetchMock)("Czy Demagog sprawdzał, czy w 2026 roku w Polsce ma zostać wprowadzone euro?", today);
    expect(r).toMatchObject({ status: "hit", publication: { verdict: "FALSZYWE", claimPl: text,
      evidence: [{ url, publishedAt: "2026-10-20", quote: text, ratingRaw: "Fałsz" }] } });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("query")).toBe("Polsce 2026");
  });
  it("przy dokładnym tytule przypisuje ocenę do tezy wydawcy, bez werdyktu o tytule", async () => {
    const r = await createDemagogTopicIndex("key", async () => response())("Czy Demagog sprawdzał: " + title + "?", today);
    expect(r.status).toBe("hit");
    if (r.status !== "hit") throw new Error("expected hit");
    expect(r.publication.verdict).toBeUndefined();
    expect(r.publication.answerPl).toContain(text);
  });
  it("negacja lub inny rok może dać podobną publikację, ale nie jej ocenę względem pytania", async () => {
    const index = createDemagogTopicIndex("key", async () => response());
    for (const question of [text.replace("2026", "2030"), text.replace("ma zostać", "nie ma zostać")]) {
      const r = await index("Czy Demagog sprawdzał, czy " + question, today);
      expect(r.status).toBe("related");
      if (r.status !== "related") throw new Error("expected related");
      expect(r.publication.verdict).toBeUndefined();
      expect(r.publication.answerPl).toContain("Czy chodzi Ci o tę tezę?");
    }
  });
  it("akceptuje popartą oryginalnym cytatem parafrazę, odrzuca zmyślony cytat lub liczbę w innej roli", async () => {
    const article = "W naszym mieście po raz pierwszy wystawiono 15 samochodów na sprzedaż.";
    const index = createDemagogTopicIndex("key", async () => Response.json({ claims: [{ text: article,
      claimReview: [{ title: "Pierwsza sprzedaż 15 samochodów", url, textualRating: "Prawda" }] }] }));
    const lookup = (asked: string, quote: string) => {
      const llm: LlmProvider = { name: "test", family: "test", available: true,
        async complete(req) {
          return { data: req.schema.parse({ candidate: 1, claimQuotes: [quote] }),
            usage: { purpose: req.purpose, model: "test", provider: "test", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } };
        } };
      return index("Czy Demagog sprawdzał, czy " + asked + "?", today, undefined, { llm });
    };
    const asked = "miasto wystawiło na sprzedaż pierwsze 15 samochodów";
    expect((await lookup(asked, article)).status).toBe("hit");
    expect((await lookup(asked, "W mieście sprzedano 15 samochodów")).status).not.toBe("hit");
    expect((await lookup(asked, "samochodów na sprzedaż")).status).not.toBe("hit");
    expect((await lookup(asked.replace("15", "25"), article)).status).not.toBe("hit");
    expect((await lookup(asked.replace("wystawiło", "nie wystawiło"), article)).status).not.toBe("hit");
  });
  it("prosi o tezę w niepełnym pytaniu; awaria i brak wyniku mają różne statusy", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 403 })).mockImplementation(async () => Response.json({}));
    const index = createDemagogTopicIndex("key", fetchMock);
    expect((await index("Czy Demagog to sprawdzał?", today)).status).toBe("clarify");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await index("Czy Demagog sprawdzał, czy " + text, today)).toEqual({ status: "unavailable", reason: "access" });
    expect(await index("Czy Demagog sprawdzał, czy " + text, today)).toEqual({ status: "empty" });
  });
});
