import { foldForMatch, formatDatePl } from "./text";

const MONTH = "stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|wrzesnia|października|pazdziernika|listopada|grudnia";
const DATE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:\d{4}-\d{2}-\d{2}|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}|\d{1,2}\s+(?:${MONTH})\s+\d{4})(?![\p{L}\d])`,
  "giu",
);

/** Literal OCR spans. Do not attach dates suggested by a model but missing from the transcription. */
export function printedDates(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(DATE), ([date]) => date))].slice(0, 10);
}

export function visibleImageDates(text: string): string[] {
  const dates = printedDates(text);
  return dates.length ? dates : [...new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? [])].slice(0, 10);
}

export function samePrintedDay(printed: string, iso: string): boolean {
  if (printed === iso || foldForMatch(printed) === foldForMatch(formatDatePl(iso))) return true;
  const numeric = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(printed);
  return !!numeric && `${numeric[3]}-${numeric[2]!.padStart(2, "0")}-${numeric[1]!.padStart(2, "0")}` === iso;
}
