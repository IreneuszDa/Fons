import { describe, expect, it } from "vitest";
import type { PublicationLink } from "../corpus/publication-links";
import type { CorpusRecord, NormalizedInput } from "../shared/contracts";
import { compareReviewedDocument, linkedPublicationRecords, reviewedMediaRecords, screenshotClaim, withScreenshotReading } from "./attachment-answer";
import { FakeLlmProvider } from "./llm/fake";
import { normalizeInput } from "./normalize";
import { memoryStore } from "./testing/stubs";

const iso = "2026-11-22T12:00:00Z";
const doc: CorpusRecord = {
  id: "agency:1", sourceId: "agency", publisher: "Agencja Prasowa Regionu", title: "Nowa stacja rejestruje drgania ziemi",
  text: "Nowa stacja rejestruje drgania ziemi", publishedAt: "2023-01-16", fetchedAt: iso,
  url: "https://region.example.org/komunikaty/stacja", role: "tresc", type: "pierwotne", level: 1, period: "2023",
  topics: ["sejsmologia", "Katowice"], lang: "pl", independenceGroup: "region", licence: "Test", origin: "corpus",
};
const review: CorpusRecord = { ...doc, id: "review:1", sourceId: "review", type: "factcheck", level: 2, role: "stala_rola",
  publisher: "Przegląd", title: "Kiedy rozpoczęto pomiary?", text: "Otwarcie ośrodka nastąpiło w grudniu.",
  claimReviewed: "Otwarcie ośrodka nastąpiło w grudniu.", rating: { mapped: "FALSZYWE", raw: "Fałsz", binary: true },
  url: "https://review.example.org/pomiary", publishedAt: "2023-02-20" };
const extra = { ...doc, id: "agency:2", url: "https://region.example.org/dane" };
const other = { ...doc, id: "agency:3", url: "https://region.example.org/inne" };
const links: PublicationLink[] = [{ publicationId: review.id, url: review.url, documents: [doc.id], context: [extra.id],
  appearances: ["https://www.instagram.com/reels/NowePomiary1/", "https://www.youtube.com/watch?v=SeismoVideo"] }];
const store = memoryStore([doc, review, extra, other]);
const question = "Czy ten wpis opisuje ten sam komunikat, który sprawdziła redakcja?";
const base = (o: Partial<NormalizedInput>): NormalizedInput => ({
  kind: "url", text: question, textResolvedDates: question, userNote: question, submittedUrl: "https://example.org/post",
  receivedAt: iso, detectorHits: [], warnings: [], piiMasked: false, ...o,
});
const body = "Pracownia sejsmologii w Katowicach opisuje nowe pomiary.";
const compare = (o: Partial<NormalizedInput>) => compareReviewedDocument(base(o), [review, doc], store, links);

describe("bibliographic matches independent of topic or publisher", () => {
  it("compares the complete headline, independently stated subject and attributed day", () => {
    const content = `Komunikat z 16 stycznia 2023 r. „${doc.title}”. ${body}`;
    const answer = compare({ pageTitle: "Styczniowy przegląd", pagePublishedAt: "2026-11-20", attachmentText: content });
    expect(answer?.answerPl).toMatch(/^Tak\..*16 stycznia 2023.*sejsmologia/);
    expect(answer?.evidence.map(e => e.url)).toEqual([review.url, doc.url]);
    expect(compare({ pageTitle: doc.title + " | Archiwum regionu", submittedUrl: doc.url,
      pagePublishedAt: "2023-01-16", attachmentText: body })?.answerPl).toMatch(/^Tak\./);
    expect(compare({ pageTitle: doc.title, attachmentText: `Komunikat z 16.01.2023. ${doc.title}.` })?.answerPl).toMatch(/^Nie udało.+tematu/s);
  });

  it("distinguishes other titles, unrelated dates, the date of a repost and contradictory attributed dates", () => {
    expect(compare({ pageTitle: "Inna depesza", submittedUrl: "https://region.example.org/komunikaty/inna",
      pagePublishedAt: "2023-01-16", attachmentText: body })?.answerPl).toMatch(/^Nie\..+inny nagłówek/);
    expect(compare({ pageTitle: doc.title, attachmentText: "Komunikat z 17.01.2023. " + body })?.answerPl).toMatch(/^Nie\..+inną datę/);
    expect(compare({ pageTitle: doc.title, pagePublishedAt: "2023-01-16", attachmentText: "Konferencja odbyła się 16.01.2023. " + body })?.answerPl).toMatch(/^Nie udało.+daty dokumentu/);
    expect(compare({ pageTitle: doc.title, attachmentText: "Komunikat z 16.01.2023. Komunikat z 17.01.2023. " + body })?.answerPl).toMatch(/^Nie udało.+daty dokumentu/);
    expect(compare({ userNote: question + doc.title + " 16.01.2023", attachmentText: body })?.answerPl).toMatch(/^Nie udało.+tytułu/);
  });

  it("compares documents cited directly inside a retrieved review even without curated links", () => {
    const otherReview = { ...review, text: "Sprawdziliśmy tekst: „" + doc.title + "”." };
    expect(compareReviewedDocument(base({ submittedUrl: doc.url, pageTitle: doc.title, pagePublishedAt: doc.publishedAt!,
      attachmentText: body }), [otherReview, doc], store, [])?.answerPl).toMatch(/^Tak\./);
    expect(compareReviewedDocument(base({ pageTitle: doc.title, attachmentText: body }), [review, doc], store, [])?.answerPl).toContain("z którym sprawdzonym dokumentem");
  });

  it("matches an exact post or the recording's review and includes corroborating sources", () => {
    for (const url of ["https://www.instagram.com/reel/NowePomiary1/?utm_medium=social", "https://youtu.be/SeismoVideo", review.url]) {
      expect(reviewedMediaRecords(url, store, links).map(r => r.id)).toEqual([review.id, doc.id, extra.id]);
    }
    expect(reviewedMediaRecords("https://www.instagram.com/reels/NowePomiary2/", store, links)).toEqual([]);
    expect(reviewedMediaRecords("https://www.instagram.com/profile/", store, links)).toEqual([]);
    expect(linkedPublicationRecords([review, other, doc], store, links).map(r => r.id)).toEqual([review.id, doc.id, extra.id, other.id]);
    expect(linkedPublicationRecords([doc], store, links).map(r => r.id)).toEqual([doc.id, review.id, extra.id]);
  });
});

it("reads the literal timestamp and claim from an image independently of the original publication", async () => {
  const text = "21.11.2026\nStacja sejsmologiczna w Katowicach rozpoczęła pracę 16 stycznia 2023.";
  const llm = new FakeLlmProvider({ supportsVision: true, override: () => ({ text, dates: ["2024-11-27"], readable: true }) });
  const res = await normalizeInput({ kind: "image", text: "Czy to sprawdzano?", receivedAt: iso,
    images: [{ mime: "image/png", base64: "AA==" }] }, { llm, receivedAt: new Date(iso),
    fetchPage: async () => { throw new Error("Unexpected page"); }, ocrDown: false });
  if (!res.ok) throw Error("OCR failed");
  expect(res.normalized.visibleDates).toEqual(["21.11.2026", "16 stycznia 2023"]);
  expect(res.normalized.pagePublishedAt).toBeUndefined();
  expect(screenshotClaim(res.normalized)).toBe(text.split("\n")[1]);
  const answer = withScreenshotReading(res.normalized, { answerPl: "Odpowiedź ze źródła.", evidence: [] });
  expect(answer.answerPl).toContain("21.11.2026");
  expect(answer.answerPl).toContain("nie potwierdzają daty publikacji");
  expect(answer.answerPl).not.toContain("2024-11-27");
});
