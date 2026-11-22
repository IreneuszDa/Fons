import { parseEnglishDate } from "./officialpages";

export const NATO_SECRETARIES_URL = "https://www.nato.int/en/about-us/organization/who-we-are/nato-secretaries-general";

export function incumbentRow(heading: string, biography: string) {
  const name = /^NATO Secretary General ([\p{L}][\p{L} .’'-]{2,85})$/u.exec(heading)?.[1];
  if (!name || !biography.startsWith(name + " took office as ")) return;
  const opening = /^.+? took office as (?:the )?North Atlantic Treaty Organi[sz]ation[’']s \d+(?:st|nd|rd|th) Secretary General on (\d{1,2} \p{L}+ \d{4})\./u.exec(biography);
  const since = opening && parseEnglishDate(opening[1]!);
  if (!opening || !since || new Date(Date.parse(since)).toJSON()?.slice(0, 10) !== since) return;
  return { name, since, quote: heading + "\n" + opening[0] };
}

export function previousRow(line: string) {
  const row = /^NATO Secretary General,? (.{3,100}?)\s+(\d{4})\s*[-–]\s*(\d{4})$/u.exec(line);
  if (!row || row[2]! > row[3]!) return;
  return { name: row[1]!, period: row[2] + "-" + row[3], start: row[2]!, end: row[3]! };
}
