/**
 * Ingestia profili państw członkowskich z oficjalnego portalu UE (european-union.europa.eu, wersja polska):
 * blok z podstawowymi informacjami zawiera m.in. datę przystąpienia do UE ("W UE: od ..." / "Państwo członkowskie UE: od ..."), datę wejścia do strefy
 * Schengen, walutę i dane liczbowe z podaniem źródła. Fragment zapisujemy dosłownie (<= 1200 znaków).
 */
import type { CorpusRecord } from "../../shared/contracts";
import { ingestEuMembership } from "./eu-membership";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, chunkText, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

export const EU_COUNTRIES = [
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "denmark", "estonia", "finland", "france", "germany", "greece", "hungary",
  "ireland", "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands", "poland", "portugal", "romania", "slovakia", "slovenia", "spain", "sweden",
];

export async function ingestEuPortal(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("eu-portal");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "eu-portal");
  const base = baseFromCatalog(src);

  for (const slug of EU_COUNTRIES) {
    const url = `https://european-union.europa.eu/principles-countries-history/eu-countries/${slug}_pl`;
    try {
      const res = await client.get(url);
      const parsed = parseHtmlPage(res.body, "main");
      const lines = parsed.text.split("\n");
      let start = lines.findIndex((l) => /^(Informacje ogólne|Najważniejsze informacje|Podstawowe informacje)$/.test(l));
      // Niektóre profile (Słowacja, Słowenia) nie mają nagłówka bloku — zaczynają się od linii "Stolica: ...".
      if (start < 0) start = lines.findIndex((l) => /^Stolica:/.test(l)) - 1;
      if (start < -1 || (start === -1 && !/^Stolica:/.test(lines[0] ?? ""))) throw new Error("brak bloku z podstawowymi informacjami o kraju");
      let end = lines.findIndex((l, i) => i > start && /^Ustrój polityczny$/.test(l));
      if (end < 0) end = Math.min(lines.length, start + 12);
      const block = lines.slice(start + 1, end).join("\n");
      if (!/^(W UE|Państwo członkowskie UE):/m.test(block)) throw new Error("brak linii z datą przystąpienia do UE w bloku");
      const country = squash(parsed.title.split(/[–|-]/)[0] ?? slug);
      const chunk = chunkText(block, 1200)[0]!;
      const rec: CorpusRecord = {
        ...base,
        id: recordId("eu-portal", url),
        url: res.finalUrl,
        title: `Unia Europejska: ${country} — informacje o kraju UE`,
        publishedAt: null,
        fetchedAt: res.fetchedAt,
        lang: "pl",
        text: chunk,
        topics: ["ue", "czlonkostwo-w-ue", "data-przystapienia", "schengen", "profil-panstwa", slug === "poland" ? "polska" : slug],
        origin: "corpus",
      };
      result.records.push(rec);
    } catch (e) {
      result.skipped.push({ what: url, reason: (e as Error).message });
    }
  }
  opts.log(`  portal UE: ${result.records.length} profili państw`);
  await ingestEuMembership(client, opts, result);
  result.requests = client.requests;
  result.notes.push(
    "Profile krajów nie podają daty publikacji — publishedAt = null; dane liczbowe na stronie mają własne adnotacje o źródle (Eurostat) i roku. Strony zbiorcze (lista krajów UE, strefa euro, rozszerzenie) mają wiersz 'Ostatnia aktualizacja strony' → publishedAt (gdy jest).",
  );
  return result;
}
