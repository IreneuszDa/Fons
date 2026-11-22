import { localTransportQuestion } from "../../engine/local-transport";
import { foldWords } from "../util";

interface DieselRestriction {
  place: string;
  timing?: string;
}

/** The same narrow allegation may be phrased as a prohibition or an inability to enter.
 * Unrecognized qualifiers (exceptions, vehicle classes, different districts) keep their own case. */
export function dieselRestriction(text: string): DieselRestriction | undefined {
  const local = localTransportQuestion(text);
  if (local?.policy !== "diesel_access") return undefined;
  let s = foldWords(text).replace(foldWords(local.place), " ");
  const timing = /\bod (?:przyszlego tygodnia|nastepnego tygodnia|jutra|dzisiaj|wczoraj|\d{1,2} [a-z]+ \d{4})\b/.exec(s)?.[0];
  if (timing) s = s.replace(timing, " ");
  const prohibition = /\b(?:zakaz(?:u)? (?:wjazdu|wjezdzania)|nie (?:beda (?:juz )?mogly |moga |mozna )(?:wjechac|wjezdzac)|nie wjada)\b/;
  if (!prohibition.test(s)) return undefined;
  s = s.replace(prohibition, " ")
    .replace(/\b(?:czy|miasto|gmina|wprowadza|wprowadzi|wprowadzilo|wprowadzila|diesle|diesli|dieslem|diesla|samochody|samochodow|z|silnikiem|do|w|we|centrum)\b/g, " ");
  if (s.trim()) return undefined;
  const place = [local.placeStem, ...foldWords(local.place).split(" ").slice(1)].join(" ");
  return { place, timing: timing?.replace("nastepnego", "przyszlego") };
}

export function sameDieselRestriction(a: DieselRestriction, b: DieselRestriction): boolean {
  return a.place === b.place && (!a.timing || !b.timing || a.timing === b.timing);
}
