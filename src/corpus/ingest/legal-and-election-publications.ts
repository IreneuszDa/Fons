import type { CatalogSource, CorpusRecord } from "../../shared/contracts";
import { baseFromCatalog, blockText, parseHtmlPage, recordId, sourceFromCatalog, squash, type IngestResult, type PoliteClient } from "./common";
import { pdfToText } from "./eli";
import { detectPublishedAt } from "./officialpages";

interface Publication {
  sourceId: string;
  url: string;
  title: string;
  publishedAt: string;
  fetchedAt: string;
  text: string;
  topics: string[];
}

async function electionReport(client: PoliteClient): Promise<Publication> {
  const page = await client.get("https://www.gov.pl/web/cyfryzacja/raport-z-programu-parasol-wyborczy---kompleksowa-ochrona-wyborow-prezydenckich-2025");
  const parsed = parseHtmlPage(page.body);
  const attachment = parsed.document.querySelector('a[href="/attachment/437a6184-90e5-4f29-beaf-92b646eb18b0"]')?.getAttribute("href");
  const publishedAt = detectPublishedAt(parsed);
  if (!attachment || !publishedAt || new URL(page.finalUrl).hostname !== "www.gov.pl") throw new Error("Brak metadanych raportu w komunikacie Ministerstwa Cyfryzacji");
  const pdf = await client.getBinary(new URL(attachment, page.finalUrl).href);
  const text = squash(await pdfToText(pdf.data)).match(/Program stanowił [^.]{1,180}państwa polskiego[^.]{1,100}wyborów prezydenckich, których pierwsza tura odbyła się w dniu \d{1,2} \p{L}+ \d{4} r\. oraz druga tura \d{1,2} \p{L}+ \d{4} r\./u)?.[0];
  if (!text || text.length > 300) throw new Error("Nie znaleziono krótkiego zdania o obu datach głosowania w raporcie powyborczym");
  return { sourceId: "gov-pl", url: pdf.finalUrl, title: "Ministerstwo Cyfryzacji: " + parsed.title.split(" - Ministerstwo Cyfryzacji")[0],
    publishedAt, fetchedAt: pdf.fetchedAt, text, topics: ["wybory prezydenckie", "głosowanie", "pierwsza tura", "druga tura", "raport powyborczy", "Polska"] };
}

async function benefitLaw(client: PoliteClient): Promise<Publication> {
  const url = "https://api.sejm.gov.pl/eli/acts/DU/2026/508";
  const { data } = await client.getJson<{ title: string; promulgation: string; texts: { type: string; fileName: string }[] }>(url);
  const official = data.texts.find(t => t.type === "O");
  if (!official || !/^\d{4}-\d{2}-\d{2}$/.test(data.promulgation) || !data.title.includes("ustawy o pomocy państwa w wychowywaniu dzieci")) throw new Error("Brak zweryfikowanego ogłoszenia tekstu jednolitego w ELI");
  const pdf = await client.getBinary(url + "/text/O/" + official.fileName, { accept: "*/*" });
  const text = squash(await pdfToText(pdf.data)).match(/Art\. 5\. 1\. Świadczenie wychowawcze przysługuje osobom, o których mowa w art\. 4 ust\. 2, w wysokości [\d, ]+ zł miesięcznie na dziecko\./u)?.[0];
  if (!text) throw new Error("Nie odnaleziono pełnego art. 5 ust. 1 ze stawką świadczenia");
  return { sourceId: "sejm-eli", url: pdf.finalUrl, title: data.title + " — art. 5 ust. 1 (wysokość świadczenia wychowawczego)",
    publishedAt: data.promulgation, fetchedAt: pdf.fetchedAt, text, topics: ["akt-prawny", "rodzina", "świadczenie wychowawcze", "800 plus", "wysokość świadczenia", "program:800 plus", "stawka-programu"] };
}

async function councilDecision(client: PoliteClient): Promise<Publication> {
  const celex = "32020D2130";
  const fetched = await client.get("http://publications.europa.eu/resource/celex/" + celex, { accept: "application/xhtml+xml", headers: { "Accept-Language": "pol" } });
  const lines = blockText(parseHtmlPage(fetched.body).document.body).split("\n").map(squash);
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(lines[0] ?? "");
  const title = lines.find(l => l.includes("DECYZJA WYKONAWCZA RADY") && l.includes("2020/2130"));
  const start = lines.findIndex(l => l.includes("w następstwie wyborów prezydenckich na Białorusi"));
  const end = lines.findIndex(l => l.includes("do wykazu osób fizycznych i prawnych") && /dodać \d+ osób i \d+ podmiotów/u.test(l));
  if (!date || !title || start < 0 || end <= start || !["publications.europa.eu", "op.europa.eu"].includes(new URL(fetched.finalUrl).hostname)) throw new Error("Nie odnaleziono motywów decyzji Rady w Dzienniku Urzędowym UE");
  return { sourceId: "eur-lex", url: "https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:" + celex,
    title: title + " — sankcje Unii Europejskiej wobec Białorusi, osoby i podmioty w wykazie",
    publishedAt: date[3] + "-" + date[2] + "-" + date[1], fetchedAt: fetched.fetchedAt,
    text: lines.slice(start, end + 1).join(" "), topics: ["sankcje", "Białoruś", "wybory prezydenckie", "lista sankcyjna", "podmioty", "Rada Unii Europejskiej", "akt-prawny"] };
}

export async function addLegalAndElectionPublications(client: PoliteClient, catalog: CatalogSource[], result: IngestResult): Promise<void> {
  for (const load of [electionReport, benefitLaw, councilDecision]) {
    try {
      const publication = await load(client);
      const source = sourceFromCatalog(catalog, publication.sourceId);
      if (!source.hosts.includes(new URL(publication.url).hostname) || !publication.text || publication.text.length > 1500) throw new Error("Niezgodny host lub długość fragmentu publikacji");
      const record: CorpusRecord = { ...baseFromCatalog(source), ...publication, id: recordId(source.id, publication.url), lang: "pl", origin: "corpus" };
      result.records.push(record);
    } catch (error) {
      result.skipped.push({ what: load.name, reason: (error as Error).message });
    }
  }
}
