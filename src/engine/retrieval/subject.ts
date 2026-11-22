import type { Database } from "better-sqlite3";
import type { CorpusRecord } from "../../shared/contracts";
import { foldForMatch } from "../text";
import { loadOfficialRegistry } from "./official-plan";

let countryNames: Map<string, string[]> | undefined;

function officialNames(): Map<string, string[]> {
  if (!countryNames) {
    countryNames = new Map();
    const locales = ["pl", "en", "de", "fr", "it", "es", "uk"].map(lang => new Intl.DisplayNames(lang, { type: "region" }));
    // Odyseusz lists foreign destinations. Include the home country for PL/EN lookups.
    for (const country of [...loadOfficialRegistry().countries, { iso: "PL", name: locales[0]!.of("PL")! }]) {
      const localized = locales.map(locale => locale.of(country.iso)!).filter(Boolean);
      const english = localized[1]!.replace(/ & /gu, " and ");
      const aliases = [country.name, localized[0]!, english];
      for (const variant of [country.name, ...localized]) countryNames.set(foldForMatch(variant), aliases);
      countryNames.set(foldForMatch(english), aliases);
    }
  }
  return countryNames;
}

/** All registry-backed spellings point to the same English country identity. The definite
 * article occurs in institutional lists that use full English country names. */
export function countryIdentity(name: string): string | undefined {
  const query = foldForMatch(name);
  const aliases = officialNames().get(query) ?? officialNames().get(query.replace(/^the /u, ""));
  return aliases?.at(-1);
}

export function registeredCountryName(name: string): boolean {
  return officialNames().has(foldForMatch(name));
}

/** Only registry-backed aliases establish identity. Model translations are retrieval hints. */
export function subjectAliases(name: string): string {
  return [...new Set([name, ...(officialNames().get(foldForMatch(name)) ?? [])])].join(" | ");
}

/** Title lookup deliberately omits the asserted year, so primary records documenting a different
 * value can reach the assessment. Only structured identity fields can qualify a tabular quote. */
export function primarySubjectIds(db: Database, subject: string, year?: string): string[] {
  const variants = subject.split("|").map(s => s.trim()).filter(Boolean);
  const terms = variants.map(s => '"' + s.replace(/"/gu, '""') + '"');
  if (!terms.length) return [];
  const rows = db.prepare(`SELECT r.id FROM records_fts JOIN records r ON r.rowid=records_fts.rowid
    WHERE records_fts MATCH ? AND r.level=1 AND r.type='pierwotne' AND r.role='tresc'
    ORDER BY bm25(records_fts), r.id LIMIT 60`).all("title:(" + terms.join(" OR ") + ")" +
      (year && /^\d{4}$/u.test(year) ? ' AND text:"' + year + '"' : "")) as { id: string }[];
  return rows.map(r => r.id);
}

/** Include official biographical evidence with the person’s name even when a query for an office
 * finds only the incumbent. Name stems here select candidates; the evidence reader still checks identity and dates. */
export function officeHistoryIds(db: Database, names: string[]): string[] {
  if (names.length !== 1) return [];
  const words = names[0]!.split(/\s+/u);
  if (words.length < 2 || !words.every(word => /^[\p{L}-]+$/u.test(word))) return [];
  const terms = words.map(word => '"' + word.replace(/[aąeięoy]$/iu, "") + '"*').join(" AND ");
  const rows = db.prepare(`SELECT r.id FROM records_fts JOIN records r ON r.rowid=records_fts.rowid
    WHERE records_fts MATCH ? AND r.level=1 AND r.role='tresc' AND r.type='pierwotne'
    AND (r.topics_json LIKE '%"funkcja-publiczna"%' OR r.topics_json LIKE '%"wysoki-przedstawiciel"%')
    ORDER BY bm25(records_fts), r.id LIMIT 2`).all(terms) as { id: string }[];
  return rows.map(row => row.id);
}

export function isProfileField(r: CorpusRecord, quote: string): boolean {
  return r.level === 1 && r.type === "pierwotne" && r.role === "tresc" && r.topics.includes("profil-panstwa")
    && /^[\p{L}][\p{L}\p{M} ()-]{1,55}:\s*\S/u.test(quote.trim());
}
