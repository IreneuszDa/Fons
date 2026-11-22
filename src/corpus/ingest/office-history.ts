import { PoliteClient, baseFromCatalog, parseHtmlPage, recordId, sourceFromCatalog, squash, type IngestOptions } from "./common";
import { incumbentRow, NATO_SECRETARIES_URL, previousRow } from "./nato-office-list";
import { pdfToText } from "./eli";
import { ingestOfficialPages } from "./officialpages";

interface ElectionAct {
  ELI: string;
  title: string;
  announcementDate: string;
  promulgation?: string;
  texts?: { fileName: string; type: string }[];
}

export async function ingestOfficeHistory(opts: IngestOptions) {
  const result = await ingestOfficialPages(opts, [{
    sourceId: "prezydent-pl", titlePrefix: "Kancelaria Prezydenta RP", lang: "pl", max: 2,
    topics: ["funkcja-publiczna", "prezydent-polski", "przekazanie-urzedu"],
    url: "https://www.prezydent.pl/aktualnosci/wydarzenia/zaprzysiezenie-prezydenta-rp-karola-nawrockiego-,104583",
    startAt: /formalnie objął urząd Prezydenta/, stopAt: /Po złożeniu przysięgi/,
  }], "office-history");
  const client = new PoliteClient({ refresh: opts.refresh });
  const nato = sourceFromCatalog(opts.catalog, "nato");
  const list = NATO_SECRETARIES_URL;
  try {
    const page = await client.get(list);
    if (page.status !== 200 || !nato.hosts.includes(new URL(page.finalUrl).hostname)) throw Error("Brak wykazu NATO");
    const lines = parseHtmlPage(page.body, "body").text.split("\n").map(squash);
    const start = lines.indexOf("NATO Secretaries General");
    const previous = lines.indexOf("Previous NATO Secretaries General", start + 1);
    if (start < 0 || previous <= start) throw Error("Brak rozdzielonych sekcji obecnego i poprzednich sekretarzy NATO");
    const current = lines.slice(start + 1, previous).flatMap((line, i) => incumbentRow(line, lines[start + 2 + i] ?? "") ?? []);
    const past = lines.slice(previous + 1).filter(line => previousRow(line));
    if (current.length !== 1 || !past.length || current[0]!.since > page.fetchedAt.slice(0, 10)) throw Error("Brak jednoznacznych wpisów w wykazie NATO");
    const active = current[0]!;
    result.records.push({ ...baseFromCatalog(nato), id: recordId(nato.id, list + "|incumbent"), url: page.finalUrl,
      title: active.quote.split("\n")[0]!, text: active.quote, fetchedAt: page.fetchedAt, publishedAt: null,
      period: page.fetchedAt.slice(0, 10), lang: "en", topics: ["funkcja-publiczna", "sekretarz-generalny-nato", "urzedujacy"], origin: "corpus" });
    for (const text of new Set(past)) {
      result.records.push({ ...baseFromCatalog(nato), id: recordId(nato.id, list + "|" + text), url: page.finalUrl,
        title: text, text, publishedAt: null, period: previousRow(text)!.period, fetchedAt: page.fetchedAt, lang: "en",
        topics: ["funkcja-publiczna", "sekretarz-generalny-nato", "kadencja"], origin: "corpus" });
    }
  } catch (error) { result.skipped.push({ what: list, reason: (error as Error).message }); }

  const sejm = sourceFromCatalog(opts.catalog, "sejm-eli");
  const endpoint = "https://api.sejm.gov.pl/eli/acts/search?title=" + encodeURIComponent("wyboru Marszałka Sejmu") + "&limit=100";
  const { data } = await client.getJson<{ items: ElectionAct[]; count: number }>(endpoint);
  if (data.items.length < data.count) throw Error("Niepełny wynik wyszukiwania ELI");
  for (const act of data.items.filter(act => /w sprawie wyboru Marszałka Sejmu\.?$/iu.test(act.title))) {
    const file = act.texts?.find(file => file.type === "O");
    if (!file) continue;
    const url = "https://api.sejm.gov.pl/eli/acts/" + act.ELI + "/text/O/" + file.fileName;
    try {
      const pdf = await client.getBinary(url);
      const text = squash(await pdfToText(pdf.data)).match(/(?:wybiera|dokonuje wyboru)\s+(?:posła|poseł|posłankę|Pana|Panią)\s+[^.]{4,155}?\s+na stanowisko Marszałka Sejmu\./iu)?.[0];
      if (!text) {
        result.skipped.push({ what: url, reason: "Brak czytelnego zdania o wyborze Marszałka Sejmu w PDF" });
        continue;
      }
      result.records.push({ ...baseFromCatalog(sejm), id: recordId(sejm.id, url + "|wybor"), url,
        title: act.title + " — " + text, publishedAt: act.promulgation ?? null, period: act.announcementDate,
        fetchedAt: pdf.fetchedAt, text, lang: "pl", topics: ["sejm", "marszalek-sejmu", "funkcja-publiczna", "wybor"], origin: "corpus" });
    } catch (error) { result.skipped.push({ what: url, reason: (error as Error).message }); }
  }
  result.requests += client.requests;
  return result;
}
