/**
 * Ingestia stron raportów EEAS o zagranicznej manipulacji informacją i ingerencją (FIMI).
 * Strony zawierają krótkie streszczenia raportów (pełne raporty to PDF-y, których nie przetwarzamy).
 * Robots.txt EEAS ma Crawl-delay: 10 s — klient grzecznościowy go respektuje.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, chunkText, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

const PAGES = [
  "https://www.eeas.europa.eu/eeas/1st-eeas-report-foreign-information-manipulation-and-interference-threats_en",
  "https://www.eeas.europa.eu/eeas/2nd-eeas-report-foreign-information-manipulation-and-interference-threats_en",
  "https://www.eeas.europa.eu/eeas/3rd-eeas-report-foreign-information-manipulation-and-interference-threats_en",
  "https://www.eeas.europa.eu/eeas/4th-eeas-report-foreign-information-manipulation-and-interference-threats_en",
  "https://www.eeas.europa.eu/eeas/tackling-disinformation-foreign-information-manipulation-interference_en",
];

export async function ingestEeas(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("eeas");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "eeas");
  const base = baseFromCatalog(src);
  for (const url of PAGES) {
    try {
      const res = await client.get(url);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const parsed = parseHtmlPage(res.body, "main");
      const title = squash(parsed.title.replace(/\s*\|\s*EEAS.*$/i, ""));
      const body = parsed.text.split("\n").filter((l) => l !== title && l.length > 1).join("\n");
      if (body.length < 120) throw new Error("zbyt krótka treść strony");
      const date = parsed.document.querySelector("time")?.getAttribute("datetime")?.slice(0, 10) ?? null;
      chunkText(body, 1200).slice(0, 2).forEach((chunk, idx) => {
        const rec: CorpusRecord = {
          ...base,
          id: recordId("eeas", `${res.finalUrl}|${idx}`),
          url: res.finalUrl,
          title: `EEAS: ${title}${idx > 0 ? ` (cz. ${idx + 1})` : ""}`,
          publishedAt: date,
          fetchedAt: res.fetchedAt,
          lang: "en",
          text: chunk,
          topics: ["fimi", "dezinformacja", "ingerencja", "eeas", "rosja", "raport"],
          origin: "corpus",
        };
        result.records.push(rec);
      });
    } catch (e) {
      result.skipped.push({ what: url, reason: (e as Error).message });
    }
  }
  opts.log(`  EEAS: ${result.records.length} rekordów`);
  result.requests = client.requests;
  result.notes.push("Strony raportów FIMI EEAS (streszczenia). Pełne raporty (PDF) nie są przetwarzane. Crawl-delay 10 s z robots.txt respektowany.");
  return result;
}
