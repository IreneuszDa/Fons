import type { CorpusRecord } from "../shared/contracts";
import { MONTHS_PL } from "./text";
import { parsePeriod } from "./verdict/periods";

/** The date of the observation and the date by which estimates were published are independent. */
export function explicitPublicationCutoff(text: string): string | undefined {
  const prefix = /(?:według stanu (?:publikacji|wiedzy)|stan(?:u)? publikacji|(?:dane|publikacje|szacunki|raporty|informacje) (?:dostępne|opublikowane)|stan dostępnych (?:publikacji|informacji))\s+(?:na(?: dzień)?|do(?: dnia)?)\s+/iu.exec(text);
  if (!prefix) return;
  const tail = text.slice(prefix.index + prefix[0].length);
  const iso = /^(\d{4}-\d{2}-\d{2})\b/u.exec(tail)?.[1];
  const parts = /^(\d{1,2})(?:[./-](\d{1,2})[./-]|\s+([\p{L}]+)\s+)(\d{4})\b/iu.exec(tail);
  const month = parts?.[2] ?? String(MONTHS_PL.indexOf(parts?.[3]?.toLocaleLowerCase("pl") ?? "") + 1);
  const date = iso ?? (parts && [parts[4], month.padStart(2, "0"), parts[1]!.padStart(2, "0")].join("-"));
  return date && parsePeriod(date) ? date : undefined;
}

export function publicationAvailable(record: CorpusRecord | undefined, now: Date, publishedBy?: string): boolean {
  if (!record) return false;
  const reference = parsePeriod(publishedBy);
  const observed = Math.min(reference?.end ?? Infinity, now.getTime());
  if (record.supersededAt && (parsePeriod(record.supersededAt)?.start ?? Infinity) <= observed) return false;
  if (!reference) return true;
  // A fetch before the cutoff proves availability even if the publisher supplied no dateline.
  const published = parsePeriod(record.publishedAt);
  const fetched = Date.parse(record.fetchedAt);
  return (published?.end ?? Infinity) <= observed || fetched <= observed;
}
