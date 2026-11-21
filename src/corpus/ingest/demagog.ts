/**
 * Fact-checki Demagoga (demagog.org.pl; sygnatariusz IFCN i EFCSN) — WYŁĄCZNIE przez Google Fact Check Tools API.
 *
 * Zasada projektu: żadnej bezpośredniej integracji z serwisem Demagoga. Nie pobieramy jego stron, kanałów RSS ani map strony,
 * a wyszukiwanie na żywo ma dla tego hosta `liveSearch: false` (data/sources.yaml). Jedyne źródło danych to oficjalne API Google:
 *   GET https://factchecktools.googleapis.com/v1alpha1/claims:search
 *       ?reviewPublisherSiteFilter=demagog.org.pl&languageCode=pl&maxAgeDays=365&pageSize=100[&pageToken=…]
 * Klucz `FACTCHECK_API_KEY` (z .env) idzie w nagłówku `X-Goog-Api-Key` jako `secretHeaders` klienta: nie trafia do adresu, logów,
 * raportu budowania ani do klucza i treści cache'u (rotacja klucza nie unieważnia cache'u). API zwraca znaczniki ClaimReview, które
 * publikuje Demagog: teza (`text`), autor tezy (`claimant`), data tezy, adres i tytuł recenzji, data recenzji, ocena (`textualRating`).
 *
 * Zakres: recenzje z DOKŁADNYM hostem demagog.org.pl, polskojęzyczne (bez sekcji /ua/, /en/ …), z datą recenzji z ostatniego roku
 * (sprawdzane też lokalnie — `maxAgeDays` API przepuszcza starsze; okno zmienia `DEMAGOG_MAX_AGE_DAYS` w .env), od najnowszej,
 * najwyżej `limit` (domyślnie 2000). Dlaczego rok: przy 2 latach (ok. 1750 rekordów, połowa korpusu) twierdzenia z nazwiskiem
 * polityka dostawały w puli BM25 prawie same fact-checki Demagoga i wypadały rekordy urzędowe; przy roku (ok. 750) udział wraca
 * do poziomu sprzed migracji. Szersze okno ma sens dopiero z limitem rekordów jednego źródła w wyszukiwaniu.
 * Rekord: rola stala_rola, poziom 2 (z katalogu), tekst = teza dosłownie z API, ocena przez data/rating-map.yaml (tabela demagog).
 *
 * Autor tezy NIE trafia do tytułu: tytuł ma wagę 10 w BM25, więc nazwisko polityka w tytule sprawiało, że przy każdym twierdzeniu
 * z jego nazwiskiem pulę kandydatów zalewały niezwiązane fact-checki jego innych wypowiedzi (wypierając m.in. rekordy urzędowe).
 * Dla wypowiedzi polityków autor jest w `topics` (pole nieindeksowane, „autor-tezy:…”); przy fake newsach autorem bywa osoba
 * prywatna, więc go nie zapisujemy (minimalizacja danych).
 *
 * Awaria w trakcie paginacji = brak rekordów (build zostawia poprzedni plik), żeby niepełne pobranie nie nadpisało pełnego.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { mapRating } from "../ratings";
import {
  BlockedError,
  MAX_TEXT_CHARS,
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  clipVerbatim,
  newResult,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

export const DEMAGOG_HOST = "demagog.org.pl";
export const FACTCHECK_SEARCH_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";
export const DEMAGOG_DEFAULT_LIMIT = 2000;
/** Domyślne okno czasowe recenzji (dni); nadpisanie: DEMAGOG_MAX_AGE_DAYS w .env (1–3650). */
export const DEMAGOG_MAX_AGE_DAYS = 365;

export function maxAgeDaysFrom(env: Record<string, string | undefined>): number {
  const n = Number((env.DEMAGOG_MAX_AGE_DAYS ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEMAGOG_MAX_AGE_DAYS;
}
const PAGE_SIZE = 100;
/** Krótsze tezy (np. „Szczepionki zabijają”) są za mało konkretne jako fragment dowodu — pomijamy je jawnie. */
export const MIN_CLAIM_CHARS = 21;
/** Bezpiecznik paginacji (przy oknie 2 lat API zwraca ok. 18 stron, przy roku ok. 8). */
const MAX_PAGES = 100;
/** Pierwszy segment ścieżki sekcji obcojęzycznych Demagoga (np. /ua/wypowiedzi/…). */
const FOREIGN_SECTIONS = new Set(["ua", "en", "ru", "de", "uk"]);
/** Tytuły stron-list zamiast tytułu recenzji (API bywa je zwraca) — wtedy tytuł bierzemy z tezy. */
const GENERIC_TITLE = [/^wypowiedzi\s*[-–—]\s*weryfikujemy/i, /^fake news(y)?\s*[-–—]/i, /^demagog\s*[-–—|]/i];

/**
 * Etykieta oceny: całe pole, a gdy jest to „Etykieta. Uzasadnienie…” (bywa w starszych wpisach) — początek do pierwszej kropki,
 * o ile jest znany tabeli mapowania. Zwraca dosłowny podciąg pola albo null (długi opis bez znanej etykiety).
 */
export function ratingLabel(raw: string): string | null {
  const s = squash(raw);
  if (mapRating("demagog", s).mapped !== null) return s;
  const lead = /^([^.:!?]{2,40})[.:!?](?:\s|$)/.exec(s)?.[1]?.trim();
  if (lead && mapRating("demagog", lead).mapped !== null) return lead;
  return s.length <= 60 ? s : null;
}

/** Jedna recenzja Demagoga z odpowiedzi claims:search. */
export interface FactCheckReview {
  url: string;
  title: string | null;
  /** RRRR-MM-DD albo null. */
  reviewDate: string | null;
  rating: string;
  claim: string;
  claimant: string | null;
  /** RRRR-MM-DD albo null. */
  claimDate: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? squash(v) : null);

function isoDay(d: unknown): string | null {
  const m = typeof d === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(d) : null;
  return m ? m[1]! : null;
}

function parsedUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function firstSegment(url: string): string {
  return parsedUrl(url)?.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

/**
 * Recenzje Demagoga z jednej strony odpowiedzi claims:search. Bierze tylko recenzje, których adres ma DOKŁADNY host
 * demagog.org.pl i które mają tezę i ocenę; pozostałe liczy w `skipped`.
 */
export function parseFactCheckResponse(body: unknown): { reviews: FactCheckReview[]; nextPageToken: string | null; skipped: number } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const claims = Array.isArray(o.claims) ? o.claims : [];
  const reviews: FactCheckReview[] = [];
  let skipped = 0;
  for (const c of claims) {
    const claim = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const text = str(claim.text);
    for (const r of Array.isArray(claim.claimReview) ? claim.claimReview : []) {
      const rv = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const url = str(rv.url);
      const rating = str(rv.textualRating);
      if (!url || parsedUrl(url)?.hostname.toLowerCase() !== DEMAGOG_HOST || !text || !rating) {
        skipped++;
        continue;
      }
      reviews.push({
        url,
        title: str(rv.title),
        reviewDate: isoDay(rv.reviewDate),
        rating,
        claim: text,
        claimant: str(claim.claimant),
        claimDate: isoDay(claim.claimDate),
      });
    }
  }
  return { reviews, nextPageToken: str(o.nextPageToken), skipped };
}

export type DemagogKind = "wypowiedz" | "fake-news" | "inne";

/** Rodzaj recenzji po ścieżce adresu: /wypowiedzi/… (wypowiedź polityka), /fake_news/… (fałszywa informacja), reszta. */
export function demagogKind(url: string): DemagogKind {
  const first = firstSegment(url);
  return first === "wypowiedzi" ? "wypowiedz" : first === "fake_news" ? "fake-news" : "inne";
}

/** Sekcja obcojęzyczna (np. /ua/…) — rekord byłby błędnie oznaczony jako `pl` i dublowałby polską recenzję. */
export function isForeignSection(url: string): boolean {
  return FOREIGN_SECTIONS.has(firstSegment(url));
}

/** Tytuł rekordu: nagłówek recenzji Demagoga (bez nazwiska autora tezy); tytuł strony-listy zastępuje początek tezy. */
export function demagogTitle(r: FactCheckReview): string {
  const own = r.title && !GENERIC_TITLE.some((re) => re.test(r.title!)) ? r.title : null;
  const head = own ?? clipVerbatim(r.claim, 140);
  const kind = demagogKind(r.url);
  if (kind === "wypowiedz") return `Demagog - wypowiedź: ${head}`;
  if (kind === "fake-news") return `Demagog - fake news: ${head}`;
  return `Demagog: ${head}`;
}

const KIND_TOPIC: Record<DemagogKind, string> = { wypowiedz: "wypowiedz-polityka", "fake-news": "fake-news", inne: "demagog-inne" };

/** Rekord korpusu z recenzji albo null, gdy ocena nie ma czytelnej etykiety. */
export function toDemagogRecord(
  r: FactCheckReview,
  base: ReturnType<typeof baseFromCatalog>,
  fetchedAt: string,
): CorpusRecord | null {
  const label = ratingLabel(r.rating);
  if (!label) return null;
  const text = clipVerbatim(r.claim, MAX_TEXT_CHARS);
  const kind = demagogKind(r.url);
  return {
    ...base,
    id: recordId("demagog", `${r.url}|${r.claim}`),
    url: r.url,
    title: demagogTitle(r),
    publishedAt: r.reviewDate,
    fetchedAt,
    lang: "pl",
    text,
    claimReviewed: text,
    rating: mapRating("demagog", label),
    topics: [
      "fact-check",
      "claimreview",
      "demagog",
      KIND_TOPIC[kind],
      // autor wypowiedzi polityka (osoba publiczna) — poza polami indeksowanymi; przy fake newsach nie zapisujemy
      ...(kind === "wypowiedz" && r.claimant ? [`autor-tezy:${r.claimant}`] : []),
    ],
    period: r.claimDate ? r.claimDate.slice(0, 7) : undefined,
    origin: "corpus",
  };
}

/** Adres strony wyników (bez klucza — klucz idzie w nagłówku). */
export function searchUrl(pageToken?: string | null, maxAgeDays = DEMAGOG_MAX_AGE_DAYS): string {
  const p = new URLSearchParams({
    reviewPublisherSiteFilter: DEMAGOG_HOST,
    languageCode: "pl",
    maxAgeDays: String(maxAgeDays),
    pageSize: String(PAGE_SIZE),
  });
  if (pageToken) p.set("pageToken", pageToken);
  return `${FACTCHECK_SEARCH_URL}?${p.toString()}`;
}

/** Powód awarii bez treści błędu (komunikat undici może zawierać wartość nagłówka, czyli klucz). */
function failureReason(e: unknown): string {
  if (e instanceof BlockedError) {
    if (e.reason === "http") return `HTTP ${/HTTP (\d{3})/.exec(e.message)?.[1] ?? "4xx"} z Fact Check Tools API — sprawdź klucz i włączenie API`;
    if (e.reason === "network") return "błąd sieci lub przekroczony czas połączenia z Fact Check Tools API";
    return `odpowiedź odrzucona przez klienta (${e.reason})`;
  }
  const msg = e instanceof Error ? e.message : "";
  return /^(HTTP \d{3} z Fact Check Tools API|nieczytelna odpowiedź JSON z Fact Check Tools API)$/.test(msg) ? msg : "nieoczekiwany błąd pobierania";
}

export interface DemagogDeps {
  env?: Record<string, string | undefined>;
  client?: Pick<PoliteClient, "get" | "requests">;
  now?: () => Date;
}

export async function ingestDemagog(opts: IngestOptions, deps: DemagogDeps = {}): Promise<IngestResult> {
  const result = newResult("demagog");
  const env = deps.env ?? process.env;
  const key = (env.FACTCHECK_API_KEY ?? "").trim();
  if (!key) {
    result.skipped.push({ what: FACTCHECK_SEARCH_URL, reason: "brak klucza FACTCHECK_API_KEY w .env (Google Fact Check Tools API)" });
    result.notes.push("Demagog: pominięty — bez klucza Fact Check Tools API nie pobieramy niczego (z serwisem Demagoga nie łączymy się bezpośrednio).");
    return result;
  }
  // API Google, nie strona WWW: robots.txt nie dotyczy (zasady wyznaczają warunki korzystania z API i limity projektu).
  const client = deps.client ?? new PoliteClient({ refresh: opts.refresh, minIntervalMs: 300 });
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "demagog"));
  const limit = opts.limit ?? DEMAGOG_DEFAULT_LIMIT;
  const maxAgeDays = maxAgeDaysFrom(env);
  const cutoff = new Date((deps.now ?? (() => new Date()))().getTime() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);

  const collected: { review: FactCheckReview; fetchedAt: string }[] = [];
  let token: string | null = null;
  let pages = 0;
  let otherHosts = 0;
  try {
    do {
      const res = await client.get(searchUrl(token, maxAgeDays), {
        accept: "application/json",
        secretHeaders: { "X-Goog-Api-Key": key },
        skipRobots: true,
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} z Fact Check Tools API`);
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new Error("nieczytelna odpowiedź JSON z Fact Check Tools API");
      }
      const page = parseFactCheckResponse(body);
      otherHosts += page.skipped;
      for (const review of page.reviews) collected.push({ review, fetchedAt: res.fetchedAt });
      token = page.nextPageToken;
      pages++;
    } while (token && pages < MAX_PAGES);
  } catch (e) {
    // Niepełne pobranie nie może nadpisać pełnego pliku: zero rekordów => build zostawia poprzednie dane.
    result.skipped.push({ what: FACTCHECK_SEARCH_URL, reason: failureReason(e) });
    result.notes.push(`Demagog: pobieranie przerwane po ${pages} stronach (${failureReason(e)}) — nic nie zapisano, poprzedni plik zostaje.`);
    result.requests = client.requests;
    return result;
  }

  collected.sort((a, b) => (b.review.reviewDate ?? "").localeCompare(a.review.reviewDate ?? ""));
  const unknownRatings: Record<string, number> = {};
  const kinds: Record<DemagogKind, number> = { wypowiedz: 0, "fake-news": 0, inne: 0 };
  const seen = new Set<string>();
  let tooOld = 0;
  let foreign = 0;
  for (const { review, fetchedAt } of collected) {
    if (result.records.length >= limit) break;
    if (!review.reviewDate || review.reviewDate < cutoff) {
      tooOld++;
      continue;
    }
    if (isForeignSection(review.url)) {
      foreign++;
      continue;
    }
    if (review.claim.length < MIN_CLAIM_CHARS) {
      result.skipped.push({ what: review.url, reason: `teza krótsza niż ${MIN_CLAIM_CHARS} znaków` });
      continue;
    }
    const rec = toDemagogRecord(review, base, fetchedAt);
    if (!rec) {
      result.skipped.push({ what: review.url, reason: "ocena bez czytelnej etykiety" });
      continue;
    }
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    if (rec.rating?.mapped === null) unknownRatings[rec.rating.raw] = (unknownRatings[rec.rating.raw] ?? 0) + 1;
    kinds[demagogKind(review.url)]++;
    result.records.push(rec);
  }
  if (tooOld) result.skipped.push({ what: FACTCHECK_SEARCH_URL, reason: `${tooOld} recenzji bez daty lub starszych niż ${cutoff}` });
  if (foreign) result.skipped.push({ what: FACTCHECK_SEARCH_URL, reason: `${foreign} recenzji z sekcji obcojęzycznych (np. /ua/)` });

  result.requests = client.requests;
  const dates = result.records.map((r) => r.publishedAt).filter((d): d is string => !!d).sort();
  const unknown = Object.entries(unknownRatings).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`);
  opts.log(`  Demagog (Fact Check Tools API): ${pages} stron, ${collected.length} recenzji, zapisano ${result.records.length}`);
  result.notes.push(
    `Demagog: ${result.records.length} recenzji z Google Fact Check Tools API (filtr reviewPublisherSiteFilter=${DEMAGOG_HOST}, ` +
      `maxAgeDays=${maxAgeDays} i lokalnie data recenzji >= ${cutoff}, limit ${limit}; ${pages} stron; recenzje innych hostów: ${otherHosts}, ` +
      `starsze/bez daty: ${tooOld}, sekcje obcojęzyczne: ${foreign}); wypowiedzi ${kinds.wypowiedz}, fake newsy ${kinds["fake-news"]}, inne ${kinds.inne}; ` +
      `daty recenzji ${dates[0] ?? "?"} – ${dates.at(-1) ?? "?"}. Bez bezpośrednich żądań do demagog.org.pl. Tekst = teza dosłownie z API; ` +
      "autor tezy nie jest w tytule. Etykiety spoza tabeli mapowania (mapped=null): " +
      (unknown.length ? unknown.slice(0, 15).join(", ") : "brak") +
      ".",
  );
  return result;
}
