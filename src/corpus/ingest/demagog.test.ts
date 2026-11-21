/**
 * Demagog przez Google Fact Check Tools API — parser odpowiedzi, budowa rekordów i ingestia z atrapą klienta HTTP.
 * Bez sieci i bez prawdziwego klucza.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CorpusRecord } from "../../shared/contracts";
import { loadCatalog } from "../catalog";
import { mapRating } from "../ratings";
import { BlockedError, type HttpResult } from "./common";
import {
  DEMAGOG_HOST,
  FACTCHECK_SEARCH_URL,
  demagogKind,
  demagogTitle,
  ingestDemagog,
  isForeignSection,
  maxAgeDaysFrom,
  parseFactCheckResponse,
  ratingLabel,
  searchUrl,
} from "./demagog";

const here = fileURLToPath(new URL(".", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(resolve(here, "../fixtures/factcheck-demagog.sample.json"), "utf8")) as Record<string, unknown>;

type GetOpts = { accept?: string; headers?: Record<string, string>; secretHeaders?: Record<string, string>; skipRobots?: boolean };

function fakeClient(pages: unknown[], status = 200, failOnCall?: number) {
  const calls: { url: string; headers?: Record<string, string>; secretHeaders?: Record<string, string>; skipRobots?: boolean }[] = [];
  return {
    calls,
    requests: 0,
    async get(url: string, opts: GetOpts = {}): Promise<HttpResult> {
      calls.push({ url, headers: opts.headers, secretHeaders: opts.secretHeaders, skipRobots: opts.skipRobots });
      this.requests++;
      if (failOnCall === calls.length) throw new BlockedError(url, "network", `Błąd sieci dla ${url}: Headers.append: "${opts.secretHeaders?.["X-Goog-Api-Key"]}" is an invalid header value`);
      const body = pages[Math.min(calls.length - 1, pages.length - 1)];
      return { status, finalUrl: url, contentType: "application/json", body: JSON.stringify(body), fetchedAt: "2026-11-21T20:00:00.000Z", fromCache: false };
    },
  };
}

const opts = (limit?: number) => ({ refresh: false, limit, catalog: loadCatalog(), log: () => {} });
/** Stała data „teraz” dla okna 2 lat (recenzje sprzed 2024-11-21 odpadają). */
const now = () => new Date("2026-11-21T12:00:00Z");

describe("Demagog przez Fact Check Tools API", () => {
  it("parseFactCheckResponse: tylko recenzje z DOKŁADNYM hostem demagog.org.pl, z tezą i oceną", () => {
    const page = parseFactCheckResponse(SAMPLE);
    expect(page.nextPageToken).toBe("STRONA-2");
    expect(page.reviews.map((r) => r.url)).toEqual([
      "https://demagog.org.pl/wypowiedzi/przykladowa-teza/",
      "https://demagog.org.pl/fake_news/stare-zdjecie-protestu/",
      "https://demagog.org.pl/fake_news/szczepionki-dna/",
      "https://demagog.org.pl/wypowiedzi/nieczytelna-ocena/",
    ]);
    // fakenews.pl i host podszywający się pod demagog.org.pl odpadają
    expect(page.skipped).toBe(2);
    expect(page.reviews[0]).toEqual({
      url: "https://demagog.org.pl/wypowiedzi/przykladowa-teza/",
      title: "Przykładowa teza. Sprawdzamy",
      reviewDate: "2026-11-19",
      rating: "Fałsz",
      claim: "Rząd zlikwidował wszystkie podatki.",
      claimant: "Jan Polityk",
      claimDate: "2026-11-18",
    });
    expect(parseFactCheckResponse(null)).toEqual({ reviews: [], nextPageToken: null, skipped: 0 });
    expect(parseFactCheckResponse({ claims: "nie tablica" }).reviews).toEqual([]);
  });

  it("ratingLabel: czysta etykieta, „Etykieta. Uzasadnienie…” albo null dla długiego opisu", () => {
    expect(ratingLabel("Fałsz")).toBe("Fałsz");
    expect(ratingLabel("Fałsz.")).toBe("Fałsz.");
    expect(ratingLabel("Manipulacja. Badanie było przeprowadzone na niereprezentatywnej grupie respondentów.")).toBe("Manipulacja");
    expect(ratingLabel("Zbyt wcześnie, aby oceniać")).toBe("Zbyt wcześnie, aby oceniać");
    expect(ratingLabel("Długi opis bez znanej etykiety, który ciągnie się i ciągnie, i nie kończy się na żadnej etykiecie.")).toBeNull();
  });

  it("etykiety z API mapowane tabelą demagog (kropka na końcu, wielkość liter, skala fake newsów)", () => {
    expect(mapRating("demagog", "Fałsz.").mapped).toBe("FALSZYWE");
    expect(mapRating("demagog", "fałsz").mapped).toBe("FALSZYWE");
    expect(mapRating("demagog", "Brakujący kontekst.").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("demagog", "Brak kontekstu").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("demagog", "Częściowy fałsz").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("demagog", "Przerobione zdjęcie.").mapped).toBe("WPROWADZAJACE");
    expect(mapRating("demagog", "Satyra").mapped).toBe("NIE_PODLEGA");
    expect(mapRating("demagog", "Brakujący kontekst").binary).toBe(false);
  });

  it("tytuł bez nazwiska autora tezy (BM25 waży tytuł x10); tytuł strony-listy zastępuje teza", () => {
    const [wyp, fake] = parseFactCheckResponse(SAMPLE).reviews;
    expect(demagogKind(wyp!.url)).toBe("wypowiedz");
    expect(demagogKind(fake!.url)).toBe("fake-news");
    expect(demagogKind("https://demagog.org.pl/analizy_i_raporty/x/")).toBe("inne");
    expect(demagogTitle(wyp!)).toBe("Demagog - wypowiedź: Przykładowa teza. Sprawdzamy");
    expect(demagogTitle(fake!)).toBe("Demagog - fake news: Stare zdjęcie protestu. Brakujący kontekst");
    expect(demagogTitle(fake!)).not.toContain("Anna Prywatna");
    expect(demagogTitle({ ...wyp!, title: "Wypowiedzi - weryfikujemy słowa polityków i osób publicznych" })).toBe(
      "Demagog - wypowiedź: Rząd zlikwidował wszystkie podatki.",
    );
    expect(isForeignSection("https://demagog.org.pl/ua/wypowiedzi/x/")).toBe(true);
    expect(isForeignSection("https://demagog.org.pl/wypowiedzi/x/")).toBe(false);
  });

  it("adres zapytania nie zawiera klucza", () => {
    const u = new URL(searchUrl("TOKEN"));
    expect(`${u.origin}${u.pathname}`).toBe(FACTCHECK_SEARCH_URL);
    expect(u.searchParams.get("reviewPublisherSiteFilter")).toBe(DEMAGOG_HOST);
    expect(u.searchParams.get("pageToken")).toBe("TOKEN");
    expect(u.searchParams.has("key")).toBe(false);
  });

  it("bez klucza: zero żądań, zero rekordów, powód w raporcie", async () => {
    const client = fakeClient([SAMPLE]);
    const res = await ingestDemagog(opts(), { env: {}, client, now });
    expect(client.calls).toHaveLength(0);
    expect(res.records).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/FACTCHECK_API_KEY/);
  });

  it("z kluczem: klucz tylko w nagłówku poza cache'em, paginacja, rekordy stałej roli od najnowszego, bez żądań do demagog.org.pl", async () => {
    const lastPage = { ...SAMPLE, nextPageToken: undefined };
    const client = fakeClient([SAMPLE, lastPage]);
    const res = await ingestDemagog(opts(), { env: { FACTCHECK_API_KEY: "test-key" }, client, now });
    expect(client.calls).toHaveLength(2);
    for (const c of client.calls) {
      expect(new URL(c.url).hostname).toBe("factchecktools.googleapis.com");
      expect(c.url).not.toContain("test-key");
      expect(c.secretHeaders?.["X-Goog-Api-Key"]).toBe("test-key");
      expect(JSON.stringify(c.headers ?? {})).not.toContain("test-key"); // nagłówki zwykłe wchodzą do klucza cache'u
    }
    expect(new URL(client.calls[1]!.url).searchParams.get("pageToken")).toBe("STRONA-2");
    // te same recenzje na obu stronach => deduplikacja po id; recenzje sprzed roku (domyślne okno) => pominięte
    expect(res.records.map((r) => r.url)).toEqual([
      "https://demagog.org.pl/fake_news/stare-zdjecie-protestu/",
      "https://demagog.org.pl/wypowiedzi/przykladowa-teza/",
    ]);
    for (const r of res.records) {
      expect(() => CorpusRecord.parse(r)).not.toThrow();
      expect(r.sourceId).toBe("demagog");
      expect(r.role).toBe("stala_rola");
      expect(r.level).toBe(2);
      expect(r.text).toBe(r.claimReviewed);
      expect(new URL(r.url).hostname).toBe(DEMAGOG_HOST);
    }
    const [fake, wyp] = res.records;
    expect(fake!.rating).toEqual({ raw: "Brakujący kontekst.", mapped: "WPROWADZAJACE", binary: false });
    expect(fake!.topics).toContain("fake-news");
    expect(fake!.topics.join("|")).not.toContain("Anna Prywatna"); // autor fake newsa nie jest zapisywany
    expect(wyp!.publishedAt).toBe("2026-11-19");
    expect(wyp!.period).toBe("2026-11");
    expect(wyp!.topics).toEqual(expect.arrayContaining(["wypowiedz-polityka", "autor-tezy:Jan Polityk"]));
    expect(wyp!.title).not.toContain("Jan Polityk");
    expect(res.skipped.some((s) => /starszych niż 2025-11-2/.test(s.reason))).toBe(true);
    expect(new URL(client.calls[0]!.url).searchParams.get("maxAgeDays")).toBe("365");
  });

  it("okno czasowe z .env (DEMAGOG_MAX_AGE_DAYS) — także w zapytaniu do API; zła wartość => domyślne 365", async () => {
    const lastPage = { ...SAMPLE, nextPageToken: undefined };
    const wide = fakeClient([lastPage]);
    const res = await ingestDemagog(opts(), { env: { FACTCHECK_API_KEY: "k", DEMAGOG_MAX_AGE_DAYS: "2000" }, client: wide, now });
    expect(new URL(wide.calls[0]!.url).searchParams.get("maxAgeDays")).toBe("2000");
    expect(res.records.map((r) => r.url)).toContain("https://demagog.org.pl/fake_news/szczepionki-dna/");
    expect(maxAgeDaysFrom({ DEMAGOG_MAX_AGE_DAYS: "abc" })).toBe(365);
    expect(maxAgeDaysFrom({ DEMAGOG_MAX_AGE_DAYS: "0" })).toBe(365);
    expect(maxAgeDaysFrom({})).toBe(365);
  });

  it("za krótka teza (< 21 znaków) jest pomijana jawnie", async () => {
    const short = {
      claims: [
        {
          text: "Szczepionki zabijają",
          claimReview: [{ url: "https://demagog.org.pl/fake_news/krotka/", reviewDate: "2026-11-01T00:00:00Z", textualRating: "Fałsz" }],
        },
      ],
    };
    const res = await ingestDemagog(opts(), { env: { FACTCHECK_API_KEY: "k" }, client: fakeClient([short]), now });
    expect(res.records).toEqual([]);
    expect(res.skipped).toContainEqual({ what: "https://demagog.org.pl/fake_news/krotka/", reason: "teza krótsza niż 21 znaków" });
  });

  it("limit bierze najnowsze recenzje", async () => {
    const client = fakeClient([{ ...SAMPLE, nextPageToken: undefined }]);
    const res = await ingestDemagog(opts(1), { env: { FACTCHECK_API_KEY: "k" }, client, now });
    expect(res.records.map((r) => r.publishedAt)).toEqual(["2026-11-20"]);
  });

  it("błąd API (np. zły klucz): brak rekordów, powód bez treści odpowiedzi i bez klucza", async () => {
    const client = fakeClient([{ error: { message: "API key not valid. key=secret" } }], 400);
    const res = await ingestDemagog(opts(), { env: { FACTCHECK_API_KEY: "secret" }, client, now });
    expect(res.records).toEqual([]);
    expect(res.skipped[0]?.reason).toBe("HTTP 400 z Fact Check Tools API");
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("awaria w trakcie paginacji: zero rekordów (poprzedni plik zostaje), powód bez treści błędu i bez klucza", async () => {
    const client = fakeClient([SAMPLE, SAMPLE], 200, 2);
    const res = await ingestDemagog(opts(), { env: { FACTCHECK_API_KEY: "sekretny-klucz" }, client, now });
    expect(client.calls).toHaveLength(2);
    expect(res.records).toEqual([]);
    expect(res.skipped[0]?.reason).toBe("błąd sieci lub przekroczony czas połączenia z Fact Check Tools API");
    expect(JSON.stringify(res)).not.toContain("sekretny-klucz");
  });
});
