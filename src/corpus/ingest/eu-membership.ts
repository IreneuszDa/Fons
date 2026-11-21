/**
 * Członkostwo w UE: parsery stron portalu european-union.europa.eu (wersja polska) — rekordy w źródle "eu-portal".
 *
 *  - lista krajów UE (eu-countries_pl): jedno zdanie na kraj "Państwo członkowskie UE od ... r., należy do strefy euro od ... r.,
 *    a do strefy Schengen od ... r." — zdanie dosłownie ze strony, tytuł rekordu z nazwą kraju,
 *  - kraje strefy euro (countries-using-euro_pl): lista dosłownie (21 państw) + lista krajów poza strefą,
 *  - rozszerzenie UE (eu-enlargement_pl): oś czasu rozszerzeń (data + opis; zdania złożone z pól, tag "generated-from-data")
 *    oraz kraje kandydujące z datami wniosku/statusu kandydata/otwarcia negocjacji (pola z akordeonu strony; tag "generated-from-data").
 *
 * Daty z portalu mają dokładność do dnia (przystąpienie) albo miesiąca (status kandydata) — dokładnie tak, jak na stronie.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestResult, type IngestOptions, baseFromCatalog, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

const PORTAL = "https://european-union.europa.eu";
export const EU_COUNTRIES_URL = `${PORTAL}/principles-countries-history/eu-countries_pl`;
export const EURO_AREA_URL = `${PORTAL}/institutions-law-budget/euro/countries-using-euro_pl`;
export const ENLARGEMENT_URL = `${PORTAL}/principles-countries-history/eu-enlargement_pl`;

const MONTHS_PL: Record<string, string> = {
  stycznia: "01", lutego: "02", marca: "03", kwietnia: "04", maja: "05", czerwca: "06", lipca: "07", sierpnia: "08", września: "09", października: "10", listopada: "11", grudnia: "12",
};

/** "Ostatnia aktualizacja strony: 12 stycznia 2026" → "2026-01-12" (data z treści strony), inaczej null. */
export function parseLastUpdate(text: string): string | null {
  const m = /Ostatnia aktualizacja strony:\s*(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/i.exec(text);
  if (!m) return null;
  const mm = MONTHS_PL[m[2]!.toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : null;
}

export interface CountryLine {
  slug: string;
  name: string;
  /** Zdanie dosłownie ze strony. */
  sentence: string;
  /** Rok przystąpienia do UE, rok wejścia do strefy euro i do Schengen — wyłącznie z tego zdania. */
  euYear: number | null;
  euroYear: number | null;
  schengenYear: number | null;
}

/** Lista krajów UE: artykuły z linkiem do profilu kraju i jednozdaniowym opisem członkostwa. */
export function parseCountryList(html: string): CountryLine[] {
  const { document } = parseHtmlPage(html);
  const out: CountryLine[] = [];
  for (const art of Array.from(document.querySelectorAll("article"))) {
    const a = art.querySelector("a[href*='/eu-countries/']");
    const p = art.querySelector("p");
    const href = a?.getAttribute("href") ?? "";
    const slug = /\/eu-countries\/([a-z-]+)_pl/.exec(href)?.[1];
    const sentence = squash(p?.textContent ?? "");
    if (!slug || !/^Państwo członkowskie UE od \d{4}/.test(sentence)) continue;
    const year = (re: RegExp): number | null => {
      const m = re.exec(sentence);
      return m ? Number(m[1]) : null;
    };
    out.push({
      slug,
      name: squash(a?.textContent ?? slug),
      sentence,
      euYear: year(/UE od (\d{4}) r\./),
      // "należy do strefy euro i do strefy Schengen od 2023 r." (Chorwacja) — rok dotyczy obu; "w strefie euro od 2008 r." / "do strefy euro od 1999 r."
      euroYear: /strefy euro i do strefy Schengen od (\d{4})/.test(sentence) ? year(/strefy euro i do strefy Schengen od (\d{4})/) : year(/(?:w strefie euro|do strefy euro) od (\d{4}) r\./),
      schengenYear: year(/(?:do strefy Schengen|w strefie Schengen) od (\d{4}) r\./),
    });
  }
  return out;
}

export interface EuroAreaLists {
  inside: string[];
  insideLead: string;
  outside: string[];
  outsideLead: string;
  denmark: string | null;
  denmarkLead: string | null;
}

/** Strona "Kraje strefy euro": listy państw (linie z nazwami) między zdaniami wprowadzającymi. */
export function parseEuroArea(html: string): EuroAreaLists | null {
  const lines = parseHtmlPage(html, "main").text.split("\n").map(squash).filter(Boolean);
  const i0 = lines.findIndex((l) => /^Obecnie euro \(€\) jest oficjalną walutą/.test(l));
  const i1 = lines.findIndex((l) => /^Następujące kraje nie wprowadziły jeszcze euro/.test(l));
  const i2 = lines.findIndex((l) => /^W niektórych przypadkach państwa UE mogą wynegocjować klauzulę/.test(l));
  if (i0 < 0 || i1 < i0 || i2 < i1) return null;
  const inside = lines.slice(i0 + 1, i1);
  const outside = lines.slice(i1 + 1, i2);
  const denmarkLine = lines[i2 + 1] ?? null;
  return {
    inside,
    insideLead: lines[i0]!,
    outside,
    outsideLead: lines[i1]!,
    denmark: denmarkLine && denmarkLine.length < 30 ? denmarkLine : null,
    denmarkLead: lines[i2]!,
  };
}

export interface TimelineItem {
  label: string;
  iso: string | null;
  title: string;
  content: string;
}

/** Oś czasu rozszerzeń UE: elementy ecl-timeline (data "1.05.2004 r.", tytuł, opis). */
export function parseEnlargementTimeline(html: string): TimelineItem[] {
  const { document } = parseHtmlPage(html);
  const out: TimelineItem[] = [];
  for (const li of Array.from(document.querySelectorAll("li.ecl-timeline__item"))) {
    const label = squash(li.querySelector(".ecl-timeline__label")?.textContent ?? "");
    const title = squash(li.querySelector(".ecl-timeline__title")?.textContent ?? "");
    const content = squash(li.querySelector(".ecl-timeline__content")?.textContent ?? "");
    const m = /^(\d{1,2})\.(\d{2})\.(\d{4})/.exec(label);
    if (!label || !title) continue;
    out.push({ label, iso: m ? `${m[3]}-${m[2]}-${m[1]!.padStart(2, "0")}` : null, title, content });
  }
  return out;
}

export interface Candidate {
  name: string;
  facts: string[];
  /** true: kraj ma status kandydata (jest linia "Status kandydata ..."). */
  candidate: boolean;
}

/** Kraje kandydujące i potencjalni kandydaci: akordeon <details> z nazwą kraju w <summary> i listą faktów. */
export function parseCandidates(html: string): Candidate[] {
  const { document } = parseHtmlPage(html);
  const out: Candidate[] = [];
  for (const d of Array.from(document.querySelectorAll("details.ecl-accordion__item"))) {
    const summary = d.querySelector("summary");
    const name = squash(Array.from(summary?.childNodes ?? []).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? "").join(" "));
    const facts = Array.from(d.querySelectorAll("li")).map((li) => squash(li.textContent ?? "")).filter(Boolean);
    if (!name || facts.length === 0 || !facts.some((f) => /^Wniosek o członkostwo w UE/.test(f))) continue;
    out.push({ name, facts, candidate: facts.some((f) => /^Status kandydata/.test(f)) });
  }
  return out;
}

export async function ingestEuMembership(client: PoliteClient, opts: IngestOptions, result: IngestResult): Promise<void> {
  const src = sourceFromCatalog(opts.catalog, "eu-portal");
  const base = baseFromCatalog(src);
  const push = (r: Omit<CorpusRecord, keyof ReturnType<typeof baseFromCatalog> | "origin" | "lang"> & { lang?: string }) =>
    result.records.push({ ...base, lang: "pl", origin: "corpus", ...r } as CorpusRecord);

  // 1. Lista krajów UE
  try {
    const res = await client.get(EU_COUNTRIES_URL);
    const { text } = parseHtmlPage(res.body, "main");
    const updated = parseLastUpdate(text);
    const rows = parseCountryList(res.body);
    if (rows.length < 27) result.skipped.push({ what: EU_COUNTRIES_URL, reason: `znaleziono ${rows.length} z 27 krajów` });
    for (const r of rows) {
      push({
        id: recordId("eu-portal", `${EU_COUNTRIES_URL}|${r.slug}`),
        url: res.finalUrl,
        title: `Unia Europejska: ${r.name} — członkostwo w UE, strefie euro i strefie Schengen`,
        publishedAt: updated,
        fetchedAt: res.fetchedAt,
        text: r.sentence,
        topics: ["ue", "czlonkostwo-w-ue", "data-przystapienia", "strefa-euro", "schengen", "profil-panstwa", r.slug === "poland" ? "polska" : r.slug],
      });
    }
    opts.log(`  portal UE, lista krajów: ${rows.length} zdań`);
  } catch (e) {
    result.skipped.push({ what: EU_COUNTRIES_URL, reason: (e as Error).message });
  }

  // 2. Strefa euro
  try {
    const res = await client.get(EURO_AREA_URL);
    const updated = parseLastUpdate(parseHtmlPage(res.body, "main").text);
    const lists = parseEuroArea(res.body);
    if (!lists) throw new Error("nie rozpoznano układu strony (listy krajów strefy euro)");
    const topics = ["ue", "strefa-euro", "waluta", "euro", "czlonkostwo-w-ue", "lista-panstw"];
    push({
      id: recordId("eu-portal", `${EURO_AREA_URL}|inside`),
      url: res.finalUrl,
      title: "Unia Europejska: kraje strefy euro (lista państw UE, w których obowiązuje euro)",
      publishedAt: updated,
      fetchedAt: res.fetchedAt,
      text: [lists.insideLead, ...lists.inside].join("\n"),
      topics,
    });
    push({
      id: recordId("eu-portal", `${EURO_AREA_URL}|outside`),
      url: res.finalUrl,
      title: "Unia Europejska: państwa UE poza strefą euro (Czechy, Węgry, Polska, Rumunia, Szwecja, Dania)",
      publishedAt: updated,
      fetchedAt: res.fetchedAt,
      text: [lists.outsideLead, ...lists.outside, lists.denmarkLead, lists.denmark].filter(Boolean).join("\n"),
      topics: [...topics, "polska"],
    });
    opts.log(`  portal UE, strefa euro: ${lists.inside.length} państw w strefie, ${lists.outside.length + (lists.denmark ? 1 : 0)} poza`);
  } catch (e) {
    result.skipped.push({ what: EURO_AREA_URL, reason: (e as Error).message });
  }

  // 3. Rozszerzenie: oś czasu i kraje kandydujące
  try {
    const res = await client.get(ENLARGEMENT_URL);
    const parsed = parseHtmlPage(res.body, "main");
    const updated = parseLastUpdate(parsed.text);
    const timeline = parseEnlargementTimeline(res.body);
    for (const t of timeline) {
      push({
        id: recordId("eu-portal", `${ENLARGEMENT_URL}|timeline|${t.label}`),
        url: res.finalUrl,
        title: `Unia Europejska: historia rozszerzeń UE — ${t.title.trim()} (${t.label})`,
        publishedAt: updated,
        fetchedAt: res.fetchedAt,
        text: `Oś czasu rozszerzeń UE (portal UE), ${t.label}: ${t.title}. ${t.content}`.replace(/\s+\./g, "."),
        topics: ["ue", "rozszerzenie-ue", "czlonkostwo-w-ue", "data-przystapienia", "historia-ue", "generated-from-data"],
        ...(t.iso ? { period: t.iso } : {}),
      });
    }
    const leadLines = parsed.text.split("\n").map(squash);
    const founders = leadLines.find((l) => /^Unię Europejską założyło sześć krajów\./.test(l));
    if (founders) {
      push({
        id: recordId("eu-portal", `${ENLARGEMENT_URL}|founders`),
        url: res.finalUrl,
        title: "Unia Europejska: liczba państw członkowskich i rozszerzeń UE",
        publishedAt: updated,
        fetchedAt: res.fetchedAt,
        text: founders,
        topics: ["ue", "rozszerzenie-ue", "czlonkostwo-w-ue", "historia-ue"],
      });
    }
    const candidates = parseCandidates(res.body);
    const ten = leadLines.find((l) => /trwa proces akcesyjny dziesięciu krajów kandydujących/.test(l));
    for (const c of candidates) {
      push({
        id: recordId("eu-portal", `${ENLARGEMENT_URL}|candidate|${c.name}`),
        url: res.finalUrl,
        title: `Unia Europejska: ${c.name} — ${c.candidate ? "kraj kandydujący do UE (daty wniosku i statusu kandydata)" : "potencjalny kandydat do UE"}`,
        publishedAt: updated,
        fetchedAt: res.fetchedAt,
        text: `${c.name} (${c.candidate ? "kraj kandydujący do UE" : "potencjalny kandydat do UE"}), portal UE: ${c.facts.join(" ")}`,
        topics: ["ue", "rozszerzenie-ue", c.candidate ? "kraj-kandydujacy" : "potencjalny-kandydat", "status-kandydata", c.name.toLowerCase().replace(/\s+/g, "-"), "generated-from-data"],
      });
    }
    if (ten) {
      push({
        id: recordId("eu-portal", `${ENLARGEMENT_URL}|ten-candidates`),
        url: res.finalUrl,
        title: "Unia Europejska: liczba krajów kandydujących do UE",
        publishedAt: updated,
        fetchedAt: res.fetchedAt,
        text: ten,
        topics: ["ue", "rozszerzenie-ue", "kraj-kandydujacy", "status-kandydata"],
      });
    }
    opts.log(`  portal UE, rozszerzenie: ${timeline.length} pozycji osi czasu, ${candidates.length} krajów kandydujących/potencjalnych`);
    if (candidates.length < 9) result.skipped.push({ what: ENLARGEMENT_URL, reason: `znaleziono ${candidates.length} krajów kandydujących (oczekiwano >= 9)` });
  } catch (e) {
    result.skipped.push({ what: ENLARGEMENT_URL, reason: (e as Error).message });
  }
}
