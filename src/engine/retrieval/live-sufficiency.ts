import { splitSentences } from "../../security/text";
import type { CatalogSource, CorpusRecord, RetrievalQuery, Verdict } from "../../shared/contracts";
import { statedDays } from "../event-day";
import { normalizeQuoteText } from "../quotes";
import { isQualifiedFixedRole } from "../verdict/decisive";
import { queryStems } from "./live-score";
import { requiresFreshDocument } from "./live-store";

interface ReadPage {
  source: CatalogSource;
  title: string;
  publishedAt: string | null;
  passages: readonly string[];
  reviews: readonly CorpusRecord[];
}

function statement(text: string): string {
  return normalizeQuoteText(text).replace(/[.]$/u, "").trim();
}

// Repetition in a denial, attributed quotation or correction is not the publisher's assertion.
const QUALIFIED_CONTEXT = /["„”«»?]|\b(?:mit|myth|fałsz|false|untrue|nieprawd\p{L}*|nie jest (?:to )?prawd\p{L}*|fake|rzekom\p{L}*|allegedly|sprostowan\p{L}*|dement\p{L}*|korekt\p{L}*|correction|twierdz\p{L}*|claimed|according to|według)\b/iu;

// Only an explicit date directly completing the same statement can answer "Kiedy ...?".
// Keep modifiers such as "do", "od", "dopiero" and "prawdopodobnie" meaningful.
function dateCompleting(sentence: string, proposition: string): string | undefined {
  if (!sentence.startsWith(proposition + " ")) return;
  const ending = sentence.slice(proposition.length).trim();
  if (!/^(?:w dniu |dnia )?(?:\d{1,2} \p{L}+ \d{4}(?: r(?:oku)?)?|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})$/u.test(ending)) return;
  return statedDays(ending)[0];
}

/** This stops URL discovery only. The reader and verifier still assess the selected evidence. */
export function canFinishLiveSearch(
  q: RetrievalQuery,
  texts: readonly string[],
  pages: readonly ReadPage[],
  publisherHosts: readonly string[],
): boolean {
  if (!texts[0] || !pages.length || q.claim.type !== "fakt" || requiresFreshDocument(q)
    || q.claim.temporal.asOf || q.claim.temporal.publishedBy) return false;
  // Additional search phrases can omit qualifiers and negation. Only the user's full proposition
  // can establish a match. Accept a Polish yes/no question when its body is a complete statement.
  const original = q.claim.text.trim();
  if (statement(texts[0]) !== statement(original)) return false;
  const when = /^kiedy\s+(.+)\?$/isu.exec(original);
  const proposition = when?.[1] ?? (/^czy\s.+\?$/isu.test(original) ? original.slice(3, -1).trim() : original);
  if (proposition.includes("?")) return false;
  const full = statement(proposition);
  const terms = queryStems([full]);
  if (terms.length < 3) return false;
  const related = (text: string): boolean => {
    const words = new Set(queryStems([text]));
    return terms.filter(term => words.has(term)).length >= Math.max(2, Math.ceil(terms.length * 0.6));
  };

  const directions = new Set<Verdict>();
  const dates = new Set<string>();
  const coveredHosts = new Set<string>();
  for (const page of pages) {
    if (q.asOf && page.publishedAt && Date.parse(page.publishedAt) > Date.parse(q.asOf)) continue;
    let direct = false;
    for (const review of page.reviews) {
      if (!review.claimReviewed || !related(review.claimReviewed)) continue;
      const rating = review.rating?.mapped;
      if (when || statement(review.claimReviewed) !== full || !isQualifiedFixedRole(review)
        || (rating !== "POTWIERDZONE" && rating !== "FALSZYWE" && rating !== "WPROWADZAJACE")) return false;
      directions.add(rating);
      direct = true;
    }
    // A matching structured review already gives this publisher's direction. Its article may
    // reproduce the disputed assertion in order to explain its rating.
    if (!direct) {
      for (const passage of page.passages) {
        for (const sentence of splitSentences(passage)) {
          if (!related(sentence.text)) continue;
          if (page.source.type !== "pierwotne" || page.source.level !== 1 || page.source.role !== "tresc"
            || QUALIFIED_CONTEXT.test(passage) || QUALIFIED_CONTEXT.test(page.title)) return false;
          const normalized = statement(sentence.text);
          if (when) {
            const date = dateCompleting(normalized, full);
            if (!date) return false;
            dates.add(date);
          } else if (normalized !== full) return false;
          directions.add("POTWIERDZONE");
          direct = true;
        }
      }
    }
    if (direct) for (const host of page.source.hosts) coveredHosts.add(host);
  }
  return directions.size === 1 && dates.size <= 1 && publisherHosts.every(host => coveredHosts.has(host));
}
