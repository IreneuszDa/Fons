import { publicationLinks, type PublicationLink } from "../corpus/publication-links";
import type { CorpusRecord, CorpusStore, NormalizedInput } from "../shared/contracts";
import { answerEvidenceItem } from "./answer";
import { printedDates, samePrintedDay } from "./attachment-dates";
import type { PublishedAnswer } from "./published";
import { contentWords, foldForMatch, formatDatePl, truncateWords } from "./text";
import { socialPostId } from "./video/social-source";
import { publicPostUrl, socialVideoPlatform } from "./video/platforms";
import { stemToken } from "./retrieval/stem";

export function documentUrl(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) return;
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

/** Add bibliographic neighbours immediately after their search hit, deduplicating by record ID. */
export function linkedPublicationRecords(records: CorpusRecord[], store: CorpusStore, links = publicationLinks()): CorpusRecord[] {
  const result = new Map<string, CorpusRecord>();
  for (const record of records) {
    result.set(record.id, record);
    for (const link of links) {
      const children = [...(link.documents ?? []), ...(link.references ?? []), ...(link.context ?? [])];
      if (record.id !== link.publicationId && !children.includes(record.id)) continue;
      const publication = store.get(link.publicationId);
      if (publication?.url !== link.url) continue;
      result.set(publication.id, publication);
      for (const r of store.getMany(children)) result.set(r.id, r);
    }
  }
  return [...result.values()];
}

/** Match a publication's recorded appearance, independent of the author's profile or platform domain. */
export function reviewedMediaRecords(raw: string, store: CorpusStore, links = publicationLinks()): CorpusRecord[] {
  const url = documentUrl(raw);
  if (!url) return [];
  const mediaId = (addr: string) => socialPostId(addr) ?? (socialVideoPlatform(addr) ? publicPostUrl(addr) : documentUrl(addr));
  const id = mediaId(raw);
  const reviews: CorpusRecord[] = [];
  for (const link of links) {
    if (!link.appearances?.length) continue;
    const sameMedia = link.appearances.some(a => mediaId(a) === id);
    if (!sameMedia && documentUrl(link.url) !== url) continue;
    const publication = store.get(link.publicationId);
    if (publication?.url === link.url) reviews.push(publication);
  }
  return linkedPublicationRecords(reviews, store, links);
}

const DOCUMENT_WORD = String.raw`(?:depesz|artykul|material|komunikat|dokument|raport|tekst|wpis|publikacj|opracowan)\w*`;

function asksForIdentity(question: string) {
  const folded = foldForMatch(question);
  return new RegExp("\\b" + DOCUMENT_WORD).test(folded)
    && /\b(?:t(?:a|e|ej|en|ego|ym|o) sam\w*|inn[ayąe]\w*|identyczn\w*|zgodn\w*|dopas\w*)\b/.test(folded);
}

const META_TERM = /^(?:naglow|depesz|komunikat|raport|artykul|dokument|material|publikac|analiz|prasow|temat|informacj|factcheck|claimreview|generated)/;

/** Editorial subject tags are independent of the headline. Where absent, use words from the body outside the headline. */
function subjectTerms(record: CorpusRecord, article: string): { covered: boolean; labels: string[] } {
  const tags = record.topics.filter(tag => !tag.includes(":") && !tag.includes("-"));
  const keyTerms = (value: string) => contentWords(value).filter(w => w.length >= 4 && !META_TERM.test(w));
  let topics = tags.map(label => ({ label, terms: keyTerms(label) })).filter(t => t.terms.length);
  if (!topics.length) topics = Array.from(new Set(keyTerms(foldForMatch(record.text).replace(foldForMatch(record.title), ""))))
    .map(label => ({ label, terms: [label] }));
  const observed = contentWords(article);
  const matched = topics.filter(t => t.terms.every(w => observed.some(token => token.startsWith(stemToken(w, record.lang === "en" ? "en" : "pl") ?? w))));
  return { covered: matched.length >= Math.min(2, topics.length) && matched.length > 0, labels: matched.map(t => t.label) };
}

interface DocumentPair { review: CorpusRecord; document: CorpusRecord }

function candidateDocuments(records: CorpusRecord[], store: CorpusStore, links: PublicationLink[]): DocumentPair[] {
  const pairs: DocumentPair[] = [];
  for (const review of records.filter(r => r.type === "factcheck")) {
    const bibliography = links.find(l => l.publicationId === review.id && l.url === review.url);
    const explicit = store.getMany(bibliography?.documents ?? []);
    // A review may quote the full headline or include the direct URL without an editorial link record.
    const quoted = Array.from(review.text.matchAll(/[„«"]([^”»"\n]+)[”»"]/gu), m => foldForMatch(m[1]!));
    const urls = [...review.text.matchAll(/https?:\/\/[^\s<>"”]+/giu)].map(m => documentUrl(m[0].replace(/[.,;)]*$/, "")));
    for (const primary of records.filter(r => r.type === "pierwotne")) {
      if (urls.includes(documentUrl(primary.url)) || (primary.title.length > 15 && quoted.includes(foldForMatch(primary.title)))) {
        explicit.push(primary);
      }
    }
    for (const document of explicit) {
      if (document.publishedAt && !pairs.some(p => p.review.id === review.id && p.document.id === document.id)) pairs.push({ review, document });
    }
  }
  return pairs;
}

/** Accept dates syntactically attributed to the referenced document, independently of a repost timestamp. */
function documentDates(body: string, headline: string): string[] {
  const ownDate = new RegExp(
    "(?:\\b" + DOCUMENT_WORD + "(?: (?:agencji )?[a-z]{2,6})? (?:jest |byl[aoy]? )?(?:z(?: dnia)?|datowan\\w*|opublikowan\\w*)|"
    + "\\bdata (?:publikacji |wydania )?" + DOCUMENT_WORD + ") ?(?:na |dnia |w dniu )?$",
  );
  const result = new Set<string>();
  for (const line of body.split("\n")) {
    for (const date of printedDates(line)) {
      const prefix = foldForMatch(line.slice(0, line.indexOf(date)));
      const day = foldForMatch(date);
      const full = foldForMatch(line);
      if (ownDate.test(prefix) || full === day + " " + headline || full === headline + " " + day) result.add(date);
    }
  }
  return [...result];
}

const phraseQuotes = (text: string) => Array.from(text.matchAll(/[„«"]([^”»"\n]+)[”»"]/gu), m => m[1]!);
const namedHeadlines = (text: string) => [...new Set(Array.from(text.matchAll(/(?:tytuł|nagłówek)(?:\s+[\p{L}-]+){0,4}\s*[:–—]\s*[„«"]([^”»"\n]+)[”»"]/giu), m => m[1]!))];

function comparePair(input: NormalizedInput, pair: DocumentPair) {
  const { document } = pair;
  const title = foldForMatch(document.title);
  const body = input.attachmentText ?? "";
  const pageTitle = input.pageTitle ?? "";
  const originalPublisher = URL.parse(input.submittedUrl ?? "")?.hostname.replace(/^www\./, "") === new URL(document.url).hostname.replace(/^www\./, "");
  const directPage = originalPublisher && !!URL.parse(input.submittedUrl ?? "")?.pathname.replace(/\//g, "");
  const recordedTitles = namedHeadlines(body);
  const explicitTitle = recordedTitles[0];
  const ownTitle = foldForMatch(pageTitle) === title
    || [" | ", " – ", " — "].some(separator => foldForMatch(pageTitle.split(separator)[0]!) === title);
  const titledLine = body.split("\n").some(l => foldForMatch(l.replace(printedDates(l)[0] ?? "", "")) === title);
  const headlineMatch = explicitTitle ? foldForMatch(explicitTitle) === title
    : ownTitle || (!directPage && (phraseQuotes(body).some(s => foldForMatch(s) === title) || titledLine));
  const subject = subjectTerms(document, foldForMatch(body).replaceAll(title, ""));
  const expectedDate = document.publishedAt!.slice(0, 10);
  const dates = documentDates(body, title);
  if (input.pagePublishedAt && directPage) dates.push(input.pagePublishedAt.slice(0, 10));
  const dayMatch = dates.some(d => samePrintedDay(d, expectedDate));
  const differentDay = dates.some(d => !samePrintedDay(d, expectedDate));
  const differentTitle = !headlineMatch && (explicitTitle || (directPage && pageTitle));
  const publisherWords = contentWords(document.publisher);
  const acronym = publisherWords.map(w => w[0]).join("");
  const questionWords = contentWords(input.userNote ?? "");
  const publisherNamed = (acronym.length > 1 && questionWords.includes(acronym))
    || (publisherWords.length > 0 && publisherWords.every(w => questionWords.includes(w)));
  return { headlineMatch, subject, expectedDate, dates, dayMatch, differentDay, differentTitle, recordedTitles,
    relevance: Number(headlineMatch) * 8 + Number(subject.covered) * 4 + Number(directPage) * 2 + Number(publisherNamed) };
}

export function compareReviewedDocument(input: NormalizedInput, records: CorpusRecord[], store: CorpusStore, links = publicationLinks()): PublishedAnswer | undefined {
  if (input.kind !== "url" || !asksForIdentity(input.userNote ?? "")) return;
  const ranked = candidateDocuments(records, store, links).map(pair => ({ pair, ...comparePair(input, pair) }))
    .filter(r => r.relevance > 0).sort((a, b) => b.relevance - a.relevance);
  const top = ranked[0];
  if (!top) return { answerPl: "Nie udało mi się ustalić, z którym sprawdzonym dokumentem porównać wpis. Podaj tytuł dokumentu lub odnośnik do weryfikacji.", evidence: [] };
  if (top.recordedTitles.length > 1 || (ranked[1]?.relevance === top.relevance && ranked[1].pair.document.id !== top.pair.document.id)) {
    return { answerPl: "Znalazłem kilka możliwych materiałów. Wskaż tytuł dokumentu, który mam porównać.", evidence: [] };
  }
  const { review, document } = top.pair;
  const evidence = [review, document].map(r => ({ ...answerEvidenceItem(r, truncateWords(r.claimReviewed ?? r.text, 295)), relation: "INNY_KONTEKST" as const, group: "kontekst" as const }));
  const day = formatDatePl(top.expectedDate) + " r.";
  const reference = `Materiał wskazany w weryfikacji nosi tytuł „${document.title}”. Data publikacji to ${day}`;
  if (top.headlineMatch && top.subject.covered && top.dayMatch && !top.differentDay) {
    return { answerPl: `Tak. Zgadzają się nagłówek „${document.title}”, data ${day} i temat (${top.subject.labels.join(", ")}).`, evidence };
  }
  if (top.differentTitle || (!top.dayMatch && top.differentDay)) {
    const reason = top.differentTitle ? `Materiał ma inny nagłówek („${truncateWords(top.differentTitle, 150)}”).`
      : `We wpisie podano inną datę dokumentu (${top.dates.join(", ")}).`;
    return { answerPl: `Nie. ${reason} ${reference}`, evidence };
  }
  const missing = [!top.headlineMatch && "tytułu", !top.subject.covered && "tematu", (!top.dayMatch || top.differentDay) && "daty dokumentu"].filter(Boolean);
  return { answerPl: `Nie udało mi się potwierdzić, że chodzi o ten sam materiał. Brakuje jednoznacznego dopasowania ${missing.join(", ")}. ${reference}`, evidence };
}

export function screenshotClaim(input: NormalizedInput): string {
  return (input.attachmentText ?? "").split("\n").filter(line => {
    if (/^\s*@[\w.]+\s*$/u.test(line) || /^(?:udostepnij|polub|komentarze|skomentuj|odpowiedz|pokaz wiecej|obserwuj)$/.test(foldForMatch(line))) return false;
    const day = printedDates(line)[0];
    if (!day) return true;
    const rest = foldForMatch(line.replace(day, "").replace(/\b\d{1,2}:\d{2}\b/g, ""));
    return !["", "r", "data", "data postu", "data wpisu", "opublikowano", "godz"].includes(rest);
  }).join("\n").trim();
}

export function withScreenshotReading(input: NormalizedInput, answer: PublishedAnswer): PublishedAnswer {
  const transcript = (input.attachmentText ?? "").replace(/\s+/g, " ").trim();
  if (input.kind !== "image" || !transcript) return answer;
  const literal = truncateWords(transcript, 260);
  const dates = input.visibleDates ?? [];
  const dateNote = dates.length ? ` ${dates.length === 1 ? "Data widoczna na zrzucie" : "Daty widoczne na zrzucie"} (${dates.join(", ")}) ${dates.length === 1 ? "nie potwierdza" : "nie potwierdzają"} daty publikacji wpisu.` : "";
  return { ...answer, answerPl: `Na zrzucie odczytuję „${literal}${literal.length < transcript.length ? "…" : ""}”.${dateNote}\n\n${answer.answerPl}` };
}
