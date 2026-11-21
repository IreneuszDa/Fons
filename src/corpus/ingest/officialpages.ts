/**
 * Ingestia wybranych stron instytucji (rodziny tematyczne): sankcje UE (Komisja), Schengen, ustalenia ws. MH17
 * (Rada ds. Bezpieczeństwa Niderlandów, Prokuratura/JIT, rząd Niderlandów, ONZ/ICAO), Bucza (OHCHR/ONZ), "biolaby" (ONZ).
 *
 * Zasady: tylko strony wymienione w PAGES (adres = rekord; brak wyszukiwania i przeglądania serwisu), robots.txt i <= 1 żądanie/s
 * (PoliteClient), tekst rekordu dosłownie ze strony (kawałki <= 1200 znaków), data publikacji wyłącznie z metadanych/treści strony
 * (nigdy zgadywana: brak = null). Strona z wyzwaniem antybotowym ("Client Challenge", "Browser check") jest pomijana i opisywana
 * w raporcie — zabezpieczeń nie obchodzimy.
 *
 * Wyjątek: oś czasu pakietów sankcji (finance.ec.europa.eu) daje po jednym zdaniu na pakiet, złożonym z pól wiersza osi czasu
 * (data + nazwa), z tagiem "generated-from-data".
 */
import type { CorpusRecord } from "../../shared/contracts";
import {
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  chunkText,
  newResult,
  parseHtmlPage,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

export interface PageSpec {
  sourceId: string;
  url: string;
  topics: string[];
  lang: "en" | "pl";
  /** Skrócona nazwa wydawcy do tytułu rekordu. */
  titlePrefix: string;
  /** Selektor CSS obszaru treści (domyślnie <main>/<body>). */
  selector?: string;
  /** Maks. liczba rekordów (kawałków) ze strony. */
  max: number;
  /** Zaczynamy od pierwszej linii pasującej do wyrażenia (odcina nawigację). */
  startAt?: RegExp;
  /** Kończymy przed pierwszą linią pasującą do wyrażenia (stopka, "Related links"). */
  stopAt?: RegExp;
  /** Linie do pominięcia. */
  skipLine?: RegExp;
  /** Wiersze osi czasu pakietów sankcji → osobne zdania. */
  sanctionsTimeline?: boolean;
  /** Własne objaśnienie dopisywane do tytułu (po polsku; ułatwia wyszukiwanie). */
  titleNote?: string;
  /** Pierwszy element <time> na stronie jest datą innego materiału (lista aktualności) — nie używamy go jako daty publikacji. */
  ignoreTimeElement?: boolean;
  /** Strona "żywa" (oś czasu, wiersz "Latest update"): dopuszczamy datę ostatniej aktualizacji jako publishedAt. */
  allowModified?: boolean;
}

export const PAGES: PageSpec[] = [
  // ───── Sankcje UE wobec Rosji i Białorusi ─────
  {
    sourceId: "ec-finance",
    url: "https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/sanctions-adopted-following-russias-military-aggression-against-ukraine_en",
    topics: ["sankcje", "rosja", "bialorus", "ue", "wojna-w-ukrainie", "embargo", "energia", "pakiety-sankcji"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "sankcje UE wobec Rosji i Białorusi, pakiety sankcji, zakaz importu węgla i ropy",
    max: 6,
    allowModified: true,
    startAt: /^What the EU is doing and why$/,
    stopAt: /^(Related links|More on|Sanctions on energy)$/,
    sanctionsTimeline: true,
  },
  {
    sourceId: "ec-finance",
    url: "https://finance.ec.europa.eu/news/eu-agrees-fifth-package-restrictive-measures-against-russia-2022-04-08_en",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "pakiety-sankcji", "zakaz-importu-wegla", "pakiet-5"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "piąty pakiet sankcji UE wobec Rosji, zakaz importu węgla",
    max: 3,
  },
  {
    sourceId: "ec-finance",
    url: "https://finance.ec.europa.eu/news/russias-war-ukraine-eu-adopts-sixth-package-sanctions-against-russia-2022-06-03_en",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "pakiety-sankcji", "embargo-na-rope", "pakiet-6"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "szósty pakiet sankcji UE wobec Rosji, embargo na ropę",
    max: 3,
  },
  {
    sourceId: "ec-finance",
    url: "https://finance.ec.europa.eu/news/eu-agrees-eighth-package-sanctions-against-russia-2022-10-06_en",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "pakiety-sankcji", "cena-maksymalna-ropy", "pakiet-8"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "ósmy pakiet sankcji UE wobec Rosji, pułap cenowy na ropę",
    max: 3,
  },
  // ───── Schengen ─────
  {
    sourceId: "ec-home-affairs",
    url: "https://home-affairs.ec.europa.eu/policies/schengen/schengen-area_en",
    topics: ["schengen", "ue", "czlonkostwo", "swoboda-przemieszczania", "kontrole-graniczne"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "strefa Schengen: skład, Cypr, Irlandia",
    max: 2,
    stopAt: /^Benefits of Schengen$/,
  },
  {
    sourceId: "ec-home-affairs",
    url: "https://home-affairs.ec.europa.eu/news/bulgaria-and-romania-join-schengen-area-2025-01-03_en",
    topics: ["schengen", "ue", "bulgaria", "rumunia", "czlonkostwo"],
    lang: "en",
    titlePrefix: "Komisja Europejska",
    titleNote: "Bułgaria i Rumunia w strefie Schengen od 1 stycznia 2025",
    max: 2,
  },
  // ───── MH17: Dutch Safety Board, JIT/prokuratura, rząd NL, ICAO (przez ONZ) ─────
  {
    sourceId: "onderzoeksraad",
    url: "https://onderzoeksraad.nl/en/pers/dutch-safety-board-buk-surface-to-air-missile-system-caused-mh17-crash/",
    topics: ["mh17", "ukraina", "rosja", "buk", "katastrofa-lotnicza", "raport-koncowy"],
    lang: "en",
    titlePrefix: "Dutch Safety Board",
    titleNote: "MH17: przyczyna katastrofy — rakieta Buk",
    max: 4,
    startAt: /^In response to the crash of flight MH17/,
    stopAt: /^(Related|Share this|Contact)$/,
  },
  {
    sourceId: "onderzoeksraad",
    url: "https://onderzoeksraad.nl/en/onderzoek/crash-mh17-17-july-2014/",
    topics: ["mh17", "ukraina", "rosja", "buk", "katastrofa-lotnicza", "dochodzenie"],
    lang: "en",
    titlePrefix: "Dutch Safety Board",
    titleNote: "MH17: dochodzenie i ustalenia",
    max: 5,
    startAt: /^The Dutch Safety Board is investigating the accident/,
    ignoreTimeElement: true,
  },
  {
    sourceId: "prosecutionservice",
    url: "https://www.prosecutionservice.nl/topics/m/mh17-plane-crash/timeline-mh17-investigation-and-legal-proceedings",
    topics: ["mh17", "ukraina", "rosja", "buk", "jit", "proces", "wyrok"],
    lang: "en",
    titlePrefix: "Prokuratura Niderlandów (JIT)",
    titleNote: "MH17: oś czasu śledztwa JIT i procesu",
    max: 8,
  },
  {
    sourceId: "government-nl",
    url: "https://www.government.nl/latest/news/2025/05/12/icao-council-russian-federation-responsible-for-downing-of-flight-mh17",
    topics: ["mh17", "ukraina", "rosja", "icao", "odpowiedzialnosc-panstwa"],
    lang: "en",
    titlePrefix: "Rząd Niderlandów",
    titleNote: "MH17: Rada ICAO uznała Rosję za odpowiedzialną",
    max: 2,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2025/05/1163161",
    topics: ["mh17", "ukraina", "rosja", "icao", "onz", "odpowiedzialnosc-panstwa"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "MH17: Rada ICAO uznała Rosję za odpowiedzialną za zestrzelenie",
    max: 2,
  },
  // ───── Bucza: OHCHR / Komisja Śledcza ONZ ─────
  {
    sourceId: "un-news",
    url: "https://ukraine.un.org/en/210464-un-report-details-summary-executions-and-attacks-individual-civilians-russian-troops",
    topics: ["bucza", "ukraina", "rosja", "zbrodnie-wojenne", "ohchr", "onz", "egzekucje", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "ONZ (OHCHR)",
    titleNote: "Bucza: raport OHCHR o zabójstwach cywilów",
    max: 4,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2022/12/1131447",
    topics: ["bucza", "ukraina", "rosja", "zbrodnie-wojenne", "ohchr", "onz", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "Bucza i obwody kijowski, czernihowski, sumski: raport OHCHR",
    max: 3,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2022/04/1115482",
    topics: ["bucza", "ukraina", "rosja", "zbrodnie-wojenne", "onz", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "Bucza: Wysoka Komisarz ONZ o zabójstwach cywilów",
    max: 2,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2024/02/1146872",
    topics: ["bucza", "ukraina", "rosja", "zbrodnie-wojenne", "onz", "komisja-sledcza", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "Bucza i Irpień: ustalenia komisji ONZ",
    max: 3,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2023/10/1142617",
    topics: ["ukraina", "rosja", "zbrodnie-wojenne", "komisja-sledcza", "onz", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "Komisja Śledcza ONZ ds. Ukrainy: dowody zbrodni wojennych",
    max: 2,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2026/10/1168670",
    topics: ["ukraina", "rosja", "zbrodnie-wojenne", "komisja-sledcza", "onz", "wojna-w-ukrainie"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "Komisja Śledcza ONZ ds. Ukrainy: raport z października 2026",
    max: 2,
  },
  // ───── "Biolaby USA na Ukrainie": oficjalne dementi ONZ ─────
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2022/03/1114272",
    topics: ["biolaby", "bron-biologiczna", "ukraina", "rosja", "usa", "onz", "dezinformacja", "rada-bezpieczenstwa"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "biolaby na Ukrainie: ONZ nie ma wiedzy o programie broni biologicznej",
    max: 3,
  },
  {
    sourceId: "un-news",
    url: "https://news.un.org/en/story/2022/10/1129952",
    topics: ["biolaby", "bron-biologiczna", "ukraina", "rosja", "usa", "onz", "dezinformacja", "rada-bezpieczenstwa"],
    lang: "en",
    titlePrefix: "UN News",
    titleNote: "biolaby na Ukrainie: ONZ nadal bez dowodów na broń biologiczną",
    max: 3,
  },
];

const PAGE_PUBLISHER_SUFFIX = /\s*(?:\||\s-\s|\s–\s)\s*(?:UN News|Onderzoeksraad voor Veiligheid|European Commission|Finance|Migration and Home Affairs|Public Prosecution Service|Government\.nl|United Nations in Ukraine|.*Netherlands.*)\s*$/i;

/** Czy strona to wyzwanie antybotowe (HTTP 200 bez treści właściwej). */
export function isChallengePage(html: string, title: string): boolean {
  return /^(Client Challenge|Browser check|Just a moment|Attention Required)/i.test(title.trim()) || (html.length < 6000 && /challenge|captcha|browser check/i.test(html));
}

const MONTHS_EN: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export const MONTHS_PL_GEN = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];

/** "22 October 2015" / "6 November 2026" → ISO; null, gdy to nie data. */
export function parseEnglishDate(s: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mm = MONTHS_EN[m[2]!.toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : null;
}

/**
 * Data publikacji wyłącznie z metadanych/treści strony: article:published_time → <time datetime> → <time> tekst →
 * DCTERMS.issued → og:updated_time (komunikaty Komisji: data wiadomości) → DCTERMS.modified (data ostatniej aktualizacji) → null.
 */
export function detectPublishedAt(parsed: ReturnType<typeof parseHtmlPage>, opts: { ignoreTimeElement?: boolean; allowModified?: boolean } = {}): string | null {
  const iso = (v: string | undefined | null): string | null => {
    const m = v ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
    return m ? m[1]! : null;
  };
  const meta = parsed.meta;
  const fromMeta = iso(meta["article:published_time"]) ?? null;
  if (fromMeta) return fromMeta;
  if (!opts.ignoreTimeElement) {
    const t = parsed.document.querySelector("time");
    const fromTime = iso(t?.getAttribute("datetime")) ?? parseEnglishDate(t?.textContent ?? "");
    if (fromTime) return fromTime;
  }
  const issued = iso(meta["DCTERMS.issued"]);
  if (issued) return issued;
  // og:updated_time w komunikatach Komisji to data wiadomości; w stronach "żywych" to tylko data aktualizacji.
  const updated = iso(meta["og:updated_time"]);
  if (updated && (opts.allowModified || /\/news\//.test(parsed.meta["og:url"] ?? "") || /^\d{4}-\d{2}-\d{2}T14:00:00\+0200$/.test(meta["og:updated_time"] ?? ""))) return updated;
  if (opts.allowModified) return iso(meta["DCTERMS.modified"]) ?? iso(meta["article:modified_time"]) ?? null;
  return null;
}

export interface TimelineRow {
  /** Data przyjęcia (ISO) — dla wierszy z dwiema datami druga (z rokiem). */
  iso: string;
  dateLabel: string;
  title: string;
}

/** Wiersze osi czasu pakietów sankcji: "8 April 2022Fifth package See the details of ..." (pola sklejone w textContent). */
export function parseSanctionsTimeline(lines: string[]): TimelineRow[] {
  const out: TimelineRow[] = [];
  const rx = /^((?:\d{1,2} [A-Z][a-z]+ and )?\d{1,2} [A-Z][a-z]+ \d{4})\s*(.+?)\s*See the details/;
  for (const line of lines) {
    const m = rx.exec(line);
    if (!m) continue;
    const label = m[1]!;
    const iso = parseEnglishDate(label.replace(/^\d{1,2} [A-Z][a-z]+ and /, ""));
    const title = squash(m[2]!.replace(/[“”"]/g, (c) => (c === '"' ? "" : c)));
    if (iso && title) out.push({ iso, dateLabel: label, title });
  }
  return out;
}

function plDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS_PL_GEN[Number(m) - 1]} ${y} r.`;
}

export async function ingestOfficialPages(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("official-pages");
  const client = new PoliteClient({ refresh: opts.refresh });

  for (const spec of PAGES) {
    try {
      const src = sourceFromCatalog(opts.catalog, spec.sourceId);
      const base = baseFromCatalog(src);
      const res = await client.get(spec.url);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const parsed = parseHtmlPage(res.body, spec.selector);
      if (isChallengePage(res.body, parsed.title)) throw new Error("strona zwraca wyzwanie antybotowe (nie obchodzimy)");
      let lines = parsed.text.split("\n").map(squash).filter(Boolean);
      if (spec.startAt) {
        const i = lines.findIndex((l) => spec.startAt!.test(l));
        if (i >= 0) lines = lines.slice(i);
      }
      if (spec.stopAt) {
        const i = lines.findIndex((l, idx) => idx > 0 && spec.stopAt!.test(l));
        if (i > 0) lines = lines.slice(0, i);
      }
      const timelineRows = spec.sanctionsTimeline ? parseSanctionsTimeline(lines) : [];
      let body = lines;
      if (spec.sanctionsTimeline) {
        // Wiersze osi czasu i linie "Latest update" nie wchodzą do kawałków dosłownych (mają własne zdania poniżej).
        body = lines.filter((l) => !/See the details/.test(l) && !/^Latest update:/.test(l) && !/^Measures adopted since 2022$/.test(l));
      }
      if (spec.skipLine) body = body.filter((l) => !spec.skipLine!.test(l));
      const publishedAt =
        detectPublishedAt(parsed, { ignoreTimeElement: spec.ignoreTimeElement, allowModified: spec.allowModified }) ??
        // wiersz z samą datą tuż pod tytułem ("07 December 2022" na ukraine.un.org)
        lines.slice(0, 6).map((l) => (/^\d{1,2} [A-Z][a-z]+ \d{4}$/.test(l) ? parseEnglishDate(l) : null)).find(Boolean) ??
        (spec.allowModified ? (() => {
          const lu = parsed.text.split("\n").map(squash).find((l) => /^Latest update:/.test(l));
          return lu ? parseEnglishDate(lu) : null;
        })() : null) ??
        null;
      let pageTitle = squash(parsed.title.replace(PAGE_PUBLISHER_SUFFIX, "")) || spec.url;
      if (pageTitle.startsWith(`${spec.titlePrefix}: `)) pageTitle = pageTitle.slice(spec.titlePrefix.length + 2);
      const chunks = chunkText(body.join("\n"), 1200).filter((c) => c.length >= 80).slice(0, spec.max);
      chunks.forEach((chunk, idx) => {
        const rec: CorpusRecord = {
          ...base,
          id: recordId(spec.sourceId, `${res.finalUrl}|${idx}`),
          url: res.finalUrl,
          title: `${spec.titlePrefix}: ${pageTitle}${spec.titleNote ? ` (${spec.titleNote})` : ""}${chunks.length > 1 ? ` (cz. ${idx + 1})` : ""}`,
          publishedAt,
          fetchedAt: res.fetchedAt,
          lang: spec.lang,
          text: chunk,
          topics: [...spec.topics, "komunikat-instytucji"],
          origin: "corpus",
        };
        result.records.push(rec);
      });
      timelineRows.forEach((row) => {
        const rec: CorpusRecord = {
          ...base,
          id: recordId(spec.sourceId, `${res.finalUrl}|timeline|${row.iso}|${row.title}`),
          url: res.finalUrl,
          title: `Komisja Europejska: sankcje UE wobec Rosji — ${row.title} (${row.dateLabel})`,
          publishedAt: row.iso,
          fetchedAt: res.fetchedAt,
          lang: "pl",
          text:
            `Oś czasu sankcji UE wobec Rosji (Komisja Europejska, sekcja „Measures adopted since 2022”): ${row.title} — data: ${row.dateLabel} (${plDate(row.iso)}). ` +
            `Pozycja osi czasu: „${row.title}”.`,
          topics: [...spec.topics, "os-czasu", "generated-from-data", "komunikat-instytucji"],
          period: row.iso,
          origin: "corpus",
        };
        result.records.push(rec);
      });
      opts.log(`  ${spec.sourceId} ${pageTitle.slice(0, 60)}: ${chunks.length} kawałków${timelineRows.length ? ` + ${timelineRows.length} wierszy osi czasu` : ""} (publishedAt=${publishedAt ?? "brak"})`);
      if (chunks.length === 0 && timelineRows.length === 0) result.skipped.push({ what: spec.url, reason: "brak treści po filtrach" });
    } catch (e) {
      result.skipped.push({ what: spec.url, reason: (e as Error).message });
    }
  }
  result.requests = client.requests;
  result.notes.push(
    "Strony instytucji pobrane z listy PAGES (bez wyszukiwania). Pominięte z powodu blokad botów: consilium.europa.eu (Browser check), ohchr.org (HTTP 403), press.un.org (Client Challenge), neighbourhood-enlargement.ec.europa.eu (HTTP 403), icao.int (brak stabilnego adresu komunikatu; rozstrzygnięcie ICAO cytujemy przez UN News i rząd NL).",
  );
  return result;
}
