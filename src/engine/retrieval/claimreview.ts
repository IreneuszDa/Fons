/**
 * ClaimReview (schema.org, JSON-LD) ze stron pobranych przez wyszukiwanie na żywo → rekordy o stałej roli z oceną.
 *
 * Fact-checkerzy z katalogu z flagą `liveSearch: true` (np. Pravda, DW, dpa, FactCheck.org, PolitiFact) osadzają w stronie
 * blok `<script type="application/ld+json">` z obiektem ClaimReview (teza `claimReviewed` + ocena `reviewRating`).
 * Demagog ma `liveSearch: false`: jego recenzje trafiają do korpusu wyłącznie przez Google Fact Check Tools API
 * (src/corpus/ingest/demagog.ts), a ten moduł nie tworzy z jego stron żadnych rekordów.
 * Ten moduł zamienia każdy taki obiekt w CorpusRecord o roli `stala_rola` — tak samo jak ingestia korpusu
 * (src/corpus/ingest/claimreview.ts): tekst rekordu = teza dosłownie, ocena mapowana jawną tabelą
 * data/rating-map.yaml (mapRating), więc reguła 6 werdyktu (decisive.ts, rules.ts) traktuje go jak rekord z korpusu.
 *
 * Zasady bezpieczeństwa (JSON-LD to niezaufana treść strony):
 *  - rekordy powstają WYŁĄCZNIE dla źródła katalogu typu `factcheck` (lub o roli `stala_rola`) — strona urzędowa
 *    z osadzonym ClaimReview nie zyskuje oceny;
 *  - poziom / typ / wydawca / grupa niezależności / licencja / adres — tylko z wpisu katalogu DOKŁADNEGO hosta końcowego
 *    i z adresu po przekierowaniach; pola JSON-LD `author`, `publisher`, `url`, `name` są ignorowane;
 *  - teza, ocena i autor wypowiedzi przechodzą przez detektor ataków; trafienie high = recenzja odrzucona, każde trafienie
 *    zgłaszane przez `onSecurityEvent` (w live.ts: ta sama ścieżka co trafienia na stronie);
 *  - limity: ≤ 5 recenzji ze strony, teza ≤ 600 znaków, ocena ≤ 120 znaków; tagi i encje HTML usuwane;
 *    uszkodzony JSON = blok pominięty; funkcje nigdy nie rzucają.
 */
import { guessLang, sourceLanguageTag } from "../../shared/language";
import { createHash } from "node:crypto";
import { extractRatingLabel, mapRating } from "../../corpus/ratings";
import { detectInjection } from "../../security/detector";
import { stripInvisible } from "../../security/text";
import type { CatalogSource, CorpusRecord, DetectorHit } from "../../shared/contracts";
import { scorePassages, type ScoredPassage } from "./live-score";
import { LIVE_ID_PREFIX } from "./live-store";

export const CLAIMREVIEW_MAX_PER_PAGE = 5;
export const CLAIMREVIEW_MAX_CLAIM_CHARS = 600;
export const CLAIMREVIEW_MAX_RATING_CHARS = 120;
/** Etykieta oceny dłuższa niż to = opis z etykietą na początku (np. DW) — wyciągamy samą etykietę. */
const LONG_LABEL_CHARS = 60;
const MAX_AUTHOR_CHARS = 120;
/** Ochrona przed patologicznym JSON-LD: limit odwiedzonych węzłów na blok i głębokości zagnieżdżenia. */
const MAX_NODES_PER_BLOCK = 5000;
const MAX_DEPTH = 8;

export interface ParsedClaimReview {
  lang?: string;
  /** Public materials identified by the publisher as appearances of this specific claim. */
  appearances?: string[];
  /** Teza sprawdzana przez fact-checkera (bez HTML, ≤ 600 znaków). */
  claimReviewed: string;
  /** Etykieta oceny (reviewRating.alternateName → textualRating → name; długi opis → sama etykieta), ≤ 120 znaków. */
  ratingRaw: string;
  /** datePublished recenzji (surowy napis z JSON-LD) albo null. */
  datePublished: string | null;
  /** Autor sprawdzanej wypowiedzi (itemReviewed.author.name) albo null. */
  claimAuthor: string | null;
}

// ───────────────────────────── czyszczenie napisów ─────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
  oacute: "ó", Oacute: "Ó", eacute: "é", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (_, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      const ok = Number.isFinite(cp) && cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && !(cp >= 0x7f && cp < 0xa0);
      return ok ? String.fromCodePoint(cp) : "";
    }
    return NAMED_ENTITIES[ent] ?? ""; // nieznana encja nazwana — usuwana
  });
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ");

/** Tagi i encje HTML → tekst; znaki niewidoczne i sterujące usunięte. Białe znaki NIE są jeszcze zwijane. */
function htmlToText(s: string): string {
  return stripInvisible(stripTags(decodeEntities(stripTags(s)))).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Skraca do `max` znaków na granicy zdania lub słowa (jak clipVerbatim w ingestii) — wynik to dosłowny początek tekstu. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("; "));
  if (sentenceEnd > max * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}

function cleanString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = squash(htmlToText(v));
  return s ? clip(s, max) : null;
}

// ───────────────────────────── parsowanie JSON-LD ─────────────────────────────

type Node = Record<string, unknown>;

function isClaimReviewType(t: unknown): boolean {
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && /(?:^|[/:#])ClaimReview$/.test(x.trim()));
}

/** Pierwszy obiekt z wartości będącej obiektem albo tablicą obiektów. */
function firstObject(v: unknown): Node | undefined {
  const list = Array.isArray(v) ? v : [v];
  return list.find((x): x is Node => !!x && typeof x === "object" && !Array.isArray(x));
}

/** Wszystkie węzły ClaimReview w bloku: tablice, @graph i zagnieżdżenia (np. mainEntity), z limitem pracy. */
function collectClaimReviews(root: unknown): Node[] {
  const out: Node[] = [];
  let visited = 0;
  const walk = (x: unknown, depth: number) => {
    if (depth > MAX_DEPTH || visited >= MAX_NODES_PER_BLOCK || !x || typeof x !== "object") return;
    visited++;
    if (Array.isArray(x)) {
      for (const item of x) walk(item, depth + 1);
      return;
    }
    const node = x as Node;
    if (isClaimReviewType(node["@type"])) {
      out.push(node);
      return;
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, depth + 1);
  };
  walk(root, 0);
  return out;
}

function ratingLabelOf(cr: Node): string | null {
  const rating = firstObject(cr.reviewRating);
  if (!rating) return null;
  const raw = [rating.alternateName, rating.textualRating, rating.name].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof raw !== "string") return null;
  // „DW Fact check: False    Opis…” → „False”: etykietę wyciągamy PRZED zwinięciem białych znaków (extractRatingLabel
  // szuka podwójnej spacji / końca linii); maxLen 0 = wzorzec „Prefiks: etykieta” także dla krótkich pól.
  let text = htmlToText(raw).trim();
  text = extractRatingLabel(text, 0) ?? text;
  const label = squash(text);
  return label ? clip(label, CLAIMREVIEW_MAX_RATING_CHARS) : null;
}

function claimAuthorOf(cr: Node): string | null {
  const item = firstObject(cr.itemReviewed);
  if (!item) return null;
  const author = item.author;
  if (typeof author === "string") return cleanString(author, MAX_AUTHOR_CHARS);
  return cleanString(firstObject(author)?.name, MAX_AUTHOR_CHARS);
}

/** Treść bloków `<script type="application/ld+json">` — skan liniowy (bez wyrażenia z leniwym `[\s\S]*?`, które przy
 *  wielu niezamkniętych `<script` byłoby kwadratowe na stronie 2 MB). */
function* jsonLdBlocks(rawHtml: string): Generator<string> {
  const openRe = /<script\b/gi;
  const closeRe = /<\/script/gi;
  for (let m = openRe.exec(rawHtml); m; m = openRe.exec(rawHtml)) {
    const tagEnd = rawHtml.indexOf(">", m.index);
    if (tagEnd < 0) return;
    closeRe.lastIndex = tagEnd;
    const close = closeRe.exec(rawHtml);
    if (!close) return;
    const attrs = tagEnd - m.index <= 1000 ? rawHtml.slice(m.index + 7, tagEnd) : "";
    if (/\btype\s*=\s*["']?\s*application\/ld\+json/i.test(attrs)) yield rawHtml.slice(tagEnd + 1, close.index);
    openRe.lastIndex = close.index + 8;
  }
}

/**
 * Wszystkie ClaimReview osadzone w surowym HTML strony (bloki `application/ld+json`). Toleruje tablice, `@graph`,
 * `@type` jako napis lub tablicę; uszkodzony JSON = blok pominięty. Recenzje bez tezy lub bez oceny są pomijane,
 * duplikaty (ta sama teza i ocena) liczone raz; najwyżej 5 na stronę. Nigdy nie rzuca.
 */
export function extractClaimReviews(rawHtml: string): ParsedClaimReview[] {
  const out: ParsedClaimReview[] = [];
  if (typeof rawHtml !== "string" || !/ld\+json/i.test(rawHtml)) return out;
  const seen = new Set<string>();
  try {
    for (const block of jsonLdBlocks(rawHtml)) {
      let json: unknown;
      try {
        // Część serwisów owija JSON w komentarz HTML / CDATA.
        json = JSON.parse(block.replace(/^\s*(?:<!--|<!\[CDATA\[)/, "").replace(/(?:-->|\]\]>)\s*$/, ""));
      } catch {
        continue; // uszkodzony blok — pomijamy
      }
      for (const cr of collectClaimReviews(json)) {
        const claimReviewed = cleanString(cr.claimReviewed, CLAIMREVIEW_MAX_CLAIM_CHARS);
        const ratingRaw = ratingLabelOf(cr);
        if (!claimReviewed || !ratingRaw) continue;
        const key = `${claimReviewed}\u0000${ratingRaw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const appearance = firstObject(cr.itemReviewed)?.appearance;
        const appearances = (Array.isArray(appearance) ? appearance : [appearance]).slice(0, 20)
          .map(item => typeof item === "string" ? item : firstObject(item)?.url)
          .filter((url): url is string => typeof url === "string" && /^https?:\/\//iu.test(url) && url.length < 2048);
        const lang = sourceLanguageTag(cr.inLanguage);
        out.push({
          ...(lang && { lang }),
          ...(appearances.length && { appearances }),
          claimReviewed,
          ratingRaw,
          datePublished: cleanString(cr.datePublished, 40),
          claimAuthor: claimAuthorOf(cr),
        });
        if (out.length >= CLAIMREVIEW_MAX_PER_PAGE) return out;
      }
    }
  } catch {
    /* nic nie może zepsuć pobrania strony */
  }
  return out;
}

// ───────────────────────────── rekordy ─────────────────────────────

/** Czy recenzje z tego źródła mogą dostać ocenę (tylko fact-checkerzy / źródła o stałej roli z katalogu). */
export function acceptsClaimReviews(source: CatalogSource): boolean {
  return source.type === "factcheck" || source.role === "stala_rola";
}

/**
 * Etykieta do mapowania: pole w całości, gdy tabela je zna; „Etykieta. Uzasadnienie…” → początek, gdy tabela go zna
 * (jak w ingestii korpusu: Fact Check Tools API i feed ClaimReview); krótka nieznana etykieta zostaje (mapped = null); długi opis bez
 * znanej etykiety → null (recenzja pominięta).
 */
function resolveLabel(sourceId: string, raw: string, dataDir?: string): string | null {
  if (mapRating(sourceId, raw, dataDir).mapped !== null) return raw;
  const lead = /^([^.:!?\n]{2,40})[.:!?](?:\s|$)/.exec(raw)?.[1]?.trim();
  if (lead && mapRating(sourceId, lead, dataDir).mapped !== null) return lead;
  return raw.length <= LONG_LABEL_CHARS ? raw : null;
}

/** Data publikacji recenzji: RRRR-MM-DD dla samej daty (jak w korpusie), inaczej ISO; spoza 1990…jutro → null. */
function publishedDate(raw: string | null, now: Date): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now.getTime() + 86_400_000 || t < Date.UTC(1990, 0, 1)) return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/.exec(raw.trim());
  return day ? day[1]! : new Date(t).toISOString();
}

/** Stabilny identyfikator migawki ClaimReview (prefiks jak w live.ts; znacznik odróżnia go od fragmentu o tej samej treści). */
export function liveClaimReviewId(finalUrl: string, claimReviewed: string, ratingRaw: string): string {
  const hash = createHash("sha256").update(`claimreview\n${finalUrl}\n${claimReviewed}\n${ratingRaw}`).digest("hex").slice(0, 20);
  return `${LIVE_ID_PREFIX}${hash}`;
}

/**
 * Jedna recenzja → rekord o stałej roli (origin live_snapshot). Metadane wyłącznie z wpisu katalogu `source`
 * (dokładny host końcowy), adres = `finalUrl`. Zwraca null, gdy źródło nie przyjmuje ocen albo etykiety nie da się
 * odczytać. Detektora NIE uruchamia — robi to `claimReviewRecords`.
 */
export function buildClaimReviewRecord(
  review: ParsedClaimReview,
  source: CatalogSource,
  finalUrl: string,
  fetchedAt: Date,
  opts: { dataDir?: string; lang?: string } = {},
): CorpusRecord | null {
  if (!acceptsClaimReviews(source)) return null;
  const label = resolveLabel(source.id, review.ratingRaw, opts.dataDir);
  if (!label) return null;
  const claim = review.claimReviewed;
  return {
    id: liveClaimReviewId(finalUrl, claim, label),
    sourceId: source.id,
    url: finalUrl,
    title: `${source.publisher}${review.claimAuthor ? ` - wypowiedź: ${review.claimAuthor}` : ""}: ${clip(claim, 140)}`,
    publisher: source.publisher,
    publishedAt: publishedDate(review.datePublished, fetchedAt),
    fetchedAt: fetchedAt.toISOString(),
    lang: guessLang(claim, review.lang ?? opts.lang),
    text: claim,
    role: "stala_rola",
    type: source.type,
    level: source.level,
    independenceGroup: source.independenceGroup,
    licence: source.licence,
    claimReviewed: claim,
    rating: mapRating(source.id, label, opts.dataDir),
    topics: ["fact-check", "claimreview"],
    origin: "live_snapshot",
  };
}

export interface ClaimReviewRecordsInput {
  lang?: string;
  /** Surowy HTML strony (FetchedPage.rawHtml); brak = brak recenzji. */
  rawHtml: string | undefined;
  /** Wpis katalogu DOKŁADNEGO hosta końcowego. */
  source: CatalogSource;
  /** Adres po przekierowaniach. */
  finalUrl: string;
  fetchedAt: Date;
  /** Każde trafienie detektora w polach recenzji (high = recenzja odrzucona). */
  onSecurityEvent?: (hit: DetectorHit) => void;
  dataDir?: string;
}

/**
 * Pełna ścieżka dla live.ts: źródło przyjmuje oceny? → ClaimReview z JSON-LD → detektor na tezie, ocenie i autorze
 * (trafienie high = recenzja pominięta) → rekordy o stałej roli. Nigdy nie rzuca.
 */
export function claimReviewRecords(input: ClaimReviewRecordsInput): CorpusRecord[] {
  // Polityka katalogu: źródło z liveSearch=false (np. Demagog — wyłącznie przez Google Fact Check Tools API)
  // nigdy nie daje rekordów z pobrania na żywo, nawet gdyby strona trafiła tu inną drogą.
  if (!input.rawHtml || input.source.liveSearch !== true || !acceptsClaimReviews(input.source)) return [];
  const out: CorpusRecord[] = [];
  try {
    for (const review of extractClaimReviews(input.rawHtml)) {
      const fields = [review.claimReviewed, review.ratingRaw, review.claimAuthor].filter((f): f is string => !!f);
      const hits = fields.flatMap((f) => detectInjection(f, "fetched_page"));
      for (const h of hits) {
        try {
          input.onSecurityEvent?.(h);
        } catch {
          /* callback nigdy nie psuje gałęzi */
        }
      }
      if (hits.some((h) => h.severity === "high")) continue;
      const rec = buildClaimReviewRecord(review, input.source, input.finalUrl, input.fetchedAt, { dataDir: input.dataDir, lang: input.lang });
      if (rec) out.push(rec);
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Kandydaci z recenzji: tylko te, których teza pasuje do rdzeni twierdzenia (te same progi pokrycia co fragmenty),
 * z wynikiem wyższym niż najlepszy fragment — idą na początek listy (RRF liczy rangi). Zwraca nową listę
 * (recenzje, potem fragmenty); przycięcie do limitu zostaje po stronie wywołującego.
 */
export function withClaimReviews(scored: ScoredPassage[], reviews: CorpusRecord[], stems: string[]): ScoredPassage[] {
  const seen = new Set<string>();
  const unique = reviews.filter((r) => !!r.claimReviewed && !seen.has(r.id) && !!seen.add(r.id));
  if (unique.length === 0) return scored;
  const matched = scorePassages(unique.map((r) => ({ key: r.id, title: "", text: r.claimReviewed! })), stems);
  if (matched.length === 0) return scored;
  const top = scored.reduce((m, s) => Math.max(m, s.score), 0);
  const keys = new Set(matched.map((m) => m.key));
  return [...matched.map((m) => ({ ...m, score: top + 1 + m.score })), ...scored.filter((s) => !keys.has(s.key))];
}
