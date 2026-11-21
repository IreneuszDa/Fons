/**
 * Ingestia stron gov.pl o OSOBACH pełniących funkcje publiczne (pytania typu „Kto jest ministrem spraw zagranicznych?”):
 *   1. Skład Rady Ministrów (https://www.gov.pl/web/premier/sklad-rady-ministrow) + biogram każdego członka rządu,
 *   2. Kierownictwo MSZ (https://www.gov.pl/web/dyplomacja/kierownictwo-ministerstwa) + biogramy,
 *   3. Rejestr „Polskie przedstawicielstwa na świecie” (ambasadorowie i szefowie stałych przedstawicielstw) —
 *      dane są osadzone w stronie jako CSV (<pre id="registerData">).
 *
 * Zasady: tekst rekordu to DOSŁOWNE linie ze strony biogramu (imię i nazwisko + funkcja, ewentualnie zdanie o powołaniu),
 * łącznie <= 300 znaków (licencja gov-pl: krótki cytat). Dla rejestru ambasadorów zdanie jest GENEROWANE z pól wiersza
 * (znacznik tematu „generated-from-data”); pola są dosłowne. publishedAt = data najnowszej wersji strony z historii
 * zmian gov.pl (wersje są jawne na stronie), a gdy jej brak — data pierwszej publikacji; nigdy nie jest zgadywana.
 * Strona gov.pl jest odczytywana w stanie na dzień pobrania (fetchedAt) — skład rządu zmienia się, więc rekord
 * nie jest dowodem na stan z innego dnia.
 */
import type { CorpusRecord } from "../../shared/contracts";
import {
  MAX_QUOTE_CHARS,
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  clipVerbatim,
  newResult,
  parseHtmlPage,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

const ORIGIN = "https://www.gov.pl";
export const COUNCIL_URL = `${ORIGIN}/web/premier/sklad-rady-ministrow`;
export const MFA_LEADERSHIP_URL = `${ORIGIN}/web/dyplomacja/kierownictwo-ministerstwa`;
export const EMBASSIES_URL = `${ORIGIN}/web/dyplomacja/polskie-przedstawicielstwa-na-swiecie`;
const ARTICLE = "article.article-area__article";

// ───────────────────────────── Parsery (czyste, testowane na fixturach) ─────────────────────────────

export interface PersonListItem {
  name: string;
  position: string;
  href: string;
}

/** Lista osób ze strony typu „bio-prev”: `.bio-prev li` z `.title a` (imię i nazwisko, link) i `.position`. */
export function parsePersonList(html: string): PersonListItem[] {
  const { document } = parseHtmlPage(html);
  const out: PersonListItem[] = [];
  for (const li of Array.from(document.querySelectorAll(".bio-prev li"))) {
    const a = li.querySelector(".title a");
    const href = a?.getAttribute("href");
    const name = squash(a?.textContent ?? "");
    const position = squash(li.querySelector(".position")?.textContent ?? "");
    if (!a || !href || !name || !position) continue;
    out.push({ name, position, href });
  }
  return out;
}

export interface PublicationDates {
  /** ISO (RRRR-MM-DD) z linii „Pierwsza publikacja: …”. */
  first: string | null;
  /** Najnowsza data z historii zmian (lub pierwsza publikacja, gdy historii brak). */
  latest: string | null;
}

function isoFromPlDateTime(d: string, m: string, y: string): string {
  return `${y}-${m}-${d}`;
}

/** Daty publikacji z bloku „Informacje o publikacji dokumentu” (gov.pl) — tylko to, co jest na stronie. */
export function parsePublicationDates(text: string): PublicationDates {
  const idx = text.indexOf("Informacje o publikacji dokumentu");
  const tail = idx >= 0 ? text.slice(idx) : text;
  const dates: string[] = [];
  for (const m of tail.matchAll(/(\d{2})\.(\d{2})\.(\d{4}) \d{2}:\d{2}/g)) dates.push(isoFromPlDateTime(m[1]!, m[2]!, m[3]!));
  const first = /Pierwsza publikacja:?\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(tail.replace(/\n/g, " "));
  const firstIso = first ? isoFromPlDateTime(first[1]!, first[2]!, first[3]!) : null;
  const latest = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : firstIso;
  return { first: firstIso, latest };
}

export interface GovBio {
  /** Linie treści biogramu (przed blokiem publikacji), w kolejności strony. */
  lines: string[];
  dates: PublicationDates;
}

/** Biogram gov.pl: linie artykułu przed „Informacje o publikacji dokumentu” + daty publikacji. */
export function parseGovBio(html: string): GovBio {
  const parsed = parseHtmlPage(html, ARTICLE);
  const all = parsed.text.split("\n");
  const cut = all.findIndex((l) => /^Informacje o publikacji dokumentu/.test(l));
  // W fixturach i na stronie blok bywa też zapisany jako „Pierwsza publikacja: …” bez nagłówka — tniemy przy pierwszym z nich.
  const cut2 = all.findIndex((l) => /^Pierwsza publikacja/.test(l));
  const end = [cut, cut2].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? all.length;
  return { lines: all.slice(0, end), dates: parsePublicationDates(parsed.text) };
}

const GENERIC_STEMS = new Set(["minist", "wicepr", "prezes", "członk", "rady m"]);

/** Rdzenie (6 znaków) znaczących słów nazwy funkcji, bez słów ogólnych (minister, prezes, członek, „Rady Ministrów”). */
export function positionStems(position: string): string[] {
  return squash(position)
    .toLowerCase()
    .split(/[\s,;–-]+/)
    .filter((w) => w.length >= 5)
    .map((w) => w.slice(0, 6))
    .filter((st) => !GENERIC_STEMS.has(st) && st !== "rady");
}

/**
 * Wybiera z biogramu zdanie o BIEŻĄCYM powołaniu / pełnieniu funkcji (dosłowny fragment jednej linii). Odrzuca zdania
 * w czasie przeszłym o wcześniejszych funkcjach („pełnił funkcję…”) oraz te, które nie dotyczą nazwy bieżącej funkcji —
 * lepiej pominąć zdanie niż dołączyć do rekordu fragment mogący sugerować inne stanowisko.
 */
export function appointmentSentence(lines: string[], name: string, position: string): string | null {
  const present = /(pełni funkcję|powołan\w*[^.]* na (?:urząd|stanowisko)|został\w* powołan\w*|objął\w* (?:urząd|stanowisko)|mianowan\w*)/i;
  const past = /(pełnił\w*|był\w*|wcześniej|w latach|do \d{4})/i;
  const stems = positionStems(position);
  const skip = new Set([squash(name), squash(position)]);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (skip.has(line)) continue;
    const sentences = line.split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9„"(])/);
    for (let j = sentences.length - 1; j >= 0; j--) {
      const sent = sentences[j]!.trim();
      if (!present.test(sent) || past.test(sent)) continue;
      if (stems.length > 0 && !stems.some((st) => sent.toLowerCase().includes(st))) continue;
      if (!/(Minist|minist|Premier|premier|Prezes|Wiceprezes|Sekretarz|sekretarz|Szef|Szefow|Rad\w+ Ministrów)/.test(sent)) continue;
      return sent;
    }
  }
  return null;
}

/** Minimalny parser CSV (separator `;`, cudzysłowy z "" w środku, nowe linie wewnątrz cudzysłowu). */
export function parseCsv(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

export interface MissionRow {
  country: string;
  mission: string;
  head: string;
  headTitle: string;
}

/** Rejestr „Polskie przedstawicielstwa na świecie”: wiersze z <pre id="registerData"> (JSON z polem `data` = CSV). */
export function parseMissionRegister(html: string): MissionRow[] {
  const { document } = parseHtmlPage(html);
  const pre = document.querySelector("pre#registerData");
  if (!pre) return [];
  let data: string;
  try {
    data = (JSON.parse(pre.textContent ?? "") as { data?: string }).data ?? "";
  } catch {
    return [];
  }
  const rows = parseCsv(data);
  const header = rows[0] ?? [];
  const col = (name: string) => header.findIndex((h) => squash(h).toLowerCase() === name.toLowerCase());
  const iCountry = col("Państwo / Terytorium");
  const iMission = col("Placówka");
  const iHead = col("Kierownik placówki");
  const iTitle = col("Stanowisko kierownika placówki");
  if ([iCountry, iMission, iHead, iTitle].some((i) => i < 0)) return [];
  return rows.slice(1).map((r) => ({
    country: squash(r[iCountry] ?? ""),
    mission: squash(r[iMission] ?? ""),
    head: squash(r[iHead] ?? ""),
    headTitle: squash(r[iTitle] ?? ""),
  }));
}

/** Szef placówki, którą traktujemy jako „ambasadę lub stałe przedstawicielstwo” (bez konsulatów, wydziałów, instytutów). */
export function isHeadOfMission(r: MissionRow): boolean {
  return /^(Ambasada|Stałe Przedstawicielstwo|Stała Delegacja|Przedstawicielstwo)\b/.test(r.mission) && r.head !== "";
}

export function missionSentence(r: MissionRow): string {
  const end = (t: string) => (t.endsWith(".") ? t : `${t}.`);
  const title = r.headTitle ? `, stanowisko: ${r.headTitle}` : "";
  const full = end(`${r.mission} (${r.country}) - kierownik placówki: ${r.head}${title}`);
  if (full.length <= MAX_QUOTE_CHARS) return full;
  return end(`${r.mission} - kierownik placówki: ${r.head}${title}`).slice(0, MAX_QUOTE_CHARS);
}

// ───────────────────────────── Ingestia ─────────────────────────────

function topicsForPosition(position: string, extra: string[]): string[] {
  const t = new Set<string>(["kto-jest", "funkcja-publiczna", "urzednicy", ...extra]);
  if (/Spraw Zagranicznych/i.test(position)) t.add("msz");
  if (/Obrony Narodowej/i.test(position)) t.add("mon");
  if (/Spraw Wewnętrznych/i.test(position)) t.add("mswia");
  if (/Prezes Rady Ministrów/.test(position) && !/Wiceprezes/.test(position)) t.add("premier");
  return [...t];
}

interface BioSource {
  listUrl: string;
  listTopics: string[];
  publisher: string;
  titlePrefix: string;
}

const BIO_SOURCES: BioSource[] = [
  {
    listUrl: COUNCIL_URL,
    listTopics: ["rzad", "rada-ministrow", "kprm"],
    publisher: "Kancelaria Prezesa Rady Ministrów (gov.pl)",
    titlePrefix: "Rada Ministrów",
  },
  {
    listUrl: MFA_LEADERSHIP_URL,
    listTopics: ["msz", "kierownictwo-msz", "polityka-zagraniczna"],
    publisher: "Ministerstwo Spraw Zagranicznych (gov.pl)",
    titlePrefix: "Kierownictwo MSZ",
  },
];

export async function ingestGovPlOfficials(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("gov-pl-officials");
  result.fileId = "gov-pl-officials";
  const client = new PoliteClient({ refresh: opts.refresh });
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "gov-pl"));

  for (const src of BIO_SOURCES) {
    let list: PersonListItem[] = [];
    let listFetchedAt = "";
    try {
      const res = await client.get(src.listUrl);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      list = parsePersonList(res.body);
      listFetchedAt = res.fetchedAt;
    } catch (e) {
      result.skipped.push({ what: src.listUrl, reason: (e as Error).message });
      continue;
    }
    if (list.length === 0) {
      result.skipped.push({ what: src.listUrl, reason: "lista osób jest pusta (zmiana układu strony?)" });
      continue;
    }
    opts.log(`  ${src.titlePrefix}: ${list.length} osób na liście (pobrano ${listFetchedAt})`);
    for (const person of list) {
      const url = new URL(person.href, ORIGIN).toString();
      try {
        const res = await client.get(url);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const bio = parseGovBio(res.body);
        const [nameLine, positionLine] = bio.lines;
        if (squash(nameLine ?? "") !== person.name) throw new Error(`nazwa na stronie ("${nameLine}") różni się od listy ("${person.name}")`);
        // Funkcja: z biogramu, gdy druga linia jest krótkim opisem stanowiska; inaczej z listy (też dosłownie ze strony).
        const position = positionLine && positionLine.length <= 200 && !/^Urodzon/.test(positionLine) ? positionLine : person.position;
        const headLine = `${person.name} ${position}`;
        const appointment = appointmentSentence(bio.lines.slice(2), person.name, position);
        let text = headLine;
        if (appointment && `${headLine}\n${appointment}`.length <= MAX_QUOTE_CHARS) text = `${headLine}\n${appointment}`;
        else if (appointment) {
          const room = MAX_QUOTE_CHARS - headLine.length - 1;
          const clipped = room > 60 ? clipVerbatim(appointment, room) : "";
          if (clipped) text = `${headLine}\n${clipped}`;
        }
        const rec: CorpusRecord = {
          ...base,
          publisher: src.publisher,
          id: recordId("gov-pl", `${url}|osoba`),
          url,
          title: `${src.titlePrefix}: ${person.name} - ${position}`,
          publishedAt: bio.dates.latest,
          fetchedAt: res.fetchedAt,
          lang: "pl",
          text,
          topics: topicsForPosition(position, src.listTopics),
          origin: "corpus",
        };
        result.records.push(rec);
      } catch (e) {
        result.skipped.push({ what: url, reason: (e as Error).message });
      }
    }
  }

  // Rejestr placówek: ambasadorowie i szefowie stałych przedstawicielstw.
  try {
    const res = await client.get(EMBASSIES_URL);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const rows = parseMissionRegister(res.body).filter(isHeadOfMission);
    const dates = parsePublicationDates(parseHtmlPage(res.body, ARTICLE).text);
    for (const r of rows) {
      const topics = ["kto-jest", "funkcja-publiczna", "ambasador", "msz", "polityka-zagraniczna", "placowka-dyplomatyczna", "generated-from-data"];
      const rec: CorpusRecord = {
        ...base,
        publisher: "Ministerstwo Spraw Zagranicznych (gov.pl)",
        id: recordId("gov-pl", `${EMBASSIES_URL}|${r.mission}|${r.head}`),
        url: EMBASSIES_URL,
        title: `Kierownik placówki RP (ambasador lub chargé d'affaires): ${r.mission} - ${r.head}${r.headTitle ? `, ${r.headTitle}` : ""}`,
        publishedAt: dates.latest,
        fetchedAt: res.fetchedAt,
        lang: "pl",
        text: missionSentence(r),
        topics,
        origin: "corpus",
      };
      result.records.push(rec);
    }
    opts.log(`  rejestr placówek: ${rows.length} szefów ambasad i stałych przedstawicielstw`);
    if (rows.length === 0) result.skipped.push({ what: EMBASSIES_URL, reason: "brak wierszy rejestru (zmiana układu strony?)" });
  } catch (e) {
    result.skipped.push({ what: EMBASSIES_URL, reason: (e as Error).message });
  }

  result.requests = client.requests;
  result.notes.push(
    "Rada Ministrów i kierownictwo MSZ: dosłowne linie z biogramów gov.pl (imię i nazwisko + funkcja + zdanie o powołaniu, <= 300 zn.); " +
      "ambasadorowie: zdania generowane z wierszy rejestru 'Polskie przedstawicielstwa na świecie' (tag generated-from-data); " +
      "publishedAt = najnowsza wersja strony z historii zmian gov.pl. Stan jest ważny na dzień fetchedAt.",
  );
  return result;
}
