import type { CorpusRecord } from "../shared/contracts";
import { fold } from "./retrieval/stem";
import { foldForMatch, MONTHS_PL } from "./text";
import { statedDays } from "./event-day";

// Only an unqualified round, election type, optional place/year and the occurrence date.
// A claim about turnout, the winner or the legality of the vote needs a separate finding.
const roundOnDay = new RegExp(
  String.raw`^(?:czy )?(?:pierwsza|druga|i|ii|1|2) tura (?:polskich )?wyborow (?:prezydenckich|parlamentarnych|samorzadowych|prezydenta (?:rp|rzeczypospolitej polskiej))`
  + String.raw`(?: (?:w|we|na) [a-z]+)?(?: w (?:roku )?\d{4}(?: r| roku)?)? (?:nie )?odbyla sie (?:w dniu )?\d{1,2} (?:`
  + MONTHS_PL.map(foldForMatch).join("|") + String.raw`)(?: \d{4}(?: r| roku)?)?$`, "u",
);
export function asksForElectionRoundDate(text: string): boolean {
  return roundOnDay.test(foldForMatch(text));
}

/** Date directly attached to the requested round in a retrospective official source.
 * In particular, a date printed elsewhere in the same two-round bulletin is insufficient. */
export function publishedRoundDay(claim: string, quote: string, record: CorpusRecord): string | undefined {
  const request = foldForMatch(claim);
  if (record.role !== "tresc" || record.level !== 1 || !asksForElectionRoundDate(claim)) return;
  const source = foldForMatch([record.title, record.text, ...record.topics].join(" "));
  const electionType = /\bwyborow (prezyden|parlamentarn|samorzadow)/u.exec(request)?.[1];
  if (!electionType || !source.includes(electionType)) return;
  const place = /\b(?:w|we|na) ([a-z]+)(?= (?:w (?:roku )?\d{4} |(?:nie )?odbyla sie))/u.exec(request)?.[1];
  // The regular Polish alternation -ska / -sce also appears in reports as the adjective -ski.
  if (place && !source.split(" ").some(word => word === place || (place.endsWith("sce") && word.startsWith(place.slice(0, -3) + "sk")))) return;
  const first = /^(?:czy )?(?:pierwsza|i|1) tura /u.test(request);
  const ordinal = first ? "(?:pierwsz[aey]|i|1)" : "(?:drug[aie]|ii|2)";
  const day = String.raw`(?:w dniu |dnia )?(\d{1,2} [a-z]+ \d{4})\b`;
  const held = String.raw`(?:odbyla sie|przeprowadzono|zostala przeprowadzona|miala miejsce)`;
  const pair = new RegExp(String.raw`\b` + ordinal + String.raw` tur[aey] (?:` + held + " )?" + day, "gu");
  const reported = [...foldForMatch(quote).matchAll(pair)].flatMap(m => statedDays(m[1]!));
  if (new Set(reported).size !== 1) return;
  // Preserve the verb in an elliptical report ("first round took place on X and
  // second round on Y"). A date in a prospective schedule is not an observation.
  const observed = new RegExp(String.raw`\b` + ordinal + String.raw` tur[aey] ` + held + " " + day, "gu");
  const coordinated = new RegExp(String.raw`\b(?:pierwsz[aey]|drug[aie]|ii?|[12]) tur[aey] ` + held +
    String.raw` (?:w dniu |dnia )?\d{1,2} [a-z]+ \d{4}(?: r| roku)? (?:oraz|i|a) ` + ordinal + String.raw` tur[aey] ` + day, "gu");
  const body = foldForMatch(record.text);
  const completed = [...body.matchAll(observed), ...body.matchAll(coordinated)].flatMap(m => statedDays(m[1]!));
  return completed.includes(reported[0]!) ? reported[0] : undefined;
}

/** A query about winning an election as a whole, as opposed to winning one round. */
export function asksForElectionWinner(query: string): boolean {
  const s = fold(query);
  return /\b(?:wybor\w*|elekcj\w*|election\w*)\b/.test(s)
    && /\b(?:wygr\w*|zwycie\w*|wybran\w*|winner|won|elected)\b/.test(s)
    && !/\b(?:pierwsz\w*|1\.?|i)\s+tur\w*|\bfirst.round\b/.test(s);
}

/** Classify only explicit statements in the body. A bulletin title may occur on every page of the results. */
export function electionResultStage(record: CorpusRecord): "elected" | "runoff_pending" | undefined {
  if (record.role !== "tresc" || record.level !== 1 || !/\b(?:wybor\w*|election\w*)\b/.test(fold(record.title))) return;
  const s = fold(record.text).replace(/\s+/g, " ");
  if (/\b(?:zostal[ai]? wybran[ay]|wybran[ay] zostal[ai]?|(?:was|has been) elected)\b/.test(s)) return "elected";
  if (/\b(?:przeprowadzone zostanie ponowne glosowanie|odbedzie sie (?:ponowne glosowanie|druga tura)|(?:a |the )?runoff will be held)\b/.test(s)) return "runoff_pending";
}
