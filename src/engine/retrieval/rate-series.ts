import type { Database } from "better-sqlite3";
import type { Claim } from "../../shared/contracts";

interface SeriesRow {
  id: string;
  text: string;
  topics_json: string;
}

/** A complete scalar assertion. Unrecognised wording, another geography, changes in points,
 * different measures and claims with additional clauses stay with ordinary retrieval. */
export function currentRateMeasure(claim: Claim) {
  if (claim.temporal.kind !== "stan" || claim.temporal.date || claim.temporal.asOf) return;
  const text = claim.text.normalize("NFC").trim().toLocaleLowerCase("pl");
  const match = /^(?:czy\s+)?(?:(?:obecnie|aktualnie|dzisiaj)\s+)?(inflacja(?: cpi)? w polsce|polska inflacja(?: cpi)?|stopa referencyjna (?:nbp|narodowego banku polskiego)) (?:wynosi|sięga|to) (?:(?:obecnie|aktualnie) )?(?:(ponad|powyżej|więcej niż|poniżej|mniej niż|co najmniej|nie mniej niż|co najwyżej|nie więcej niż) )?(-?\d+(?:[.,]\d+)?)\s*(?:%|procent(?:a|ów)?)(?: (?:w skali roku|rok do roku))?[.!?]?$/u.exec(text);
  if (!match) return;
  const stated = Number(match[3]!.replace(",", "."));
  const comparator = match[2];
  function matches(value: number) {
    switch (comparator) {
      case "co najmniej": case "nie mniej niż": return value >= stated;
      case "co najwyżej": case "nie więcej niż": return value <= stated;
      case "ponad": case "powyżej": case "więcej niż": return value > stated;
      case "poniżej": case "mniej niż": return value < stated;
      default: return value === stated;
    }
  }
  return { sourceId: match[1]!.startsWith("stopa") ? "nbp-rates" : "gus-cpi", matches };
}

export function percentageValues(quote: string): number[] {
  return [...quote.matchAll(/(-?\d+(?:[.,]\d+)?)%/gu)].map(m => Number(m[1]!.replace(",", ".")));
}

/** Return the latest observation and the most recent historical observation matching the claim.
 * Both go through the same reader, citation check and independent verifier as other evidence. */
export function rateSeriesIds(db: Database, claim: Claim): string[] | undefined {
  const measure = currentRateMeasure(claim);
  if (!measure || typeof db.prepare !== "function") return;
  const rows = db.prepare("SELECT id, text, topics_json FROM records WHERE source_id = ? ORDER BY period DESC").all(measure.sourceId) as SeriesRow[];
  const latest = rows.find(row => (JSON.parse(row.topics_json) as string[]).includes("series-latest"));
  if (!latest) return [];
  const hasValue = (row: SeriesRow) => percentageValues(row.text).some(measure.matches);
  if (hasValue(latest)) return [latest.id];
  const history = rows.find(row => row !== latest && hasValue(row));
  return history ? [latest.id, history.id] : [latest.id];
}
