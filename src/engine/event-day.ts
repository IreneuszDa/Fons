import type { Claim, CorpusRecord, EvidenceAssessment } from "../shared/contracts";
import { foldForMatch, MONTHS_PL } from "./text";
import { countryIdentity } from "./retrieval/subject";
import { parsePeriod } from "./verdict/periods";

const months = new Map<string, string>();
for (const [i, pl] of MONTHS_PL.entries()) {
  const en = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, i, 1))).toLowerCase();
  for (const name of [foldForMatch(pl), en, en.slice(0, 3)]) months.set(name, String(i + 1).padStart(2, "0"));
}
const names = [...months.keys()].join("|");
const dayFirst = new RegExp(String.raw`\b(\d{1,2})\s+(` + names + String.raw`)\.?\s+(\d{4})\b`, "gu");
const dayMonth = new RegExp(String.raw`\b(\d{1,2}) (` + names + String.raw`)\b`, "gu");
const monthFirst = new RegExp(String.raw`\b(` + names + String.raw`)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b`, "gu");

export function statedDays(text: string): string[] {
  const t = text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ł/gu, "l");
  const dates = new Set<string>();
  const add = (year: string, month: string, day: string) => {
    const iso = [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
    if (parsePeriod(iso)) dates.add(iso);
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) add(m[1]!, m[2]!, m[3]!);
  for (const m of t.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/gu)) add(m[3]!, m[2]!, m[1]!);
  for (const m of t.matchAll(dayFirst)) add(m[3]!, months.get(m[2]!)!, m[1]!);
  for (const m of t.matchAll(monthFirst)) add(m[3]!, months.get(m[1]!)!, m[2]!);
  return [...dates];
}

/** Date of the event itself, including the start of a status. A snapshot of who held
 * a status on a particular day may instead be established by a dated interval. */
export function requestedEventDay(claim: Claim): string | undefined {
  if (claim.assertedAspect && !["czas", "sedno"].includes(claim.assertedAspect)) return;
  const dates = statedDays(claim.text).filter(day => day !== claim.temporal.publishedBy);
  // In Polish the event year can introduce a clause whose day and month appear at the end.
  // Require every component in the sender's text, one unambiguous date and agreement with extraction.
  if (dates.length === 0 && claim.temporal.kind === "jednorazowe" && claim.assertedAspect === "czas") {
    const text = foldForMatch(claim.text);
    const years = [...text.matchAll(/\b\d{4}\b/gu)];
    const year = /\bw (?:roku )?(\d{4})\b/u.exec(text)?.[1];
    const days = [...text.matchAll(dayMonth)];
    if (year && years.length === 1 && days.length === 1) {
      const iso = year + "-" + months.get(days[0]![2]!) + "-" + days[0]![1]!.padStart(2, "0");
      if (iso === claim.temporal.date && iso !== claim.temporal.publishedBy && parsePeriod(iso)) return iso;
    }
  }
  if (dates.length !== 1) return;
  const start = /\b(?:od(?: dnia)?|since)\s+\d|\bsince\s+[a-z]+\s+\d/iu.test(claim.text);
  const snapshot = /\b(?:stan na|na dzień|as of|(?:był[aoiy]?|byli|jest|są)\s+(?:już\s+)?członk|was (?:already )?a member|were (?:already )?members)/iu.test(claim.text);
  if (!start && (claim.temporal.kind === "stan" || claim.temporal.asOf || snapshot)) return;
  return start || claim.temporal.kind === "jednorazowe" || claim.assertedAspect === "czas" ? dates[0] : undefined;
}

export function preciseDateAssessment(day: string | undefined, a: EvidenceAssessment, r: CorpusRecord | undefined): EvidenceAssessment {
  if (!day || !r || a.excluded || a.relation !== "WSPIERA" || !a.quoteVerified) return a;
  const passage = r.role === "stala_rola" ? r.claimReviewed ?? a.quote : a.quote;
  return statedDays(passage).includes(day) ? a : { ...a, excluded: "insufficient_event_date_precision" };
}

/** In an official accession register the effective admission date refutes membership
 * on an earlier day. Application dates, negotiations and a different country do not. */
export function refutesPriorMembership(claim: Claim, a: EvidenceAssessment, r: CorpusRecord | undefined): boolean {
  if (!r?.topics.includes("data-przystapienia") || r.role !== "tresc" || r.level !== 1 ||
      a.relation !== "OBALA" || a.aspect !== "czas" || a.verifier !== "zgoda" || a.excluded || !a.quoteVerified) return false;
  const terms = foldForMatch(claim.text);
  if (/\b(?:nie|ani|not|oraz|and)\b/u.test(terms)) return false;
  const subject = /\b([\p{Lu}][\p{L}-]*(?: [\p{Lu}][\p{L}-]*){0,2})\s+(?:był[ao]?|was)\s+(?:już\s+|already\s+)?(?:członkiem|członkinią|a member of)\s+([\p{L} ]+)/u.exec(claim.text);
  if (!subject) return false;
  const country = countryIdentity(subject[1]!);
  const organisation = foldForMatch(subject[2]!).trim();
  const passage = foldForMatch(a.quote);
  const accession = /^([a-z -]+?) (?:czlonkostwo w|przystapil[ao]? do|joined|became a member of) ([a-z ]+?) (?:od |on )?\d/u.exec(passage);
  if (!country || !accession || countryIdentity(accession[1]!) !== country || accession[2]!.trim() !== organisation) return false;
  const [asOf, ...extra] = statedDays(claim.text);
  const [entry, ...other] = statedDays(a.quote);
  return !!asOf && !!entry && !extra.length && !other.length && entry > asOf;
}
