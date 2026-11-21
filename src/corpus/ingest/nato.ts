/**
 * Ingestia stron nato.int: lista członków (z datami przystąpienia), art. 5, rozszerzenie, relacje z Rosją
 * i Ukrainą, deklaracje szczytów. Rekord = fragment strony (<= 1200 znaków, dosłownie) + link.
 * Strony tematyczne mają w treści linię "Updated: <data>" — to jest publishedAt; dla tekstów oficjalnych
 * data pochodzi ze ścieżki URL (/rrrr/mm/dd/).
 */
import type { CorpusRecord } from "../../shared/contracts";
import { NATO_MEMBERS_URL, ingestNatoData } from "./nato-data";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, chunkText, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

interface NatoPage {
  url: string;
  topics: string[];
  max: number;
  /** Pomiń kawałki, w których nie ma tych słów (np. zostaw tylko fragmenty o Polsce/Ukrainie). */
  mustMatch?: RegExp;
  /** Polskie objaśnienie dopisywane do tytułu rekordu (tytuł nie jest cytatem; ułatwia wyszukiwanie po polsku). */
  titleNote?: string;
}

export const NATO_PAGES: NatoPage[] = [
  { url: "https://www.nato.int/en/about-us/organization/nato-member-countries", topics: ["nato", "czlonkostwo", "polska", "rozszerzenie-nato", "data-przystapienia"], max: 14 },
  { url: "https://www.nato.int/cps/en/natohq/topics_110496.htm", topics: ["nato", "artykul-5", "obrona-zbiorowa"], max: 8 },
  { url: "https://www.nato.int/en/what-we-do/partnerships-and-cooperation/enlargement-and-article-10", topics: ["nato", "rozszerzenie-nato", "artykul-10", "czlonkostwo"], max: 8 },
  { url: "https://www.nato.int/cps/en/natohq/topics_37750.htm", topics: ["nato", "ukraina", "wojna-w-ukrainie", "wsparcie"], max: 10 },
  { url: "https://www.nato.int/cps/en/natohq/topics_50090.htm", topics: ["nato", "rosja", "stosunki-nato-rosja", "bezpieczenstwo"], max: 10 },
  { url: "https://www.nato.int/en/what-we-do/introduction-to-nato/defence-expenditures-and-natos-5-commitment", topics: ["nato", "wydatki-na-obrone", "5-procent-pkb", "obronnosc", "haga-2025"], max: 6, titleNote: "wydatki obronne NATO, zobowiązanie 5% PKB" },
  { url: "https://www.nato.int/cps/en/natohq/topics_49198.htm", topics: ["nato", "wydatki-na-obrone", "5-procent-pkb", "obronnosc"], max: 6 },
  { url: "https://www.nato.int/cps/en/natohq/topics_68144.htm", topics: ["nato", "cel-nato", "traktat-polnocnoatlantycki"], max: 4 },
  { url: "https://www.nato.int/cps/en/natohq/topics_156338.htm", topics: ["nato", "zagrozenia-hybrydowe", "dezinformacja", "bezpieczenstwo"], max: 6 },
  { url: "https://www.nato.int/cps/en/natohq/topics_133127.htm", topics: ["nato", "odstraszanie", "obrona", "wschodnia-flanka"], max: 8 },
  { url: "https://www.nato.int/cps/en/natohq/topics_67655.htm", topics: ["nato", "finansowanie-nato", "budzet"], max: 5 },
  { url: "https://www.nato.int/cps/en/natohq/official_texts_227678.htm", topics: ["nato", "deklaracja-szczytu", "ukraina", "rosja", "waszyngton-2024"], max: 12 },
  { url: "https://www.nato.int/cps/en/natohq/official_texts_196951.htm", topics: ["nato", "deklaracja-szczytu", "ukraina", "rosja", "madryt-2022"], max: 8 },
  { url: "https://www.nato.int/en/about-us/official-texts-and-resources/official-texts/2025/06/25/the-hague-summit-declaration", topics: ["nato", "deklaracja-szczytu", "5-procent-pkb", "haga-2025"], max: 6 },
  { url: "https://www.nato.int/en/about-us/official-texts-and-resources/official-texts/1949/04/04/the-north-atlantic-treaty", topics: ["nato", "traktat-polnocnoatlantycki", "artykul-5", "artykul-10"], max: 10 },
  { url: "https://www.nato.int/en/what-we-do/deterrence-and-defence/nato-s-military-presence-in-the-east-of-the-alliance", topics: ["nato", "wschodnia-flanka", "polska", "grupy-bojowe"], max: 8 },
  { url: "https://www.nato.int/en/what-we-do/operations-and-missions/eastern-sentry", topics: ["nato", "wschodnia-flanka", "polska", "drony", "eastern-sentry"], max: 6 },
  // Kto jest Sekretarzem Generalnym NATO (strona zawiera zdanie "The post is currently held by ...").
  { url: "https://www.nato.int/en/about-us/organization/nato-structure/nato-secretary-general", topics: ["nato", "sekretarz-generalny", "kto-jest", "funkcja-publiczna", "urzednicy"], max: 3, titleNote: "Sekretarz Generalny NATO" },
];

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function parseUpdated(lines: string[]): string | null {
  for (const l of lines.slice(0, 12)) {
    const m = /^(?:Updated|Last updated):?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(l);
    if (m) {
      const mm = MONTHS[m[2]!.toLowerCase()];
      if (mm) return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
    }
  }
  return null;
}

function dateFromPath(url: string): string | null {
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export async function ingestNato(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("nato");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "nato");
  const base = baseFromCatalog(src);
  let membersInput: Parameters<typeof ingestNatoData>[3] = null;

  for (const page of NATO_PAGES) {
    try {
      const res = await client.get(page.url);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const parsed = parseHtmlPage(res.body, ".article-text-wrapper");
      const h1 = parseHtmlPage(res.body, "h1").text.split("\n")[0] ?? "";
      let lines = parsed.text.split("\n");
      const h1Idx = h1 ? lines.findIndex((l) => l === h1) : -1;
      if (h1Idx >= 0) lines = lines.slice(h1Idx + 1);
      else {
        const rp = lines.findIndex((l) => /^Your password has been updated$/.test(l));
        if (rp >= 0) lines = lines.slice(rp + 1);
      }
      const title = squash(parsed.title.replace(/\s*\|\s*NATO.*$/i, "")) || h1 || page.url;
      if (/^404|not found/i.test(title)) throw new Error("strona nie istnieje (404)");
      const publishedAt = parseUpdated(lines) ?? dateFromPath(res.finalUrl);
      // "Poland" + rok w osobnych liniach (lista członków) łączymy w jedną linię.
      const merged: string[] = [];
      for (const l of lines) {
        if (/^\d{4}$/.test(l) && merged.length > 0 && merged[merged.length - 1]!.length < 40 && !/\d{4}$/.test(merged[merged.length - 1]!)) {
          merged[merged.length - 1] = `${merged[merged.length - 1]} ${l}`;
        } else merged.push(l);
      }
      // Bez linii typu "Updated: ..." i nawigacji.
      const body = merged.filter((l) => !/^(Updated|Last updated):/.test(l) && l.length > 1);
      let chunks = chunkText(body.join("\n"), 1200).filter((c) => c.length >= 80);
      if (page.mustMatch) chunks = chunks.filter((c) => page.mustMatch!.test(c));
      chunks = chunks.slice(0, page.max);
      if (page.url === NATO_MEMBERS_URL) membersInput = { lines: merged, pageText: parsed.text, url: res.finalUrl, fetchedAt: res.fetchedAt, publishedAt };
      chunks.forEach((chunk, idx) => {
        const rec: CorpusRecord = {
          ...base,
          id: recordId("nato", `${res.finalUrl}|${idx}`),
          url: res.finalUrl,
          title: `NATO: ${title}${page.titleNote ? ` (${page.titleNote})` : ""}${chunks.length > 1 ? ` (cz. ${idx + 1})` : ""}`,
          publishedAt,
          fetchedAt: res.fetchedAt,
          lang: "en",
          text: chunk,
          topics: [...page.topics, "komunikat-instytucji"],
          origin: "corpus",
        };
        result.records.push(rec);
      });
      opts.log(`  NATO ${title}: ${chunks.length} rekordów (publishedAt=${publishedAt ?? "brak"})`);
      if (chunks.length === 0) result.skipped.push({ what: page.url, reason: "brak treści po filtrach" });
    } catch (e) {
      result.skipped.push({ what: page.url, reason: (e as Error).message });
    }
  }
  await ingestNatoData(client, opts, result, membersInput);
  result.requests = client.requests;
  result.notes.push("Strony nato.int zawierają linię 'Updated: <data>' (publishedAt); gdy jej brak, data ze ścieżki URL tekstu oficjalnego, inaczej null.");
  return result;
}
