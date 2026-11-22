import { z } from "zod";
import { DEMAGOG_HOST, FACTCHECK_SEARCH_URL, parseFactCheckResponse, type FactCheckReview } from "../../corpus/ingest/demagog";
import { fold } from "./stem";

export type IndexUnavailable = { status: "unavailable"; reason: "no_key" | "access" | "quota" | "incomplete" | "provider" };

export type IndexMiss = { status: "empty" } | IndexUnavailable;

export const GOOGLE_INDEX_UNAVAILABLE_PL = "Nie mogę teraz sprawdzić indeksu Google z powodu błędu dostępu.";

export function googleIndexMessage(result: IndexMiss): string {
  if (result.status === "empty") return "Nie znalazłem w indeksie Google publikacji Demagoga odpowiadającej temu pytaniu. To nie wyklucza, że taka publikacja istnieje.";
  switch (result.reason) {
    case "access": return GOOGLE_INDEX_UNAVAILABLE_PL;
    case "no_key": return "Nie mogę teraz sprawdzić indeksu Google, ponieważ usługa nie ma skonfigurowanego klucza dostępu.";
    case "quota": return "Nie mogę teraz sprawdzić indeksu Google, ponieważ został wyczerpany limit zapytań.";
    case "incomplete": return "Nie udało mi się sprawdzić wszystkich wyników w indeksie Google.";
    case "provider": return "Nie mogę teraz sprawdzić indeksu Google z powodu błędu połączenia lub odpowiedzi usługi.";
  }
}

export function asksAboutDemagogReview(text: string): boolean {
  const s = fold(text);
  return /\bdemagog(?:a|owi|u)?\b/.test(s)
    && /\b(?:czy|sprawdz|znajdz|szukam|poszukaj|wyszukaj|ktora|jaka)\b/.test(s)
    && /\b(?:sprawdz[aeio][a-z]*|weryfikow[a-z]*|zweryfikow[a-z]*|ocenil[a-z]*|fact[ -]?check[a-z]*|weryfikacj[a-z]*)\b/.test(s);
}

// Empty objects are a valid protobuf encoding for a completed search with no matches.
const ResponsePage = z.object({
  claims: z.array(z.object({ text: z.string().optional(), claimReview: z.array(z.object({
    url: z.string().optional(), textualRating: z.string().optional(),
  }).passthrough()).optional() }).passthrough()).optional(),
  nextPageToken: z.string().optional(),
}).strict();

function isPublisherReview(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === DEMAGOG_HOST && /^https?:$/.test(url.protocol) && !url.port
      && !url.username && !url.password && url.pathname.split("/").some(Boolean);
  } catch {
    return false;
  }
}

async function errorReason(response: Response): Promise<IndexUnavailable["reason"]> {
  if (response.status === 401 || response.status === 403) return "access";
  if (response.status === 429) return "quota";
  // Google returns HTTP 400 (INVALID_ARGUMENT) for an invalid API key. Other 400s need not be access errors.
  if (response.status === 400) {
    const details = z.object({ error: z.object({ details: z.array(z.object({ reason: z.string().optional() })).optional() }) })
      .safeParse(await response.json().catch(() => null));
    if (details.success && details.data.error.details?.some(detail => detail.reason?.startsWith("API_KEY_"))) return "access";
  }
  return "provider";
}

type ReviewPage = { status: "page"; reviews: FactCheckReview[] } | IndexUnavailable;

/** Reads the publisher-filtered index with its current rating and publication metadata. */
export async function* demagogReviewPages(
  apiKey: string | undefined, fetchImpl: typeof fetch, query: string, signal?: AbortSignal,
): AsyncGenerator<ReviewPage> {
  if (!apiKey?.trim()) { yield { status: "unavailable", reason: "no_key" }; return; }
  if (!query.trim()) { yield { status: "unavailable", reason: "incomplete" }; return; }
  const endpoint = new URL(FACTCHECK_SEARCH_URL);
  endpoint.search = new URLSearchParams({ query: query.trim(), reviewPublisherSiteFilter: DEMAGOG_HOST, languageCode: "pl", pageSize: "50" }).toString();
  const timeout = AbortSignal.timeout(10_000);
  const seen = new Set<string>();
  try {
    for (let page = 0; page < 4; page++) {
      const response = await fetchImpl(endpoint.href, {
        headers: { "X-Goog-Api-Key": apiKey }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout, redirect: "error",
      });
      if (!response.ok) {
        yield { status: "unavailable", reason: await errorReason(response) };
        return;
      }
      const { reviews, nextPageToken } = parseFactCheckResponse(ResponsePage.parse(await response.json()));
      yield { status: "page", reviews: reviews.filter(review => isPublisherReview(review.url)) };
      if (!nextPageToken) return;
      if (seen.has(nextPageToken)) break;
      seen.add(nextPageToken);
      endpoint.searchParams.set("pageToken", nextPageToken);
    }
    yield { status: "unavailable", reason: "incomplete" };
  } catch {
    yield { status: "unavailable", reason: "provider" };
  }
}
