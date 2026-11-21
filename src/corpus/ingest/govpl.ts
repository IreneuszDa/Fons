/**
 * Ingestia komunikatów ministerstw z serwisu gov.pl (MSZ, MON, MSWiA, KPRM).
 * Licencja otwarta nie jest potwierdzona, więc zapisujemy metadane + krótki cytat (<= 300 znaków,
 * prefiks dosłownego tekstu komunikatu) + link. Lista aktualności ministerstwa -> filtr tematyczny -> strona komunikatu.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestOptions, type IngestResult, MAX_QUOTE_CHARS, baseFromCatalog, clipVerbatim, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

interface GovList {
  path: string;
  publisher: string;
  pages: number;
  topics: string[];
}

export const GOV_LISTS: GovList[] = [
  { path: "/web/dyplomacja/aktualnosci", publisher: "Ministerstwo Spraw Zagranicznych (gov.pl)", pages: 8, topics: ["msz", "polityka-zagraniczna"] },
  { path: "/web/obrona-narodowa/aktualnosci", publisher: "Ministerstwo Obrony Narodowej (gov.pl)", pages: 5, topics: ["mon", "obronnosc"] },
  { path: "/web/mswia/aktualnosci", publisher: "Ministerstwo Spraw Wewnętrznych i Administracji (gov.pl)", pages: 5, topics: ["mswia", "granica", "bezpieczenstwo"] },
  { path: "/web/premier/aktualnosci", publisher: "Kancelaria Prezesa Rady Ministrów (gov.pl)", pages: 5, topics: ["kprm", "rzad"] },
];

const RELEVANT =
  /Rosj|rosyjsk|Ukrain|Białor|NATO|Sojusz|sankcj|dezinformac|manipulacj\w+ informac|agresj|cyberatak|hybrydow|sabota|przestrzeni powietrznej|dron\w* (?:rosyjsk|nad Polsk|w Polsce)|ochron\w+ granic|granic\w+ z (?:Białorusi|Ukrain)|migrac|uchodź|azyl|Kreml|Moskw|Mińsk|Kijów|wschodni\w+ flank|Unii Europejskiej|Rad\w+ UE|Komisj\w+ Europejsk|gaz\w* ziemn|ropy naftowej|Sił Zbrojnych|obronnoś|integralnoś\w+ terytorial|wyborcz/i;

function isoFromPl(d: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

interface ListItem {
  date: string | null;
  title: string;
  href: string;
  intro: string;
}

function parseList(html: string): ListItem[] {
  const { document } = parseHtmlPage(html);
  const items: ListItem[] = [];
  for (const li of Array.from(document.querySelectorAll(".art-prev li"))) {
    const a = li.querySelector(".title a");
    const href = a?.getAttribute("href");
    if (!a || !href) continue;
    items.push({
      date: isoFromPl(squash(li.querySelector(".date")?.textContent ?? "")),
      title: squash(a.textContent ?? ""),
      href,
      intro: squash(li.querySelector(".intro")?.textContent ?? ""),
    });
  }
  return items;
}

export async function ingestGovPl(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("gov-pl");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "gov-pl");
  const base = baseFromCatalog(src);
  const seen = new Set<string>();

  for (const list of GOV_LISTS) {
    for (let page = 1; page <= list.pages; page++) {
      const url = `https://www.gov.pl${list.path}${page > 1 ? `?page=${page}` : ""}`;
      let items: ListItem[];
      try {
        const res = await client.get(url);
        items = parseList(res.body);
      } catch (e) {
        result.skipped.push({ what: url, reason: (e as Error).message });
        break;
      }
      if (items.length === 0) break;
      for (const it of items) {
        if (seen.has(it.href)) continue;
        if (!RELEVANT.test(`${it.title} ${it.intro}`)) continue;
        seen.add(it.href);
        const articleUrl = new URL(it.href, "https://www.gov.pl").toString();
        try {
          const res = await client.get(articleUrl);
          const parsed = parseHtmlPage(res.body, "article.article-area__article");
          const lines = parsed.text.split("\n").filter((l) => l !== it.title && !/^\d{2}\.\d{2}\.\d{4}$/.test(l));
          const body = squash(lines.join(" "));
          if (body.length < 60) {
            result.skipped.push({ what: articleUrl, reason: "zbyt krótka treść komunikatu" });
            continue;
          }
          const quote = clipVerbatim(body, MAX_QUOTE_CHARS);
          const rec: CorpusRecord = {
            ...base,
            publisher: list.publisher,
            id: recordId("gov-pl", articleUrl),
            url: articleUrl,
            title: it.title,
            publishedAt: it.date,
            fetchedAt: res.fetchedAt,
            lang: "pl",
            text: quote,
            topics: [...list.topics, "komunikat-urzedowy"],
            origin: "corpus",
          };
          result.records.push(rec);
        } catch (e) {
          result.skipped.push({ what: articleUrl, reason: (e as Error).message });
        }
        if (opts.limit && result.records.length >= opts.limit) break;
      }
      if (opts.limit && result.records.length >= opts.limit) break;
    }
    opts.log(`  gov.pl ${list.path}: łącznie ${result.records.length} rekordów`);
  }
  result.requests = client.requests;
  result.notes.push("Tylko komunikaty o tematyce zagranicznej/obronnej/granicznej (filtr słów kluczowych); cytat to prefiks treści komunikatu (<= 300 znaków).");
  return result;
}
