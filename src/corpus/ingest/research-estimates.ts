import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { baseFromCatalog, newResult, plainPageText, PoliteClient, recordId, sourceFromCatalog, squash, type IngestOptions } from "./common";
import { pdfToText } from "./eli";

interface Publication {
  sourceId: string;
  title: string;
  url: string;
  period: string;
  publishedAt: string | null;
  lang: "pl" | "en";
  topics: string[];
  passage: RegExp;
  pdf?: boolean;
  supersededAt?: string;
}

const publications: Publication[] = [
  { sourceId: "sg-pl", title: "Straż Graniczna — próby nielegalnego przekroczenia granicy polsko-białoruskiej w 2023 r.",
    url: "https://www.strazgraniczna.pl/pl/aktualnosci/12829,Miniona-doba-bez-prob-nielegalnego-przekroczenia.html",
    period: "2023", publishedAt: "2024-01-09", lang: "pl", topics: ["granica polsko-białoruska", "migracja", "statystyka"],
    passage: /W ubiegłym roku \d{4} odnotowano .{1,120}?z Białorusi do Polski\./u },
  { sourceId: "cbos", title: "CBOS — Polacy o integracji europejskiej, sondaż ze stycznia 2026 r.",
    url: "https://www.cbos.pl/PL/publikacje/raporty_tekst.php?id=7158",
    period: "2026-01", publishedAt: "2026-02-17", lang: "pl", topics: ["Polska", "poparcie dla członkostwa w Unii Europejskiej", "sondaż"],
    passage: /Poparcie dla członkostwa w UE deklaruje .{1,30}?badanych\. Przeciwnych mu jest .{1,30}?ankietowanych\./u },
  { sourceId: "eurostat", title: "Eurostat — osoby objęte ochroną czasową w Polsce i innych krajach UE, wrzesień 2026 r.",
    url: "https://ec.europa.eu/eurostat/en/web/products-eurostat-news/w/ddn-20261110-1",
    period: "2026-09-30", publishedAt: "2026-11-10", lang: "en", topics: ["Polska", "uchodźcy z Ukrainy", "ochrona czasowa"],
    passage: /Germany \(.{1,170}?beneficiaries of temporary protection from Ukraine\./u },
  { sourceId: "unhcr-data", title: "UNHCR — Ukraine Situation Regional Refugee Response Plan, liczba osób w Polsce na koniec 2023 r.",
    url: "https://data.unhcr.org/en/documents/download/105903", pdf: true,
    period: "2023-12-31", publishedAt: null, lang: "en", topics: ["Polska", "uchodźcy z Ukrainy", "PESEL", "populacja"],
    passage: /In Poland, as of end December \d{4}, .{1,155}?asylum-seekers\./u },
  { sourceId: "kse-institute", title: "KSE Institute — Assessing Russia’s Shadow Fleet, pierwszy kwartał 2024 r.",
    url: "https://institute.kse.ua/wp-content/uploads/2026/02/assessing_russias_shadow_fleet_eng_june_2024.pdf", pdf: true,
    period: "2024-Q1", publishedAt: null, lang: "en", topics: ["rosyjska flota cieni", "tankowce", "ropa", "sankcje"],
    passage: /We estimate that, as of the first quarter .{1,270}?the price cap does not apply to them\./u },
  { sourceId: "sipri", title: "SIPRI — Rosja, wydatki wojskowe jako procent PKB w 2024 r., publikacja z kwietnia 2025 r.",
    url: "https://www.sipri.org/publications/2025/sipri-fact-sheets/trends-world-military-expenditure-2024",
    period: "2024", publishedAt: "2025-04-28", supersededAt: "2026-04-27", lang: "en", topics: ["Rosja", "wojsko", "wydatki wojskowe", "PKB"],
    passage: /Russia’s military spending grew by .{1,160}?Russia’s GDP\./u },
  { sourceId: "iiss", title: "IISS — The Military Balance 2025, Rosja i udział wydatków wojskowych w PKB w 2024 r.",
    url: "https://www.iiss.org/publications/the-military-balance/2025/dr-bastian-giegerichs-launch-event-remarks/",
    period: "2024", publishedAt: "2025-02-12", lang: "en", topics: ["Rosja", "wojsko", "wydatki wojskowe", "PKB"],
    passage: /Russia’s total military expenditure grew by .{1,180}?% of GDP/u },
  { sourceId: "gov-pl", title: "Ministerstwo Obrony Narodowej — plan wydatków na obronność Polski na 2025 r.",
    url: "https://www.gov.pl/web/obrona-narodowa/rok-pracy-na-rzecz-wzmacniania-bezpieczenstwa-i-rozwoju-wojska-polskiego",
    period: "2025", publishedAt: "2024-12-13", lang: "pl", topics: ["Polska", "wydatki wojskowe", "budżet obronny", "plan", "PKB"],
    passage: /W \d{4} roku wydatki obronne osiągną poziom .{1,220}?pułap .{1,15}?PKB\./u },
  { sourceId: "gov-pl", title: "KRRiT — szacunki frekwencji policji i organizatora, Marsz Niepodległości w Warszawie 11 listopada 2026 r.",
    url: "https://www.gov.pl/web/krrit/marsz-niepodleglosci-w-przekazach-telewizyjnych--raport-z-monitoringu-krrit",
    period: "2026-11-11", publishedAt: "2026-11-20", lang: "pl", topics: ["Marsz Niepodległości", "Warszawa", "frekwencja", "policja"],
    passage: /Według szacunków policji w Marszu Niepodległości .{1,220}?uczestników\./u },
  { sourceId: "marsz-organizator", title: "Stowarzyszenie Marsz Niepodległości — frekwencja 11 listopada 2026 r. w Warszawie według organizatora",
    url: "https://marszniepodleglosci.pl/", period: "2026-11-11", publishedAt: null, lang: "pl",
    topics: ["Marsz Niepodległości", "Warszawa", "frekwencja", "organizator"],
    passage: /Marsz przeszedł ulicami Warszawy\.\s*Wzięło w nim udział .{1,50}?osób\./u },
  { sourceId: "marsz-organizator", title: "Stowarzyszenie Marsz Niepodległości — komunikat po marszu w Warszawie 11 listopada 2026 r.",
    url: "https://marszniepodleglosci.pl/marsz-niepodleglosci-2026-moglo-byc-nas-nawet-milion/",
    period: "2026-11-11", publishedAt: null, lang: "pl", topics: ["Marsz Niepodległości", "Warszawa", "frekwencja", "organizator"],
    passage: /Szacowaliśmy, że liczba uczestników mogła .{1,140}?miliona\./u },
];

export const milexUrl = "https://www.sipri.org/sites/default/files/SIPRI-Milex-data-1949-2025_v1.2.xlsx";

export function expenditureRows(data: Buffer) {
  const script = fileURLToPath(new URL("./sipri-series.py", import.meta.url));
  const result = execFileSync("python3", [script], { input: data, encoding: "utf8", timeout: 20_000 });
  const values = JSON.parse(result) as { country: string; year: string; percent: string }[];
  return values.map(({country, year, percent}) => ({country, year,
    text: `SIPRI Military Expenditure Database, wydanie 1949–2025 v1.2. ${country}, ${year} r. Wydatki wojskowe w stosunku do PKB według szacunku SIPRI wyniosły ${percent}%.` }));
}

/** IISS serializes the article as JSON for its Reading component. Read only its public HTML field, without executing page scripts. */
export function estimatePageText(html: string, sourceId: string): string {
  if (sourceId !== "iiss") return plainPageText(html);
  const {document} = parseHTML(html);
  for (const script of document.querySelectorAll("script")) {
    const content = script.textContent ?? "";
    if (!content.includes("React.createElement(Components.Reading,")) continue;
    const htmlField = content.match(/"Html":("(?:\\.|[^"\\])*")/u);
    if (htmlField) return plainPageText("<article>" + String(JSON.parse(htmlField[1]!)) + "</article>", "");
  }
  return plainPageText(html);
}

export async function ingestResearchEstimates(opts: IngestOptions) {
  const result = newResult("research-estimates");
  result.fileId = result.id;
  const client = new PoliteClient({refresh: opts.refresh});
  for (const publication of publications) {
    const source = sourceFromCatalog(opts.catalog, publication.sourceId);
    const page = publication.pdf ? await client.getBinary(publication.url) : await client.get(publication.url);
    if (!source.hosts.includes(new URL(page.finalUrl).hostname)) throw new Error("Przekierowanie poza host wydawcy: " + publication.url);
    const text = "data" in page ? squash(await pdfToText(page.data)) : estimatePageText(page.body, source.id);
    if (publication.url === "https://marszniepodleglosci.pl/" && !text.includes("11.11.2026")) throw new Error("Zmieniono edycję wydarzenia na stronie organizatora");
    const excerpt = text.match(publication.passage)?.[0] ?? ("body" in page ? plainPageText(page.body, "").match(publication.passage)?.[0] : undefined);
    if (!excerpt || excerpt.length > 300) throw new Error("Brak fragmentu publikacji: " + publication.url);
    const {title, publishedAt, period, lang, topics} = publication;
    result.records.push({...baseFromCatalog(source), id: recordId(source.id, page.finalUrl), url: page.finalUrl, title, publishedAt, period,
      ...(publication.supersededAt ? {supersededAt: publication.supersededAt} : {}), lang, topics, text: excerpt, fetchedAt: page.fetchedAt, origin: "corpus"});
  }
  const sipri = sourceFromCatalog(opts.catalog, "sipri");
  const book = await client.getBinary(milexUrl);
  if (!sipri.hosts.includes(new URL(book.finalUrl).hostname)) throw new Error("Przekierowanie poza host SIPRI");
  for (const { country, year, text } of expenditureRows(book.data)) {
    result.records.push({...baseFromCatalog(sipri), id: recordId(sipri.id, [milexUrl, country, year].join("|")), url: book.finalUrl,
      title: `SIPRI — ${country}, udział wydatków wojskowych w PKB w ${year} r., baza 1949–2025 v1.2`, publishedAt: "2026-04-27", period: year,
      text, lang: "pl", topics: [country, "wojsko", "wydatki wojskowe", "PKB", "generated-from-data"], origin: "corpus", fetchedAt: book.fetchedAt});
  }
  result.requests = client.requests;
  return result;
}
