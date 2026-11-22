/**
 * Ingestia fact-checków z publicznego feedu ClaimReview DataCommons (Fact Check Markup Tool, CC BY 4.0):
 *   https://storage.googleapis.com/datacommons-feeds/claimreview/latest/data.json   (ok. 200 MB)
 * Feed jest pobierany raz (cache w .cache/), parsowany strumieniowo. Z rekordów bierzemy WYŁĄCZNIE
 * wydawców z katalogu (exact host) i tylko tematy zakresu korpusu (Polska, Ukraina, Rosja, Białoruś, NATO, UE,
 * sankcje, migracja/granica). Rekord ma rolę stala_rola: claimReviewed i ocena dosłownie z feedu, ocena
 * mapowana przez data/rating-map.yaml (nieznana => mapped null).
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CorpusRecord } from "../../shared/contracts";
import { sourceAtUrl } from "../catalog";
import { mapRating, extractRatingLabel } from "../ratings";
import { paths } from "../paths";
import {
  PoliteClient,
  USER_AGENT,
  type Incident,
  type IngestOptions,
  type IngestResult,
  MAX_QUOTE_CHARS,
  baseFromCatalog,
  clipVerbatim,
  guessLang,
  newResult,
  outletDomain,
  recordId,
  squash,
} from "./common";

export const FEED_URL = "https://storage.googleapis.com/datacommons-feeds/claimreview/latest/data.json";

interface ClaimReviewItem {
  "@type"?: string;
  author?: { name?: string; url?: string };
  claimReviewed?: string;
  datePublished?: string;
  inLanguage?: string;
  name?: string;
  itemReviewed?: {
    author?: { name?: string };
    datePublished?: string;
    appearance?: ({ url?: string } | string)[] | { url?: string };
    firstAppearance?: { url?: string };
  };
  reviewRating?: { alternateName?: string; ratingExplanation?: string; textualRating?: string };
  url?: string;
}

/** Ile rekordów z danego wydawcy bierzemy (po rankingu trafności). */
const CAPS: Record<string, number> = {
  "pravda-pl": 70,
  "dpa-factchecking": 60,
  "dw-factcheck": 45,
  "factcheck-org": 25,
  politifact: 25,
};

const TOPIC_RULES: { tag: string; re: RegExp; score: number }[] = [
  { tag: "polska", re: /\b(Poland|Polish|Warsaw|Polen|polnisch\w*|Polska|polsk\w*|Polsce|Polaków|Warszaw\w*|Sejm\w*|Tusk|Nawrocki|Duda|Morawiecki)\b/i, score: 3 },
  { tag: "nato", re: /\b(NATO|OTAN|Sojusz\w* Północnoatlantyck\w*|Bündnis)\b/i, score: 2 },
  { tag: "ue", re: /\b(EU|European Union|Brussels|Unii Europejskiej|Unia Europejska|UE|EU-|Europäische Union|Brüssel|Komisj\w+ Europejsk\w*)\b/i, score: 2 },
  { tag: "sankcje", re: /sanction|sankcj|Sanktion|embargo/i, score: 2 },
  { tag: "migracja", re: /migrant|migracj|uchodź|refugee|asylum|azyl|Flüchtling|Migrant|border|granic|Grenze/i, score: 2 },
  { tag: "bialorus", re: /Belarus|Białor|Lukashenko|Łukaszenk|Weißruss/i, score: 2 },
  { tag: "ukraina", re: /Ukrain|Zelensk|Zełensk|Kyiv|Kijów|Kiew|Donbas|Crimea|Krym/i, score: 1 },
  { tag: "rosja", re: /Russia|Rosj|rosyjsk|Putin|Kremlin|Kreml|Moscow|Moskw|Russland|russisch\w*/i, score: 1 },
  { tag: "wojna-w-ukrainie", re: /war in Ukraine|wojn\w+ (?:w|na) Ukrain|Krieg in der Ukraine|Ukraine war|Ukraine-Krieg|invasion/i, score: 1 },
  { tag: "wybory", re: /election|wybor|Wahl\w*|ballot|polling station/i, score: 1 },
  { tag: "energia", re: /\bgas\b|\boil\b|energy|energi|Gaz|ropa|Nord Stream|Erdgas|Energie/i, score: 1 },
  { tag: "dezinformacja", re: /disinformation|dezinformac|propaganda|Desinformation|fake news|deepfake/i, score: 1 },
];

function topicsAndScore(text: string): { tags: string[]; score: number } {
  const tags: string[] = [];
  let score = 0;
  for (const r of TOPIC_RULES) {
    if (r.re.test(text)) {
      tags.push(r.tag);
      score += r.score;
    }
  }
  return { tags, score };
}

/** Pobiera feed do cache (jednorazowo na dobę). Zwraca ścieżkę pliku i czas pobrania. */
export async function downloadFeed(refresh: boolean, log: (m: string) => void): Promise<{ file: string; fetchedAt: string; bytes: number }> {
  const file = resolve(paths.cacheDir(), "claimreview-feed.json");
  const metaFile = file + ".meta";
  if (!refresh && existsSync(file) && existsSync(metaFile)) {
    const meta = JSON.parse(await (await import("node:fs/promises")).readFile(metaFile, "utf8")) as { fetchedAt: string };
    return { file, fetchedAt: meta.fetchedAt, bytes: statSync(file).size };
  }
  mkdirSync(dirname(file), { recursive: true });
  // robots.txt hosta (jeśli istnieje) sprawdzamy tym samym klientem.
  const client = new PoliteClient({ refresh });
  if (!(await client.allowedByRobots(FEED_URL))) throw new Error("robots.txt zabrania pobrania feedu");
  log("  pobieram feed ClaimReview (ok. 200 MB)…");
  const res = await fetch(FEED_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} dla feedu ClaimReview`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  const fetchedAt = new Date().toISOString();
  writeFileSync(metaFile, JSON.stringify({ fetchedAt }));
  return { file, fetchedAt, bytes: statSync(file).size };
}

/**
 * Strumieniowo wydobywa obiekty `item` z tablicy `dataFeedElement`: śledzi głębokość nawiasów klamrowych
 * poza łańcuchami znaków. Każdy element tablicy to obiekt DataFeedItem.
 */
export async function* iterateFeedItems(file: string): AsyncGenerator<ClaimReviewItem> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let started = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let buf = "";
  let carryKey = "";
  for await (const chunk of stream as AsyncIterable<string>) {
    let i = 0;
    if (!started) {
      const text = carryKey + chunk;
      const idx = text.indexOf('"dataFeedElement"');
      if (idx < 0) {
        carryKey = text.slice(-40);
        continue;
      }
      const br = text.indexOf("[", idx);
      if (br < 0) {
        carryKey = text.slice(idx);
        continue;
      }
      started = true;
      carryKey = "";
      const rest = text.slice(br + 1);
      yield* scan(rest);
      continue;
    }
    yield* scan(chunk);
    i = 0;
    void i;
  }

  function* scan(text: string): Generator<ClaimReviewItem> {
    let segStart = -1;
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (inString) {
        if (escape) escape = false;
        else if (c === 92) escape = true;
        else if (c === 34) inString = false;
        continue;
      }
      if (c === 34) {
        inString = true;
        continue;
      }
      if (c === 123) {
        if (depth === 0) {
          segStart = k;
          buf = "";
        }
        depth++;
      } else if (c === 125) {
        depth--;
        if (depth === 0) {
          const piece = segStart >= 0 ? text.slice(segStart, k + 1) : text.slice(0, k + 1);
          const json = buf + piece;
          buf = "";
          segStart = -1;
          try {
            const el = JSON.parse(json) as { item?: ClaimReviewItem | ClaimReviewItem[] | null };
            const items = Array.isArray(el.item) ? el.item : el.item ? [el.item] : [];
            for (const it of items) if (it) yield it;
          } catch {
            /* uszkodzony element — pomiń */
          }
        }
      } else if (c === 93 && depth === 0) {
        return; // koniec tablicy dataFeedElement
      }
    }
    if (depth > 0) buf += segStart >= 0 ? text.slice(segStart) : text;
  }
}

function appearanceUrls(it: ClaimReviewItem): string[] {
  const a = it.itemReviewed?.appearance;
  const list = Array.isArray(a) ? a : a ? [a] : [];
  const urls: string[] = [];
  for (const x of list) {
    const u = typeof x === "string" ? x : x?.url;
    if (u) urls.push(u);
  }
  const fa = it.itemReviewed?.firstAppearance?.url;
  if (fa) urls.push(fa);
  return urls;
}

function isoDate(d?: string): string | null {
  if (!d) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/.exec(d.trim());
  if (m) return m[1]!;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface Candidate {
  sourceId: string;
  item: ClaimReviewItem;
  score: number;
  tags: string[];
  label: string;
  explanation?: string;
}

export async function ingestClaimReview(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("claimreview");
  const feed = await downloadFeed(opts.refresh, opts.log);
  opts.log(`  feed: ${(feed.bytes / 1e6).toFixed(0)} MB, pobrany ${feed.fetchedAt}`);
  result.requests = 1;

  const wanted = new Set(Object.keys(CAPS));
  const byHost = new Map<string, Candidate[]>();
  let total = 0;
  let inScope = 0;
  const unknownRating: Record<string, number> = {};

  for await (const item of iterateFeedItems(feed.file)) {
    total++;
    if (!item.url || !item.claimReviewed) continue;
    const src = sourceAtUrl(opts.catalog, item.url);
    if (!src || !wanted.has(src.id)) continue;
    const claim = squash(item.claimReviewed);
    const raw = item.reviewRating?.alternateName ?? item.reviewRating?.textualRating ?? "";
    const explanationRaw = item.reviewRating?.ratingExplanation;
    const { tags, score } = topicsAndScore(`${claim} ${raw.slice(0, 400)}`);
    // Zakres tematyczny: Polska zawsze; pozostałe wymagają co najmniej wyniku 2 (np. NATO/UE/sankcje/migracja
    // albo Ukraina+Rosja) — odfiltrowuje przypadkowe wzmianki.
    const isPlSource = src.id === "pravda-pl";
    const polska = tags.includes("polska");
    const required = isPlSource ? 1 : 2;
    if (!(polska || score >= required)) continue;
    if (!isPlSource && !tags.some((t) => ["polska", "nato", "ue", "sankcje", "bialorus", "ukraina", "rosja", "migracja"].includes(t))) continue;
    inScope++;
    // Etykieta oceny: krótkie pole albo początek długiego opisu ("Falsch. Der Meeresspiegel..." / "DW Fact check: False ...").
    let label = extractRatingLabel(raw);
    let explanationFromRaw: string | undefined;
    if (!label || label.length > 60) {
      label = null;
      const lead = /^([^.:!?\n]{2,40})[.:!?]\s+(.+)$/s.exec(raw.trim());
      if (lead) {
        const candidate = lead[1]!.trim();
        const m = mapRating(src.id, candidate);
        // Z długiego opisu przyjmujemy tylko etykietę znaną tabeli mapowania (inaczej to zwykłe zdanie).
        if (m.mapped !== null) {
          label = candidate;
          explanationFromRaw = lead[2]!;
        }
      }
    } else if (label !== raw.trim()) {
      explanationFromRaw = raw.slice(raw.indexOf(label) + label.length).replace(/^[\s:.\-–]+/, "");
    }
    if (!label) {
      result.skipped.push({ what: item.url, reason: "brak czytelnej etykiety oceny (długi opis bez znanej etykiety)" });
      continue;
    }
    const mapped = mapRating(src.id, label);
    if (mapped.mapped === null) unknownRating[`${src.id}: ${label}`] = (unknownRating[`${src.id}: ${label}`] ?? 0) + 1;
    const explanation = explanationRaw ?? explanationFromRaw;
    const list = byHost.get(src.id) ?? [];
    list.push({ sourceId: src.id, item, score: score + (polska ? 3 : 0), tags, label, explanation });
    byHost.set(src.id, list);
  }
  opts.log(`  przeczytano ${total} wpisów feedu; w zakresie tematycznym i katalogu: ${inScope}`);

  for (const [sourceId, list] of byHost) {
    list.sort((a, b) => b.score - a.score || (b.item.datePublished ?? "").localeCompare(a.item.datePublished ?? ""));
    const cap = CAPS[sourceId] ?? 30;
    const chosen = list.slice(0, cap);
    const src = opts.catalog.find(s => s.id === sourceId)!;
    const base = baseFromCatalog(src);
    for (const c of chosen) {
      const it = c.item;
      const claim = squash(it.claimReviewed!);
      const explanation = c.explanation ? clipVerbatim(c.explanation, MAX_QUOTE_CHARS) : "";
      const text = explanation && explanation !== claim ? `${claim}\n${explanation}` : claim;
      const lang = guessLang(claim, it.inLanguage);
      const claimDate = isoDate(it.itemReviewed?.datePublished);
      const rec: CorpusRecord = {
        ...base,
        id: recordId(sourceId, `${it.url!}|${claim}`),
        url: it.url!,
        title: it.name ? squash(it.name) : `${src.publisher}: ${clipVerbatim(claim, 140)}`,
        publishedAt: isoDate(it.datePublished),
        fetchedAt: feed.fetchedAt,
        lang,
        text,
        claimReviewed: claim,
        rating: mapRating(sourceId, c.label),
        topics: ["fact-check", "claimreview", ...c.tags],
        period: claimDate ? claimDate.slice(0, 7) : undefined,
        origin: "corpus",
      };
      result.records.push(rec);
      // Incydent: narracje ocenione jako fałsz / wprowadzające w błąd.
      if (rec.rating?.mapped === "FALSZYWE" || rec.rating?.mapped === "WPROWADZAJACE") {
        // appearance w ClaimReview = miejsca, w których teza się POJAWIŁA (także media cytujące ją krytycznie lub oficjalne
        // wypowiedzi). To nie jest lista serwisów rozpowszechniających dezinformację, więc NIE trafia do domains
        // (trafienie domeny wywołuje ostrzeżenie w raporcie) — wpisujemy je tylko opisowo do streszczenia.
        const seenOn = [...new Set(appearanceUrls(it).map(outletDomain).filter((d): d is string => !!d))].slice(0, 5);
        const inc: Incident = {
          id: `claimreview:${rec.id.split(":")[1]}`,
          title: clipVerbatim(claim, 200),
          summary:
            `${src.publisher} oceniło tę tezę: ${c.label}.${explanation ? ` ${explanation}` : ""}` +
            (seenOn.length ? ` Teza pojawiła się m.in. w: ${seenOn.join(", ")}.` : ""),
          url: rec.url,
          domains: [],
          publishedAt: rec.publishedAt,
          recordId: rec.id,
        };
        result.incidents.push(inc);
      }
    }
    opts.log(`  ClaimReview ${sourceId}: ${chosen.length} rekordów (z ${list.length} pasujących)`);
  }
  const unk = Object.entries(unknownRating).sort((a, b) => b[1] - a[1]);
  if (unk.length) result.notes.push(`Oceny spoza tabeli mapowania (mapped=null, nie rozstrzygają): ${unk.slice(0, 12).map(([k, v]) => `${k} (${v})`).join("; ")}`);
  result.notes.push(
    `Feed ClaimReview: przeczytano ${total} wpisów; hosty spoza katalogu pominięte; tytuł rekordu = "wydawca: teza" (feed nie zawiera tytułu strony).`,
  );
  return result;
}
