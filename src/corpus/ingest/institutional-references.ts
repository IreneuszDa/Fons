import { ingestOfficialPages, type PageSpec } from "./officialpages";
import { PoliteClient, baseFromCatalog, newResult, recordId, sourceFromCatalog, squash, type IngestOptions } from "./common";
import { pdfToText } from "./eli";
import { parseHTML } from "linkedom";
import { MONTHS_GENITIVE_PL } from "../../security/dates";
import { benefitGuide, benefitGuideRecords } from "./benefit-rates";
import { addLegalAndElectionPublications } from "./legal-and-election-publications";

// Reference material on European institutions and geography. Search and verdict rules remain common to every source.
const pages: PageSpec[] = [
  { sourceId: "gov-pl", titlePrefix: "Ministerstwo Rodziny, Pracy i Polityki Społecznej", lang: "pl", max: 1,
    topics: ["rodzina", "świadczenie wychowawcze", "800 plus", "wysokość świadczenia", "dzieci"],
    url: "https://www.gov.pl/web/rodzina/najwazniejsze-informacje-o-programie-rodzina-502",
    startAt: /^W ramach tego programu rodzinom/u, stopAt: /^Ustalaniem prawa do świadczenia/u,
    maxExcerptLength: 300 },
  { sourceId: "zus-swiadczenia", titlePrefix: "ZUS", lang: "pl", max: 1,
    topics: ["rodzina", "świadczenie wychowawcze", "800 plus", "obywatele Ukrainy", "kwota świadczenia"],
    url: "https://www.zus.pl/-/500-dla-obywateli-ukrainy",
    startAt: /kwota świadczenia wychowawczego jest podniesiona/u, quoteContaining: /kwota świadczenia wychowawczego jest podniesiona/u },
  { sourceId: "zus-swiadczenia", titlePrefix: "ZUS", lang: "pl", max: 1,
    topics: ["rodzina", "świadczenie wychowawcze", "800 plus", "kwota świadczenia"],
    url: "https://www.zus.pl/swiadczenia/swiadczenia-dla-rodzin/pytania-i-odpowiedzi-swiadczenie-wychowawcze-800-",
    startAt: /Jaka jest wysokość świadczenia/u, quoteContaining: /Świadczenie wychowawcze przysługuje w wysokości/u },
  { sourceId: "gov-pl", titlePrefix: "Ministerstwo Rodziny, Pracy i Polityki Społecznej", lang: "pl", max: 1,
    topics: ["rodzina", "świadczenie wychowawcze", "800 plus", "uchodźcy z Ukrainy", "kryteria świadczeń"],
    url: "https://www.gov.pl/web/rodzina/co-sie-zmienia-w-pomocy-dla-obywateli-ukrainy-w-2026-r",
    startAt: /Obywatel Ukrainy nadal może otrzymywać/u, quoteContaining: /Obywatel Ukrainy nadal może otrzymywać/u },
  { sourceId: "gov-pl", titlePrefix: "Ministerstwo Sprawiedliwości", lang: "pl", max: 1,
    topics: ["rada-europy", "czlonkostwo", "bialorus", "kosowo", "stolica-apostolska"],
    url: "https://www.gov.pl/web/sprawiedliwosc/prawa-czlowieka-w-radzie-europy",
    startAt: /Poza strukturami Rady Europy/, quoteContaining: /^Poza strukturami Rady Europy/ },
  { sourceId: "gov-pl", titlePrefix: "Stałe Przedstawicielstwo RP przy Radzie Europy", lang: "pl", max: 1,
    topics: ["rada-europy", "rosja", "czlonkostwo", "wykluczenie"],
    url: "https://www.gov.pl/web/re/rosja-wykluczona-z-rady-europy",
    startAt: /W dniu 16 marca/i, quoteContaining: /wykluczeniu Federacji Rosyjskiej/i },
  { sourceId: "gov-pl", titlePrefix: "MSZ", lang: "pl", max: 1,
    topics: ["dyplomacja", "rada-do-spraw-zagranicznych", "wysoki-przedstawiciel", "ue"],
    url: "https://www.gov.pl/web/dyplomacja/minister-czaputowicz-na-posiedzeniu-rady-do-spraw-zagranicznych-w-brukseli",
    startAt: /wysoki przedstawiciel Unii/i, quoteContaining: /wysoki przedstawiciel Unii/i },
  { sourceId: "ecb", titlePrefix: "Europejski Bank Centralny", lang: "en", max: 1,
    topics: ["strefa-euro", "rozszerzenie", "chorwacja", "waluta", "liczba-panstw"],
    url: "https://www.ecb.europa.eu/press/pr/date/2023/html/ecb.pr230101~2046d0fd6f.en.html",
    startAt: /euro entered into circulation in Croatia/i },
  { sourceId: "gov-pl", titlePrefix: "Polska w NATO", lang: "en", max: 1,
    topics: ["nato", "rozszerzenie", "akcesja", "liczba-panstw", "macedonia-polnocna"],
    url: "https://www.gov.pl/web/nato-en/the-republic-of-north-macedonia-became-the-30-member-of-the-north-atlantic-alliance",
    startAt: /North Macedonia became the 30/i, quoteContaining: /North Macedonia became the 30/i },
  { sourceId: "gov-pl", titlePrefix: "Ministerstwo Obrony Narodowej", lang: "pl", max: 1,
    topics: ["wojsko-polskie", "ukraina", "polityka-obronna", "wsparcie-ukrainy"],
    url: "https://www.gov.pl/web/obrona-narodowa/posiedzenie-komitetu-ds-bezpieczenstwa-w-kprm-wicepremier-wladyslaw-kosiniak-kamysz-podsumowal-obrady",
    startAt: /nie wysyłamy żołnierzy/i, quoteContaining: /nie wysyłamy żołnierzy/i },
  { sourceId: "gov-pl", titlePrefix: "Kancelaria Prezesa Rady Ministrów", lang: "pl", max: 2,
    topics: ["ukraina", "polska", "wojsko-polskie", "polityka-zagraniczna", "wsparcie-ukrainy"],
    url: "https://www.gov.pl/web/premier/sprawiedliwy-pokoj-dla-ukrainy-fundamentem-bezpieczenstwa-europy",
    startAt: /Polska zrobi wszystko/i, quoteContaining: /stanowisko polskiego rządu pozostaje/i },
  { sourceId: "gus-publications", titlePrefix: "GUS", lang: "pl", max: 2,
    topics: ["statystyka", "eog", "efta", "ue", "czlonkostwo", "norwegia"],
    url: "https://stat.gov.pl/statystyka-regionalna/jednostki-terytorialne/klasyfikacja-nuts/klasyfikacja-regionow-statystycznych-w-panstwach-nie-bedacych-czlonkami-unii-europejskiej/",
    startAt: /Jednak,? ze względu|Klasyfikacja NUTS stosowana jest/i },
];

export async function ingestInstitutionalReferences(opts: IngestOptions): Promise<ReturnType<typeof newResult>> {
  const id = "institutional-references";
  const result = await ingestOfficialPages(opts, pages, id);
  const client = new PoliteClient({ refresh: opts.refresh });
  await addLegalAndElectionPublications(client, opts.catalog, result);
  try {
    result.records.push(...await benefitGuideRecords(client, opts.catalog));
  } catch (error) {
    result.skipped.push({ what: benefitGuide, reason: (error as Error).message });
  }
  const senateUrl = "https://www.senat.gov.pl/aktualnoscilista/art,14652,25-rocznica-uchwalenia-konstytucji-rp.html";
  try {
    const source = sourceFromCatalog(opts.catalog, "senat-pl");
    const page = await client.get(senateUrl);
    if (!source.hosts.includes(new URL(page.finalUrl).hostname)) throw new Error("przekierowanie poza domenę Senatu");
    const doc = parseHTML(page.body).document;
    const heading = doc.querySelector("h2 + .data")?.previousElementSibling;
    const dateline = heading?.nextElementSibling?.textContent?.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
    const paragraph = Array.from(doc.querySelectorAll("p"), p => squash(p.textContent ?? "")).find(p => p.includes("Zgromadzenie Narodowe uchwaliło Konstytucję"));
    const quote = paragraph?.match(/^.{1,200}w referendum\. Konstytucja zaczęła obowiązywać [^.]+r\./u)?.[0];
    if (!heading?.textContent || !dateline || !quote || quote.length > 300) throw new Error("Nie odnaleziono datowanego fragmentu Senatu o przyjęciu Konstytucji");
    result.records.push({ ...baseFromCatalog(source), id: recordId(source.id, senateUrl), url: page.finalUrl,
      title: "Senat RP: " + squash(heading.textContent), publishedAt: `${dateline[3]}-${dateline[2]}-${dateline[1]}`,
      fetchedAt: page.fetchedAt, text: quote, lang: "pl", topics: ["konstytucja", "historia-polski", "referendum", "zgromadzenie-narodowe"], origin: "corpus" });
  } catch (error) {
    result.skipped.push({ what: senateUrl, reason: (error as Error).message });
  }
  const wagesUrl = "https://psz.zus.pl/pl/web/guest/baza-wiedzy/skladki-wskazniki-odsetki/wskazniki/minimalne-wynagrodzenie-za-prace-od-2003-r";
  try {
    const source = sourceFromCatalog(opts.catalog, "zus-wskazniki");
    const page = await client.get(wagesUrl);
    if (!source.hosts.includes(new URL(page.finalUrl).hostname)) throw new Error("przekierowanie poza domenę ZUS");
    const rows = Array.from(parseHTML(page.body).document.querySelectorAll("li"), li => squash(li.textContent ?? ""))
      .filter(line => /^[\d ,.]+ zł\s*[-–—]\s*minimalne wynagrodzenie od /iu.test(line));
    if (!rows.length) throw new Error("Brak datowanych stawek w zestawieniu ZUS");
    const periods = new Set<string>();
    const records = rows.map(text => {
      const date = / od (\d{1,2}) (\p{L}+) (\d{4}) r\./iu.exec(text);
      const month = MONTHS_GENITIVE_PL.findIndex(m => m === date?.[2]) + 1;
      if (!date || !month) throw new Error("Nieczytelna data obowiązywania stawki ZUS");
      const period = `${date[3]}-${String(month).padStart(2, "0")}-${date[1]!.padStart(2, "0")}`;
      if (periods.has(period) || new Date(period).toJSON()?.slice(0, 10) !== period) throw new Error("Niejednoznaczny okres stawki ZUS");
      periods.add(period);
      return { ...baseFromCatalog(source), id: recordId(source.id, wagesUrl + "|" + period), url: page.finalUrl,
        title: `ZUS: Minimalne wynagrodzenie za pracę (stawka miesięczna) od ${date[1]} ${date[2]} ${date[3]} r.`,
        publishedAt: null, period, fetchedAt: page.fetchedAt, text, lang: "pl",
        topics: ["minimalne-wynagrodzenie", "płaca minimalna", "rynek-pracy", "stawka-miesięczna"], origin: "corpus" as const };
    });
    result.records.push(...records);
  } catch (error) {
    result.skipped.push({ what: wagesUrl, reason: (error as Error).message });
  }
  const url = "https://stat.gov.pl/files/gfx/portalinformacyjny/pl/defaultaktualnosci/5466/15/11/1/ruch_graniczny_oraz_wydatki_2024.pdf";
  try {
    const source = sourceFromCatalog(opts.catalog, "gus-publications");
    const binary = await client.getBinary(url);
    if (!source.hosts.includes(new URL(binary.finalUrl).hostname)) throw new Error("przekierowanie poza domenę GUS");
    const paragraph = squash(await pdfToText(binary.data)).match(/Długość granicy państwowej Polski wynosi[^.]{10,240}\. Długość poszczególnych odcinków[^.]{30,1200}\./u)?.[0];
    if (!paragraph) throw new Error("Nie odnaleziono akapitu o granicach państwowych w publikacji GUS");
    result.records.push({ ...baseFromCatalog(source), id: recordId(source.id, url), url: binary.finalUrl,
      title: "GUS: Ruch graniczny oraz wydatki cudzoziemców w Polsce i Polaków za granicą w 2024 r. — granice Polski",
      publishedAt: null, period: "2024", fetchedAt: binary.fetchedAt, text: paragraph, lang: "pl",
      topics: ["granice", "geografia", "granica-polski", "dlugosc-granicy"], origin: "corpus" });
  } catch (error) {
    result.skipped.push({ what: url, reason: (error as Error).message });
  }
  result.requests += client.requests;
  return result;
}
