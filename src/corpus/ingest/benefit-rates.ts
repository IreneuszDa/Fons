import type { CatalogSource, CorpusRecord } from "../../shared/contracts";
import { baseFromCatalog, parseHtmlPage, recordId, sourceFromCatalog, squash, type PoliteClient } from "./common";

export const benefitGuide = "https://www.gov.pl/web/gov/skorzystaj-z-programu-rodzina-500";

export function benefitGuidePassages(html: string) {
  const parsed = parseHtmlPage(html);
  const text = squash(parsed.text);
  const updated = /Ostatnia aktualizacja: (\d{2})\.(\d{2})\.(\d{4})/u.exec(text);
  const amount = /\b\d[\d ,]* zł co miesiąc na dziecko – tyle dostaniesz „na rękę”, niezależnie od wysokości dochodu\./u.exec(text)?.[0];
  const polish = /obywatelom polskim, którzy mieszkają w Polsce/u.exec(text)?.[0];
  const displaced = /obywatelom Ukrainy ze statusem UKR, którzy z powodu konfliktu zbrojnego przebywają pod ochroną tymczasową na terenie Polski, jeśli:/u.exec(text)?.[0];
  if (!updated || !amount || !polish || !displaced || !parsed.title.includes("Rodzina 800+")) throw new Error("Brak pełnej sekcji stawki, adresatów lub daty aktualizacji informatora");
  const passages = [{ key: "rate", text: amount }, { key: "scope-pl", text: polish }, { key: "scope-ukr", text: displaced }];
  if (passages.map(p => p.text).join(" ").length > 300) throw new Error("Przekroczony limit cytowania informatora");
  return { title: parsed.title, updated: updated[3] + "-" + updated[2] + "-" + updated[1], passages };
}

export async function benefitGuideRecords(client: PoliteClient, catalog: CatalogSource[]): Promise<CorpusRecord[]> {
  const page = await client.get(benefitGuide);
  if (page.status !== 200 || page.finalUrl !== benefitGuide) throw new Error("Niepoprawny adres informatora o świadczeniu");
  const source = sourceFromCatalog(catalog, "gov-pl");
  const document = benefitGuidePassages(page.body);
  // Edition date is the official last-update date, not a guessed first publication date.
  return document.passages.map(({ key, text }) => ({
    ...baseFromCatalog(source), id: recordId(source.id, benefitGuide + "|" + key), title: document.title, url: benefitGuide,
    publishedAt: null, period: document.updated, fetchedAt: page.fetchedAt, text,
    topics: ["rodzina", "świadczenie wychowawcze", "800 plus", "program:800 plus", key === "rate" ? "stawka-programu" : "adresaci-programu"],
    lang: "pl", origin: "corpus",
  }));
}
