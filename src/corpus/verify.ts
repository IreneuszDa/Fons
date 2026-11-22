import { publicationLinks } from "./publication-links";
/**
 * Audyt „dosłowności”: dla rekordów z treścią ze stron/PDF sprawdza, że tekst rekordu jest podciągiem
 * ponownie odczytanego źródła (z cache'u pobrań w .cache/corpus/, bez nowych żądań sieciowych).
 * Uruchomienie: npx tsx src/corpus/verify.ts
 * Rekordy ClaimReview są sprawdzane względem feedu, EUvsDisinfo względem listy HTML w cache.
 * Dla metadanych z EUvsDisinfo MCP sprawdzana jest tylko struktura, bo odpowiedzi MCP nie są zapisywane w cache.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readCorpus } from "./files";
import { blockText, parseHtmlPage, plainPageText, squash } from "./ingest/common";
import { parseFactCheckResponse, ratingLabel, searchUrl } from "./ingest/demagog";
import { archiveQueries, archiveSearchUrl } from "./ingest/published-reviews";
import { downloadFeed, iterateFeedItems } from "./ingest/claimreview";
import { cleanPdfText } from "./ingest/eli";
import { parseCases } from "./ingest/euvsdisinfo";
import { EUVSDISINFO_MCP_TOPIC } from "./ingest/euvsdisinfo-mcp";
import { paths } from "./paths";

function cacheKey(url: string, accept: string): string {
  return createHash("sha1").update(url + "\n" + accept).digest("hex");
}

function readCachedBody(url: string, accept: string, headers?: Record<string, string>): string | null {
  const file = resolve(paths.cacheDir(), cacheKey(url, accept + JSON.stringify(headers ?? {})) + ".json");
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, "utf8")) as { body: string }).body;
}

function cachedBinaryPath(url: string): string | null {
  const file = resolve(paths.cacheDir(), cacheKey(url, "*/*#bin") + ".json");
  return existsSync(file) ? file : null;
}

/** Indeks cache'u po adresie końcowym (po przekierowaniach) — rekordy mają url = finalUrl. */
let finalUrlIndex: Map<string, string> | null = null;
function bodyByFinalUrl(url: string): string | null {
  if (!finalUrlIndex) {
    finalUrlIndex = new Map();
    const dir = paths.cacheDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f.startsWith("claimreview")) continue;
        try {
          const j = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as { finalUrl?: string; contentType?: string };
          if (j.finalUrl && /html/.test(j.contentType ?? "")) finalUrlIndex.set(j.finalUrl, resolve(dir, f));
        } catch {
          /* pomiń */
        }
      }
    }
  }
  const file = finalUrlIndex.get(url);
  return file ? (JSON.parse(readFileSync(file, "utf8")) as { body: string }).body : null;
}

const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5";

/**
 * Recenzje Demagoga z zapisanych odpowiedzi Google Fact Check Tools API (te same strony wyników, które pobrał ingestor;
 * bez sieci i bez klucza — klucz jest nagłówkiem `secretHeaders`, więc nie wchodzi do nazwy pliku cache'u):
 * `${url}|${teza}` → surowa ocena tekstowa.
 */
function cachedDemagogReviews(): Map<string, string> {
  const out = new Map<string, string>();
  for (const query of archiveQueries()) {
    const body = readCachedBody(archiveSearchUrl(query), "application/json");
    if (!body) continue;
    for (const review of parseFactCheckResponse(JSON.parse(body)).reviews) out.set(`${review.url}|${review.claim}`, review.rating);
  }
  let token: string | null = null;
  for (let page = 0; page < 100; page++) {
    const body = readCachedBody(searchUrl(token), "application/json");
    if (!body) break;
    const parsed = parseFactCheckResponse(JSON.parse(body));
    for (const r of parsed.reviews) out.set(`${r.url}|${r.claim}`, r.rating);
    token = parsed.nextPageToken;
    if (!token) break;
  }
  return out;
}
let demagogReviews: Map<string, string> | undefined;

/** Rekordy z feedu ClaimReview: teza i uzasadnienie muszą być dosłownie w oryginalnym wpisie feedu (z cache'u). */
export async function verifyClaimReview(log: (m: string) => void = console.log): Promise<{ checked: number; failed: { id: string; why: string }[] }> {
  const { records } = readCorpus();
  const fc = records.filter((r) => r.role === "stala_rola" && r.sourceId !== "euvsdisinfo" && r.sourceId !== "demagog");
  const byUrl = new Map<string, typeof fc>();
  for (const r of fc) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  const feed = await downloadFeed(false, log);
  const failed: { id: string; why: string }[] = [];
  const found = new Set<string>();
  for await (const it of iterateFeedItems(feed.file)) {
    const list = it.url ? byUrl.get(it.url) : undefined;
    if (!list || !it.claimReviewed) continue;
    const claim = squash(it.claimReviewed);
    for (const r of list) {
      if (r.claimReviewed !== claim) continue;
      found.add(r.id);
      const raw = it.reviewRating?.alternateName ?? it.reviewRating?.textualRating ?? "";
      const hay = squash(`${claim}\n${it.reviewRating?.ratingExplanation ?? ""}\n${raw}`.replace(/\n/g, " "));
      const lines = r.text.split("\n").map(squash).filter(Boolean);
      const missing = lines.filter((l) => !hay.includes(l));
      if (missing.length) failed.push({ id: r.id, why: `nie znaleziono w feedzie: „${missing[0]!.slice(0, 100)}”` });
      if (!raw.includes(r.rating!.raw)) failed.push({ id: r.id, why: `etykieta oceny "${r.rating!.raw}" spoza pola oceny feedu` });
    }
  }
  for (const r of fc) if (!found.has(r.id)) failed.push({ id: r.id, why: "wpis nie znaleziony w feedzie" });
  log(`ClaimReview: sprawdzono ${found.size} z ${fc.length} rekordów, niezgodnych: ${failed.length}`);
  for (const f of failed.slice(0, 20)) log(`  ${f.id}: ${f.why}`);
  return { checked: found.size, failed };
}

/** EUvsDisinfo: porównanie tytułu i daty z cache listy HTML oraz kontrola struktury rekordów MCP. */
export function verifyEuvsdisinfo(log: (m: string) => void = console.log): { checked: number; failed: { id: string; why: string }[] } {
  const known = new Map<string, { title: string; date: string | null; prefix: string }>();
  bodyByFinalUrl("https://euvsdisinfo.eu/"); // inicjalizacja indeksu
  for (const [url, file] of finalUrlIndex ?? []) {
    if (!url.startsWith("https://euvsdisinfo.eu/disinformation-cases/")) continue;
    const body = (JSON.parse(readFileSync(file, "utf8")) as { body: string }).body;
    for (const e of parseCases(body)) known.set(`https://euvsdisinfo.eu${e.href}`, { title: e.title, date: e.date, prefix: e.prefix });
  }
  const failed: { id: string; why: string }[] = [];
  let checked = 0;
  let mcp = 0;
  for (const r of readCorpus().records.filter((x) => x.sourceId === "euvsdisinfo")) {
    if (r.topics.includes(EUVSDISINFO_MCP_TOPIC)) {
      mcp++;
      if (r.text !== r.claimReviewed || r.rating) failed.push({ id: r.id, why: "nieprawidłowe metadane przypadku z MCP" });
      continue; // odpowiedzi MCP nie są zapisywane w cache
    }
    const k = known.get(r.url);
    checked++;
    if (!k) failed.push({ id: r.id, why: "brak wpisu na zapisanych stronach wyników" });
    else if (r.claimReviewed !== k.title || r.text !== `${k.prefix}: ${k.title}` || r.publishedAt !== k.date) failed.push({ id: r.id, why: "tytuł/data niezgodne z listą" });
  }
  log(`EUvsDisinfo: porównano ${checked} rekordów z listą HTML, sprawdzono strukturę ${mcp} z MCP, niezgodnych: ${failed.length}`);
  return { checked, failed };
}

export function verifyAll(log: (m: string) => void = console.log): { checked: number; failed: { id: string; why: string }[]; skipped: number } {
  const { records } = readCorpus();
  const failed: { id: string; why: string }[] = [];
  let checked = 0;
  let skipped = 0;
  const pdfCache = new Map<string, string>();
  for (const r of records) {
    try {
      let haystack: string | null = null;
      const pieces = r.text.split("\n").map(squash).filter(Boolean);
      if (r.topics.includes("generated-from-data")) {
        // Zdania generowane z pól danych (Eurostat, API Sejmu, API PE, rejestr placówek) — pola sprawdzają testy struktury.
        skipped++;
        continue;
      }
      if (r.sourceId === "demagog" && r.origin === "corpus") {
        // Recenzja z Google Fact Check Tools API: tekst = teza dosłownie z odpowiedzi API, etykieta oceny z pola textualRating.
        // (Rekordy z pakietu organizatora, origin "organizer", sprawdza się względem pakietu, nie API.)
        if (demagogReviews === undefined) demagogReviews = cachedDemagogReviews();
        const raw = demagogReviews.get(`${r.url}|${r.claimReviewed}`);
        if (raw === undefined) {
          failed.push({ id: r.id, why: "recenzji nie ma w zapisanej odpowiedzi Fact Check Tools API" });
          continue;
        }
        checked++;
        const cited = publicationLinks().find(link => link.publicationId === r.id && link.url === r.url)?.excerpts ?? [];
        if (r.text !== [r.claimReviewed, ...cited].join("\n")) failed.push({ id: r.id, why: "tekst nie zgadza się z tezą z API i przypisanymi cytatami" });
        else if (ratingLabel(raw) !== r.rating?.raw) failed.push({ id: r.id, why: `etykieta oceny "${r.rating?.raw}" niezgodna z API ("${raw}")` });
        continue;
      }
      if (r.sourceId === "prezydent-pl" || r.sourceId === "senat-pl" || r.sourceId === "ec-commission") {
        const body = bodyByFinalUrl(r.url) ?? readCachedBody(r.url, DEFAULT_ACCEPT);
        if (body) {
          const spaced = plainPageText(body);
          const joined = plainPageText(body, "");
          // Rekord przechodzi, gdy każda linia tekstu jest w którymś z dwóch odczytów (patrz niżej: haystack = oba połączone).
          haystack = pieces.every((c) => spaced.includes(c)) ? spaced : joined;
        }
      } else if (r.sourceId === "sejm-eli") {
        const m = /\/eli\/acts\/(.+?)\/text\/([UO])\/(.+\.pdf)/.exec(r.url);
        if (m) {
          const url = `https://api.sejm.gov.pl/eli/acts/${m[1]}/text/${m[2]}/${m[3]}`;
          if (!pdfCache.has(url)) {
            const file = cachedBinaryPath(url);
            const text = file ? execFileSync("pdftotext", ["-enc", "UTF-8", file, "-"], {
              encoding: "utf8", maxBuffer: 1 << 28, timeout: 90_000,
            }) : "";
            pdfCache.set(url, squash(cleanPdfText(text).replace(/\n/g, " ")));
          }
          haystack = pdfCache.get(url) || null;
          // Podpis Marszałka Sejmu: krótka linia (< 40 znaków) — sprawdzamy ją wprost, nie przez filtr zdań PDF.
          if (haystack && r.topics.includes("marszalek-sejmu") && !haystack.includes(squash(r.text))) {
            failed.push({ id: r.id, why: `nie znaleziono podpisu w PDF: „${r.text}”` });
          }
        } else {
          const body = readCachedBody(r.url.split("#")[0]!, DEFAULT_ACCEPT) ?? bodyByFinalUrl(r.url.split("#")[0]!);
          if (body) haystack = squash(blockText(parseHtmlPage(body).document.body).replace(/\n/g, " "));
        }
      } else if (r.sourceId === "nato" || r.sourceId === "eu-portal" || r.sourceId === "eeas" || r.sourceId === "gov-pl") {
        const body = bodyByFinalUrl(r.url) ?? readCachedBody(r.url, DEFAULT_ACCEPT);
        if (body) {
          const sel = r.sourceId === "nato" ? ".article-text-wrapper" : r.sourceId === "gov-pl" ? "article.article-area__article" : "main";
          haystack = squash(parseHtmlPage(body, sel).text.replace(/\n/g, " "));
          // NATO: lista "Państwo\nrok" jest łączona w jedną linię
          if (r.sourceId === "nato") haystack = haystack.replace(/ (\d{4})(?= |$)/g, " $1");
        }
      } else if (r.sourceId === "eur-lex") {
        const m = /CELEX:([^&]+)$/.exec(r.url);
        const celex = m ? m[1]! : "";
        const body = readCachedBody(`http://publications.europa.eu/resource/celex/${encodeURIComponent(celex)}`, "application/xhtml+xml", { "Accept-Language": "pol" });
        if (body) {
          const lines = blockText(parseHtmlPage(body).document.body)
            .split("\n")
            .filter((l) => !/^[▼►◄]/.test(l));
          haystack = squash(lines.join(" "));
        }
      } else {
        skipped++;
        continue;
      }
      if (!haystack) {
        failed.push({ id: r.id, why: "brak źródła w cache" });
        continue;
      }
      checked++;
      // Dla PDF dopuszczamy rozbicie przez nagłówki stron — sprawdzamy zdania; dla HTML cały kawałek.
      const candidates = r.url.endsWith(".pdf") ? squash(pieces.join(" ")).split(/(?<=[.;:])\s+/).filter((s) => s.length > 40) : pieces;
      const missing = candidates.filter((c) => !haystack!.includes(c));
      const allowed = r.url.endsWith(".pdf") ? Math.floor(candidates.length * 0.1) : 0;
      if (missing.length > allowed) failed.push({ id: r.id, why: `nie znaleziono w źródle: „${missing[0]!.slice(0, 100)}”` });
    } catch (e) {
      failed.push({ id: r.id, why: (e as Error).message });
    }
  }
  log(`Sprawdzono ${checked} rekordów, pominięto ${skipped}, niezgodnych: ${failed.length}`);
  for (const f of failed.slice(0, 30)) log(`  ${f.id}: ${f.why}`);
  return { checked, failed, skipped };
}

const isMain = process.argv[1] && /verify\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const res = verifyAll();
  const eu = verifyEuvsdisinfo();
  verifyClaimReview().then((cr) => process.exit(res.failed.length || cr.failed.length || eu.failed.length ? 1 : 0));
}
