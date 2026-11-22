import { benefitGuide, benefitGuidePassages } from "./ingest/benefit-rates";
import { REGISTER_TOPIC, registeredMembers } from "./ingest/member-register";
import { EU_COUNTRIES_URL, EURO_AREA_URL, parseCountryList, parseEuroArea } from "./ingest/eu-membership";
import { NATO_MEMBERS_URL, parseMemberList } from "./ingest/nato-data";
import { countryIdentity } from "../engine/retrieval/subject";
import { estimatePageText, expenditureRows, milexUrl } from "./ingest/research-estimates";
import { archivedRates, cpiListing, cpiPage, currentRates, parseCpiSeries, parseReferenceSeries } from "./ingest/monetary-statistics";
import { loadCatalog } from "./catalog";
import { isDeepStrictEqual } from "node:util";
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
import type { CorpusRecord } from "../shared/contracts";
import { recordId, sourceFromCatalog, blockText, parseHtmlPage, plainPageText, squash } from "./ingest/common";
import { parseFactCheckResponse, ratingLabel, searchUrl } from "./ingest/demagog";
import { archiveQueries, archiveSearchUrl } from "./ingest/published-reviews";
import { iterateFeedItems } from "./ingest/claimreview";
import { cleanPdfText } from "./ingest/eli";
import { parseCases } from "./ingest/euvsdisinfo";
import { EUVSDISINFO_MCP_TOPIC } from "./ingest/euvsdisinfo-mcp";
import { paths } from "./paths";
import { odyseuszSourceTexts } from "./odyseusz-evidence";

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
        if (!f.endsWith(".json") || f.startsWith("claimreview") || existsSync(resolve(dir, f + ".meta"))) continue;
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

/** Compare the full membership sets, including cardinality and identities, to the archived
 * publisher responses. A substituted country fails even if the number of rows stays the same. */
export function verifyMemberRegisters(records: CorpusRecord[], log: (m: string) => void = console.log) {
  const failed: { id: string; why: string }[] = [];
  let checked = 0;
  const cached = (url: string) => {
    const fn = resolve(paths.cacheDir(), cacheKey(url, DEFAULT_ACCEPT + "{}") + ".json");
    const response = JSON.parse(readFileSync(fn, "utf8")) as { status: number; finalUrl: string; body: string; fetchedAt: string };
    if (response.status !== 200 || response.finalUrl !== url) throw new Error("Brak oryginalnej odpowiedzi źródła");
    return response;
  };
  for (const org of ["UE", "NATO"] as const) {
    const rows = records.filter(r => r.topics.includes(REGISTER_TOPIC) && r.sourceId === (org === "UE" ? "eu-portal" : "nato"));
    if (rows.length !== 1) failed.push({ id: org, why: `Oczekiwano jednego poświadczonego wykazu, zapisano ${rows.length}` });
    for (const r of rows) {
      try {
        const primary = cached(r.url);
        const names: string[] = [];
        let declared: number | undefined;
        let fetchedAt = primary.fetchedAt;
        if (org === "NATO" && r.url === NATO_MEMBERS_URL) {
          const { text } = parseHtmlPage(primary.body, ".article-text-wrapper");
          declared = Number(/At present, NATO has (\d+) member countries\./u.exec(text)?.[1]);
          const lines = text.replace(/([^\n]+)\n((?:19|20)\d{2})(?=\n|$)/gu, "$1 $2").split("\n");
          const head = lines.indexOf("Alphabetical list of NATO member countries");
          const end = lines.indexOf("How each country became a NATO member", head + 1);
          if (head < 0 || end <= head || end - head - 1 !== declared) throw new Error("Niepełna sekcja członków NATO");
          names.push(...parseMemberList(lines).map(m => m.name));
        } else if (org === "UE" && r.url === EURO_AREA_URL) {
          const area = parseEuroArea(primary.body);
          const totals = area && /oficjalną walutą w (\d+) spośród (\d+) państw UE/u.exec(area.insideLead);
          if (!area?.denmark || !area.denmarkLead?.includes(area.denmark) || !totals ||
              !/^Wszystkie kraje UE należą do unii gospodarczej i walutowej/u.test(area.inside[0] ?? "") ||
              area.inside.length - 1 !== Number(totals[1])) throw new Error("Niepełny podział państw UE według waluty");
          names.push(...area.inside.slice(1), ...area.outside, area.denmark);
          declared = Number(totals[2]);
        } else if (org === "UE" && r.url === EU_COUNTRIES_URL) {
          const visited = new Set<string>();
          let url = r.url;
          while (url) {
            if (visited.has(url) || visited.size >= 100) throw new Error("Nieprawidłowa paginacja wykazu UE");
            visited.add(url);
            const response = url === r.url ? primary : cached(url);
            if (response.fetchedAt < fetchedAt) fetchedAt = response.fetchedAt;
            const doc = parseHtmlPage(response.body, "main").document;
            const main = doc.querySelector("main");
            const header = Array.from(main?.querySelectorAll("h2") ?? []).map(h => squash(h.textContent ?? ""))
              .map(h => /^Strony \((\d+)\)$/u.exec(h)).find(Boolean);
            const count = Number(header?.[1]);
            if (!count || (declared !== undefined && declared !== count)) throw new Error("Brak zgodnej liczby wyników UE");
            declared = count;
            const part = parseCountryList(response.body);
            if (!part.length || part.length !== main?.querySelectorAll("article.ecl-content-item").length) throw new Error("Niepełna strona wykazu UE");
            names.push(...part.map(row => countryIdentity(row.name) ? row.name : row.slug.replace(/-/gu, " ")));
            const next = main?.querySelector("a[aria-label='Przejdź do następnej strony']")?.getAttribute("href");
            if (next && !/^\?page=\d+$/u.test(next)) throw new Error("Nieprawidłowy adres kolejnej strony");
            url = next ? EU_COUNTRIES_URL + next : "";
          }
        } else throw new Error("Nieprawidłowy adres pełnego wykazu");
        const expected = names.map(countryIdentity);
        const stored = registeredMembers(r, org);
        checked++;
        if (!stored || expected.some(x => !x) || names.length !== declared || new Set(expected).size !== declared ||
            fetchedAt !== r.fetchedAt || stored.slice().sort().join("|") !== expected.sort().join("|")) {
          throw new Error("Państwa, liczba lub data odczytu nie odpowiadają publikacji");
        }
        log(`${org}: ${stored.length}/${declared} różnych państw zgodnych z publikacją`);
      } catch (e) { failed.push({ id: r.id, why: (e as Error).message }); }
    }
  }
  return { checked, failed };
}

/** Recreate all four input documents from the download cache. No request is made during audit. */
export function verifyMonetarySeries(records: CorpusRecord[], log: (m: string) => void = console.log) {
  const failed: { id: string; why: string }[] = [];
  let checked = 0;
  const catalog = loadCatalog();
  const page = (url: string) => {
    const name = resolve(paths.cacheDir(), cacheKey(url, DEFAULT_ACCEPT + "{}") + ".json");
    const response = JSON.parse(readFileSync(name, "utf8")) as { status: number; body: string; finalUrl: string; fetchedAt: string };
    if (response.status !== 200) throw new Error("Brak odpowiedzi HTTP 200 w kopii źródła");
    return response;
  };
  for (const id of ["gus-cpi", "nbp-rates"]) {
    const actual = new Map(records.filter(r => r.sourceId === id).map(r => [r.id, r]));
    try {
      const source = sourceFromCatalog(catalog, id);
      let expected: CorpusRecord[];
      if (id === "gus-cpi") {
        const listing = cpiListing(page(cpiPage));
        const file = cachedBinaryPath(listing.csv);
        if (!file) throw new Error("Brak oryginalnego pliku CSV GUS");
        const meta = JSON.parse(readFileSync(file + ".meta", "utf8")) as { finalUrl: string; fetchedAt: string };
        expected = parseCpiSeries(source, listing, { ...meta, data: readFileSync(file) });
      } else {
        expected = parseReferenceSeries(source, page(archivedRates), page(currentRates));
      }
      let matches = 0;
      for (const r of expected) {
        const stored = actual.get(r.id);
        if (!stored) failed.push({ id: r.id, why: "brak rekordu z okresu " + r.period });
        else {
          checked++;
          if (isDeepStrictEqual(stored, r)) matches++;
          else failed.push({ id: r.id, why: "rekord nie zgadza się z odczytem z oryginalnej tabeli za okres " + r.period });
        }
        actual.delete(r.id);
      }
      for (const extra of actual.keys()) failed.push({ id: extra, why: "brak rekordu w oryginalnej tabeli" });
      log(`${id}: zgodne wiersze korpusu ${matches}/${expected.length}, nadmiarowe ${actual.size}`);
    } catch (error) {
      failed.push({ id, why: (error as Error).message });
    }
  }
  return { checked, failed };
}

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
  const feedFile = resolve(paths.cacheDir(), "claimreview-feed.json");
  if (!existsSync(feedFile)) {
    log(`ClaimReview: brak zachowanego feedu, bez porównania ${fc.length} rekordów`);
    return { checked: 0, failed: fc.map(r => ({ id: r.id, why: "brak feedu w cache" })) };
  }
  const failed: { id: string; why: string }[] = [];
  const found = new Set<string>();
  for await (const it of iterateFeedItems(feedFile)) {
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

const auditedCollections = ["institutional-references", "published-documents", "research-estimates", "office-history", "energy-reports"] as const;
type AuditedCollection = typeof auditedCollections[number];

function collectionIds(): Map<string, AuditedCollection> {
  const ids = new Map<string, AuditedCollection>();
  for (const collection of auditedCollections) {
    const path = resolve(paths.corpusDir(), collection + ".jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as { id: string };
      ids.set(record.id, collection);
    }
  }
  return ids;
}

function cachedPage(url: string): string | null {
  return readCachedBody(url, DEFAULT_ACCEPT) ?? bodyByFinalUrl(url);
}

/** null = odrębna metodologia kontroli, [] = obsługiwane źródło, lecz brak kopii. */
function sourceTexts(r: CorpusRecord, collection?: AuditedCollection): string[] | null {
  const url = r.url.split("#")[0]!;
  if (r.sourceId === "msz-odyseusz") return odyseuszSourceTexts(r);
  if (collection === "research-estimates" && url === milexUrl) {
    const file = cachedBinaryPath(url);
    return file ? expenditureRows(readFileSync(file)).map(row => row.text) : [];
  }
  if (collection === "research-estimates" && r.sourceId === "iiss") {
    const body = cachedPage(url);
    return body ? [estimatePageText(body, r.sourceId)] : [];
  }
  const eliPdf = r.sourceId === "sejm-eli" && /\/eli\/acts\/(.+?)\/text\/([UO])\/(.+\.pdf)/.exec(url);
  if (eliPdf || (collection && (/\.pdf$/i.test(url) || Boolean(cachedBinaryPath(url))))) {
    const file = cachedBinaryPath(eliPdf ? `https://api.sejm.gov.pl/eli/acts/${eliPdf[1]}/text/${eliPdf[2]}/${eliPdf[3]}` : url);
    if (!file) return [];
    const raw = execFileSync("pdftotext", ["-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 90_000 });
    return [squash(eliPdf ? cleanPdfText(raw) : raw)];
  }
  if (r.sourceId === "eur-lex") {
    const celex = /CELEX:([^&]+)$/.exec(url)?.[1];
    if (!celex) return [];
    const body = readCachedBody(`http://publications.europa.eu/resource/celex/${encodeURIComponent(celex)}`, "application/xhtml+xml", { "Accept-Language": "pol" });
    if (!body) return [];
    return [squash(blockText(parseHtmlPage(body).document.body).split("\n").filter(line => !/^[▼►◄]/.test(line)).join(" "))];
  }
  if (collection || ["prezydent-pl", "senat-pl", "ec-commission"].includes(r.sourceId)) {
    const body = cachedPage(url);
    return body ? [plainPageText(body), plainPageText(body, "")] : [];
  }
  if (r.sourceId === "sejm-eli") {
    const body = cachedPage(url);
    return body ? [squash(blockText(parseHtmlPage(body).document.body))] : [];
  }
  const selectors: Record<string, string> = { nato: ".article-text-wrapper", "eu-portal": "main", eeas: "main", "gov-pl": "article.article-area__article" };
  if (selectors[r.sourceId]) {
    const body = cachedPage(url);
    return body ? [squash(parseHtmlPage(body, selectors[r.sourceId]).text)] : [];
  }
  return null;
}

/** Każdy fragment cytatu skróconego wielokropkiem redakcyjnym musi wystąpić w tej samej kolejności. */
function containsQuote(text: string, quote: string): boolean {
  let offset = 0;
  const fragments = quote.split(/\[(?:…|\.\.\.)\]/u).map(s => s.trim()).filter(Boolean);
  return fragments.length > 0 && fragments.every(fragment => {
    const index = text.indexOf(fragment, offset);
    if (index < 0) return false;
    offset = index + fragment.length;
    return true;
  });
}

export function verifyAll(log: (m: string) => void = console.log, only?: AuditedCollection): { checked: number; failed: { id: string; why: string }[]; skipped: number } {
  const { records, errors } = readCorpus();
  const failed: { id: string; why: string }[] = only ? [] : errors.map(why => ({ id: "corpus", why }));
  let checked = 0;
  let skipped = 0;
  if (!only) {
    const registers = verifyMemberRegisters(records, log);
    checked += registers.checked;
    failed.push(...registers.failed);
    const audit = verifyMonetarySeries(records, log);
    checked += audit.checked;
    failed.push(...audit.failed);
  }
  const groups = collectionIds();
  const links = new Map(publicationLinks().map(link => [link.publicationId, link]));
  const excerpts = { checked: 0, unavailable: 0, mismatched: 0 };
  const audited = new Set<string>();
  const normalized = new Map<string, string[] | null>();
  const passed = new Set<string>();
  for (const r of records) {
    if (r.sourceId === "gus-cpi" || r.sourceId === "nbp-rates" || r.topics.includes(REGISTER_TOPIC)) continue;
    const collection = groups.get(r.id);
    if (only && collection !== only) continue;
    if (collection) audited.add(r.id);
    try {
      const pieces = r.text.split("\n").map(squash).filter(Boolean);
      if (r.topics.includes("generated-from-data") && !(collection === "research-estimates" && r.url === milexUrl)) {
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
        const link = links.get(r.id);
        const cited = link?.url === r.url ? link.excerpts ?? [] : [];
        if (cited.length) {
          const body = cachedPage(r.url);
          if (body) {
            const article = plainPageText(body);
            for (const quote of cited) {
              if (containsQuote(article, squash(quote))) excerpts.checked++;
              else {
                excerpts.mismatched++;
                failed.push({ id: r.id, why: "dodatkowego cytatu nie znaleziono w kopii artykułu" });
              }
            }
          } else excerpts.unavailable += cited.length;
        }
        if (r.text !== [r.claimReviewed, ...cited].join("\n")) failed.push({ id: r.id, why: "tekst nie zgadza się z tezą z API i przypisanymi cytatami" });
        else if (ratingLabel(raw) !== r.rating?.raw) failed.push({ id: r.id, why: `etykieta oceny "${r.rating?.raw}" niezgodna z API ("${raw}")` });
        continue;
      }
      const key = [collection ?? "", r.sourceId, r.sourceId === "msz-odyseusz" ? r.id : r.url.split("#")[0]].join("|");
      if (!normalized.has(key)) normalized.set(key, sourceTexts(r, collection));
      const texts = normalized.get(key);
      if (texts === null) {
        skipped++;
        continue;
      }
      if (!texts?.length) {
        failed.push({ id: r.id, why: "brak źródła w cache" });
        continue;
      }
      checked++;
      const eliPdf = r.sourceId === "sejm-eli" && r.url.endsWith(".pdf");
      // W PDF-ach ELI nagłówki stron mogą dzielić zdania. Krótkie podpisy sprawdzamy w całości.
      const sentences = eliPdf ? squash(pieces.join(" ")).split(/(?<=[.;:])\s+/).filter(s => s.length > 40) : [];
      const candidates = sentences.length ? sentences : pieces;
      const missing = candidates.filter(c => !texts.some(text => containsQuote(text, c)));
      const allowed = eliPdf ? Math.floor(candidates.length * 0.1) : 0;
      if (!candidates.length || missing.length > allowed) {
        failed.push({ id: r.id, why: `nie znaleziono w źródle: „${missing[0]?.slice(0, 100) ?? ""}”` });
      } else if (collection && r.url === benefitGuide) {
        const original = benefitGuidePassages(cachedPage(r.url) ?? "");
        if (r.period !== original.updated || !original.passages.some(p => p.text === r.text && recordId(r.sourceId, r.url + "|" + p.key) === r.id)) {
          failed.push({ id: r.id, why: "niezgodna wersja lub pole informatora o świadczeniu" });
        } else passed.add(r.id);
      } else if (collection && r.sourceId === "zus-wskazniki" && (!r.period ||
        !r.text.includes(`od ${new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(r.period))} r.`))) {
        failed.push({ id: r.id, why: "okres w metadanych nie odpowiada dacie wiersza ZUS" });
      } else if (collection) passed.add(r.id);
    } catch (e) {
      failed.push({ id: r.id, why: (e as Error).message });
    }
  }
  for (const name of auditedCollections) {
    if (only && name !== only) continue;
    const ids = [...groups].filter(([, group]) => group === name).map(([id]) => id);
    for (const id of ids) if (!audited.has(id)) failed.push({ id, why: "rekord pominięty przy ładowaniu korpusu" });
    if (!ids.length) failed.push({ id: name, why: "brak rekordów zbioru" });
    log(`${name}: potwierdzono w źródle ${ids.filter(id => passed.has(id)).length}/${ids.length} rekordów`);
  }
  if (!only) log(`Dodatkowe cytaty publikacji Demagoga: potwierdzono z HTML ${excerpts.checked}, bez kopii HTML ${excerpts.unavailable}, niezgodnych ${excerpts.mismatched}`);
  log(`Porównano ${checked} rekordów, poza tą kontrolą ${skipped}, zgłoszono ${failed.length} problemów`);
  for (const f of failed.slice(0, 30)) log(`  ${f.id}: ${f.why}`);
  return { checked, failed, skipped };
}

const isMain = process.argv[1] && /verify\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const optionIndex = process.argv.indexOf("--only");
  if (optionIndex !== -1) {
    const scope = process.argv[optionIndex + 1] as AuditedCollection;
    if (process.argv[optionIndex + 1] === "membership-registers") {
      const audit = verifyMemberRegisters(readCorpus().records);
      for (const f of audit.failed) console.log(f.id + ": " + f.why);
      process.exit(audit.failed.length ? 1 : 0);
    }
    if (process.argv[optionIndex + 1] === "monetary-statistics") {
      const { records, errors } = readCorpus();
      const audit = verifyMonetarySeries(records);
      for (const f of audit.failed) console.log(f.id + ": " + f.why);
      const seriesErrors = errors.filter(e => /^(?:gus-cpi|nbp-rates)\.jsonl:/u.test(e));
      for (const error of seriesErrors) console.log(error);
      process.exit(audit.failed.length || seriesErrors.length ? 1 : 0);
    }
    if (!auditedCollections.includes(scope)) throw new Error("Wybierz --only " + [...auditedCollections, "monetary-statistics", "membership-registers"].join(" lub "));
    process.exit(verifyAll(console.log, scope).failed.length ? 1 : 0);
  }
  const res = verifyAll();
  const eu = verifyEuvsdisinfo();
  verifyClaimReview().then((cr) => process.exit(res.failed.length || cr.failed.length || eu.failed.length ? 1 : 0));
}
