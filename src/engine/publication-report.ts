import type { Claim, ClaimVerdict, NormalizedInput, VerdictReport } from "../shared/contracts";
import type { PublishedAnswer } from "./published";
import { createDemagogTopicIndex } from "./retrieval/demagog-topic";
import { asksAboutDemagogReview, googleIndexMessage, type IndexMiss } from "./retrieval/google-claimreview";
import { ngramContainment } from "./text";
import type { PublicationRun } from "./verify";

function indexMiss(run: PublicationRun, result: IndexMiss): VerdictReport {
  const down = result.status === "unavailable";
  run.recordLookup("google_claimreview", down ? "unavailable" : "completed", []);
  run.inputMode = "question_open";
  const message = googleIndexMessage(result);
  return run.report({
    status: down ? "NIEPELNE" : "OK", verdictMode: "rules", summaryPl: message,
    ...(down && { statusMessagePl: message }),
    transparencyPl: down ? "Nie udało się zakończyć sprawdzenia w indeksie Google Fact Check Tools."
      : "Wyniki wyszukiwania w indeksie Google Fact Check Tools nie zawierały pasującej publikacji Demagoga.",
  });
}

/** The publisher's label evaluates the cited claim. Sources supplying only context stay with the public answer. */
function publicationVerdict(run: PublicationRun, publication: PublishedAnswer, question: string, liveReview: boolean): ClaimVerdict[] {
  if (!publication.claimPl || !publication.verdict) return [];
  const evidence = publication.evidence.filter(e => e.role === "stala_rola" && e.ratingRaw && e.recordId === publication.reviewRecordId);
  const source = evidence[0];
  if (!source) return [];
  const claim: Claim = {
    id: "c0", text: publication.claimPl, type: "fakt", isMain: true,
    temporal: { kind: "brak" }, inputOverlap: ngramContainment(publication.claimPl, question),
  };
  run.claims = [claim];
  const reviewed = liveReview ? undefined : run.deps.store.get(source.recordId);
  const opposite = reviewed?.rating?.mapped && reviewed.rating.mapped !== publication.verdict;
  return [{
    claimId: claim.id, verdict: publication.verdict, ruleApplied: 6, evidence,
    reasonPl: opposite
      ? `Podana w publikacji ocena „${source.ratingRaw}” dotyczy twierdzenia przeciwnego.`
      : `${source.publisher} podaje dla tej tezy ocenę „${source.ratingRaw}”.`,
    strength: {
      level: "srednia", independentPublishers: new Set(evidence.map(e => e.publisher)).size,
      primarySources: 0, newestEvidenceAt: evidence.flatMap(e => e.publishedAt ? [e.publishedAt] : []).sort().at(-1) ?? null,
      archivalWarning: false, verifierAgreement: "brak", notes: [],
    },
  }];
}

export interface PublicationReportOptions {
  /** "retrieval" means the search branches are already recorded in the run. */
  origin?: "retrieval" | "google_claimreview" | "publications";
  basisPl?: string;
  verdictMode?: VerdictReport["verdictMode"];
}

export function reportPublication(run: PublicationRun, publication: PublishedAnswer, question: string, options: PublicationReportOptions = {}) {
  const { origin = "publications", verdictMode = "rules" } = options;
  if (origin !== "retrieval") run.recordLookup(origin, "completed", publication.evidence.map(e => e.recordId));
  const verdicts = publicationVerdict(run, publication, question, origin === "google_claimreview");
  // Lead the answer with the publisher's finding when it supplies the verdict.
  // A headline can identify the item, and a quoted claimant can explain the dispute.
  const findings = new Set(verdicts[0]?.evidence.filter(e =>
    e.passageKind === "excerpt" && (e.relation === "OBALA" || e.relation === "WSPIERA")));
  const evidenceOrder = (e: PublishedAnswer["evidence"][number]) =>
    findings.has(e) ? 0 : e.passageKind === "reviewed_claim" ? 2 : 1;
  const evidence = [...publication.evidence].sort((a, b) => evidenceOrder(a) - evidenceOrder(b));
  run.inputMode = /^czy\b/i.test(question.trim()) ? "question_yesno" : "question_open";
  return run.report({
    status: "OK", verdictMode, verdicts, mainVerdict: verdicts[0]?.verdict ?? null,
    answer: { questionPl: question, answerPl: publication.answerPl, evidence },
    summaryPl: publication.answerPl,
    transparencyPl: options.basisPl ?? "Odpowiedź oparto na publikacjach wskazanych w raporcie.",
  });
}

/** Explicit questions about the publisher are resolved from a fresh search. Other questions continue to retrieval. */
async function lookupReview(run: PublicationRun, question: string, signal?: AbortSignal) {
  if (!asksAboutDemagogReview(question)) return;
  run.stage("searching");
  const lookup = run.deps.demagogTopicIndex ?? createDemagogTopicIndex();
  return lookup(question, run.deps.now(), signal, {
    llm: run.faults.has("llm_down") ? undefined : run.deps.llm, onUsage: usage => run.models.push(usage),
  });
}

export async function publicationQuestionPart(run: PublicationRun, questionPl: string, signal?: AbortSignal):
Promise<NonNullable<VerdictReport["questionParts"]>[number] | undefined> {
  const outcome = await lookupReview(run, questionPl, signal);
  if (!outcome) return;
  if (outcome.status === "hit" || outcome.status === "related") {
    const { evidence, answerPl } = outcome.publication;
    run.recordLookup("google_claimreview", "completed", evidence.map(e => e.recordId));
    return { questionPl, answerPl, evidence, status: outcome.status === "hit" ? "answered" : "insufficient" };
  }
  const status = outcome.status === "unavailable" ? "unavailable" : "insufficient";
  if (outcome.status !== "clarify") run.recordLookup("google_claimreview", status === "unavailable" ? "unavailable" : "completed", []);
  const answerPl = outcome.status === "clarify" ? outcome.messagePl : googleIndexMessage(outcome as IndexMiss);
  return { questionPl, status, answerPl, evidence: [] };
}

export async function findPublicationReport(run: PublicationRun, input: NormalizedInput, _receivedAt: Date, signal?: AbortSignal): Promise<VerdictReport | undefined> {
  if (input.kind !== "text") return;
  const outcome = await lookupReview(run, input.text, signal);
  if (!outcome) return;
  run.inputMode = "question_open";
  switch (outcome.status) {
    case "empty":
    case "unavailable":
      return indexMiss(run, outcome);
    case "clarify":
      return run.report({ status: "DOPRECYZUJ", verdictMode: "rules", statusMessagePl: outcome.messagePl,
        transparencyPl: "Do wyszukania publikacji w indeksie potrzebna jest treść tezy lub tytuł." });
    case "hit":
    case "related":
      return reportPublication(run, outcome.publication, input.text, {
        origin: "google_claimreview", basisPl: outcome.status === "related"
          ? "Indeks Google Fact Check Tools zwrócił publikację na podobny temat. Zgodność tezy wymaga doprecyzowania."
          : "Wyszukano publikację w indeksie Google Fact Check Tools. Sprawdzona teza i jej ocena pochodzą z wpisu wydawcy.",
      });
  }
}
