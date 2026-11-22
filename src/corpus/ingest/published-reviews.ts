import { FACTCHECK_SEARCH_URL, DEMAGOG_HOST, ingestDemagog, parseFactCheckResponse, toDemagogRecord } from "./demagog";
import { PoliteClient, baseFromCatalog, sourceFromCatalog, type IngestOptions } from "./common";

import { publicationLinks } from "../publication-links";

function archivedPublications() {
  return publicationLinks().filter(link => link.archiveQuery && new URL(link.url).hostname === DEMAGOG_HOST);
}

export function archiveSearchUrl(query: string) {
  const params = new URLSearchParams({ query, reviewPublisherSiteFilter: DEMAGOG_HOST, languageCode: "pl", pageSize: "100" });
  return `${FACTCHECK_SEARCH_URL}?${params}`;
}

export const archiveQueries = () => [...new Set(archivedPublications().map(link => link.archiveQuery!))];

export async function loadArchivedReviews(opts: IngestOptions, key: string) {
  const client = new PoliteClient({ refresh: opts.refresh, minIntervalMs: 400 });
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "demagog"));
  const expected = new Set(archivedPublications().map(link => link.url));
  const records = [];
  for (const query of archiveQueries()) {
    const response = await client.get(archiveSearchUrl(query), {
      accept: "application/json", secretHeaders: { "X-Goog-Api-Key": key }, skipRobots: true,
    }).catch(() => { throw new Error("Błąd dostępu do indeksu Google przy pobieraniu archiwalnych publikacji."); });
    if (response.status !== 200) throw new Error("Indeks Google nie zwrócił archiwalnych recenzji.");
    for (const review of parseFactCheckResponse(JSON.parse(response.body)).reviews) {
      if (!expected.has(review.url)) continue;
      const record = toDemagogRecord(review, base, response.fetchedAt);
      if (record) {
        records.push(record);
        expected.delete(review.url);
      }
    }
  }
  if (expected.size) throw new Error("Indeks Google nie zwrócił kompletu przypisanych publikacji. Zachowano poprzednią migawkę.");
  return { records, requests: client.requests };
}

export async function ingestDemagogWithArchive(opts: IngestOptions) {
  const rolling = await ingestDemagog(opts);
  if (!rolling.records.length) return rolling;
  const archive = await loadArchivedReviews(opts, process.env.FACTCHECK_API_KEY!);
  const all = new Map([...rolling.records, ...archive.records].map(record => [record.id, record]));
  const notes = [...rolling.notes, `Sprawdzono dodatkowo ${archive.records.length} wskazanych publikacji bez ograniczenia wieku. Liczba publikacji spoza bieżącego zestawu wyniosła ${all.size - rolling.records.length}.`];
  return { ...rolling, records: [...all.values()], requests: rolling.requests + archive.requests, notes };
}
