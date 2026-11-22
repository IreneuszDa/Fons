import type { Claim } from "../../shared/contracts";
import { currentRateMeasure, percentageValues } from "../retrieval/rate-series";
import { stemToken } from "../retrieval/stem";
import type { Ev } from "./evidence";
import { parsePeriod } from "./periods";
import { extractSlots } from "./slots";

const bound = /(?<!\p{L})(ponad|powyżej|poniżej|co najmniej|co najwyżej|więcej niż|mniej niż)\s+(\d+(?:[.,]\d+)?)\s*((?:tys(?:ięcy|iące|iąc|\.)?|mln|milion\p{L}*|mld|miliard\p{L}*)\s+)?(\p{L}+)/giu;

function datedCount(text: string) {
  const matches = [...text.matchAll(bound)];
  if (matches.length !== 1 || extractSlots(text).values.length !== 1) return;
  const match = matches[0]!;
  const operators: Record<string, string> = { "powyżej": "ponad", "więcej niż": "ponad", "mniej niż": "poniżej" };
  const amount = extractSlots(match[2]! + " " + (match[3] ?? "")).values[0];
  const unit = match[4]!.toLocaleLowerCase("pl");
  return { operator: operators[match[1]!.toLowerCase()] ?? match[1]!.toLowerCase(), amount, unit,
    context: text.slice(0, match.index) + " " + text.slice(match.index! + match[0].length) };
}

function contextWords(text: string): string[] {
  const ignored = new Set(["w", "we", "r", "rok", "roku", "latach"]);
  return (text.toLocaleLowerCase("pl").match(/\p{L}+/gu) ?? []).filter(word => !ignored.has(word)).map(word => {
    // Compound country adjectives and inflected country names can share a root.
    const root = (stemToken(word, "pl") ?? word).replace(/(?<=s)k$/u, "");
    return root.length >= 4 ? root : stemToken(word, "pl") ?? word;
  });
}

/** An agreed primary quote about the only number asserted can support the claim as a whole.
 * For a historical count also require the same year, bounded amount, counted noun and scope. */
export function supportsMeasurement(claim: Claim, e: Ev, now: Date): boolean {
  if (claim.assertedAspect !== "liczba" || e.kind !== "primary" || e.polarity !== "support" ||
      e.a.verifier !== "zgoda" || e.aspect !== "liczba" || !e.a.quoteVerified || e.a.excluded || e.a.historicalSupport) return false;
  const rate = currentRateMeasure(claim);
  if (rate) {
    const values = percentageValues(e.a.quote);
    return e.r.sourceId === rate.sourceId && e.r.topics.includes("series-latest") &&
      e.r.fetchedAt.slice(0, 10) === now.toISOString().slice(0, 10) && values.length === 1 && rate.matches(values[0]!);
  }
  const year = claim.temporal.date;
  if (claim.temporal.kind !== "jednorazowe" || !year || !/^\d{4}$/u.test(year) ||
      e.r.period !== year || !e.a.quote.includes(year) || !claim.text.includes(year)) return false;
  const period = parsePeriod(e.a.period ?? e.r.period);
  if (period?.start !== parsePeriod(year)?.start || period?.end !== parsePeriod(year)?.end) return false;
  const wanted = datedCount(claim.text);
  const observed = datedCount(e.a.quote);
  if (!wanted || !observed || wanted.amount !== observed.amount || wanted.operator !== observed.operator ||
      wanted.unit !== observed.unit || /\b(?:do|od|z|ze)\s+\p{Lu}/u.test(claim.text)) return false;
  const source = new Set(contextWords(observed.context));
  const asserted = contextWords(wanted.context);
  return asserted.length >= 2 && asserted.every(word => source.has(word));
}
