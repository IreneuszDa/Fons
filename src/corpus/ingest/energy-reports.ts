import { parseHTML } from "linkedom";
import type { CorpusRecord } from "../../shared/contracts";
import { baseFromCatalog, newResult, PoliteClient, recordId, sourceFromCatalog, squash, type IngestOptions } from "./common";
import { pdfToText } from "./eli";

const report = "https://commission.europa.eu/system/files/2022-10/quarterly_report_on_european_gas_markets_q2_2022_final_0.pdf";
const statement = "https://kormany.hu/hirek/szijjarto-peter-a-magyarorszagra-iranyulo-foldgazszallitas-szerzodes-utemterv-szerint-es-zavartalanul-zajlik";

export async function ingestEnergyReports(opts: IngestOptions) {
  const result = newResult("energy-reports");
  result.fileId = result.id;
  const client = new PoliteClient({ refresh: opts.refresh });
  const pdf = await client.getBinary(report);
  const pdfText = squash(await pdfToText(pdf.data));
  const cutoff = /On 27 April, Gazprom terminated all shipments to Poland and Bulgaria[^.]*\./u.exec(pdfText)?.[0];
  const page = await client.get(statement);
  const doc = parseHTML(page.body).document;
  const timestamp = doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content");
  const htmlTitle = doc.querySelector("h1")?.textContent;
  const body = [...doc.querySelectorAll("p")].map(p => squash(p.textContent ?? ""));
  const delivery = body.find(p => p.startsWith("A Magyarországra irányuló földgázszállítás "))?.match(/^[^.]+\./u)?.[0];
  const transit = body.join(" ").match(/A hír azonban úgy pontos,[^.]+\. A Gazprom tájékoztatása szerint[^.]+\./u)?.[0];
  if (!cutoff || !delivery || !transit || !timestamp || !htmlTitle || page.status !== 200) throw new Error("Brak kompletnej pary źródłowych komunikatów o dostawach gazu.");
  const records = [
    { sourceId: "ec-commission", url: pdf.finalUrl, fetchedAt: pdf.fetchedAt, publishedAt: null, lang: "en",
      title: "Komisja Europejska – Quarterly Report on European Gas Markets, II kwartał 2022, sekcja 1.4", text: cutoff,
      topics: ["gaz ziemny", "Gazprom", "Polska", "Bułgaria", "rynek gazu"] },
    { sourceId: "hungarian-government", url: page.finalUrl, fetchedAt: page.fetchedAt, publishedAt: timestamp.slice(0, 10), lang: "hu",
      title: "Rząd Węgier – dostawy gazu na Węgry, 27 kwietnia 2022. " + squash(htmlTitle), text: delivery + " […] " + transit,
      topics: ["gaz ziemny", "Gazprom", "Węgry", "Hungary", "rynek gazu"] },
  ];
  for (const item of records) {
    const publisher = sourceFromCatalog(opts.catalog, item.sourceId);
    if (!publisher.hosts.includes(new URL(item.url).hostname)) throw new Error("Dokument pochodzi z innego hosta niż źródło.");
    const record: CorpusRecord = { ...baseFromCatalog(publisher), ...item, id: recordId(item.sourceId, item.url),
      period: "2022-04", origin: "corpus" };
    result.records.push(record);
  }
  result.requests = client.requests;
  return result;
}
