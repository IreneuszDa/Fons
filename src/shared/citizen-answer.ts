import type { Claim, ClaimVerdict, VerdictReport } from "./contracts";
import { passageText } from "./evidence";

const sentenceEnd = (text: string) => text.trim().replace(/[.?!]+$/u, "") + ".";

/** The correction must fit as a whole. Cutting a quotation could remove an exception or a negation. */
function correction(v: ClaimVerdict): string | undefined {
  const item = v.evidence.find(e => e.usedForVerdict && e.relation === "OBALA" && e.passageKind === "excerpt" && e.role === "tresc"
    && e.lang?.split("-")[0] === "pl" && e.quote.trim().length <= 165 && e.quote.trim().length >= 12);
  if (!item) return;
  const quote = item.quote.trim().replace(/^Art\.\s*\d+[a-z]?\.\s*(?:\d+\.\s*)?/u, "")
    .replace(/(?<=[.!?])\s+Dowiedz się więcej(?:\s+[^.!?]*)?[.!?]?$/u, "");
  return "„" + quote + "”";
}

export function shortVerdict(v: ClaimVerdict, claim?: Claim): string {
  const statement = claim?.text.trim().replace(/[?!.]+$/u, "").trim();
  if (v.registerFactPl && (v.verdict === "POTWIERDZONE" || v.verdict === "FALSZYWE" || v.verdict === "WPROWADZAJACE") && v.evidence.some(e => e.usedForVerdict)) {
    const lead = { POTWIERDZONE: "Tak. ", FALSZYWE: "Nie. ", WPROWADZAJACE: v.ruleApplied === 4 ? "Ta informacja jest nieaktualna. " : "Częściowo. " };
    return lead[v.verdict] + sentenceEnd(v.registerFactPl);
  }
  if (v.parts?.length && !v.conflicting) {
    const labels = { POTWIERDZONE: "tak", FALSZYWE: "nie", BRAK_DOWODOW: "nie wiem",
      WPROWADZAJACE: "mylący kontekst", NIE_PODLEGA: "poza oceną" } as const;
    const parts = v.parts.map(p => "„" + p.text.replace(/[?.!]+$/u, "") + "” — " + labels[p.verdict]);
    const lead = v.verdict === "WPROWADZAJACE" ? "Nie w całości. " : "";
    return lead + parts.join(". ") + ".";
  }
  switch (v.verdict) {
    case "POTWIERDZONE":
      return statement && statement.length <= 165 ? "Tak. " + sentenceEnd(statement) : "Tak. Źródła potwierdzają to twierdzenie.";
    case "FALSZYWE": {
      const quote = correction(v);
      if (quote) return "Nie. " + quote;
      return statement && statement.length <= 140
        ? "Nie. Źródła przeczą twierdzeniu „" + statement + "”."
        : "Nie. Sprawdzone źródła przeczą tej informacji.";
    }
    case "BRAK_DOWODOW":
      if (v.conflicting) {
        const supporting = v.evidence.find(e => v.conflicting!.supporting.includes(e.recordId));
        const refuting = v.evidence.find(e => v.conflicting!.refuting.includes(e.recordId));
        const lead = "Nie wiem. Źródła podają sprzeczne informacje.";
        if (!supporting || !refuting) return lead;
        const side = (item: typeof supporting) => {
          const date = item.publishedAt?.slice(0, 10);
          const attribution = item.publisher + (date ? " (" + date + ")" : "");
          if (item.passageKind === "reviewed_claim" && item.ratingRaw) return attribution + " — ocena wydawcy „" + item.ratingRaw + "”";
          return item.quote.trim().length <= 180 ? attribution + " — " + passageText(item.quote.trim(), item.passageKind) : attribution;
        };
        return [lead, "Za twierdzeniem — " + side(supporting), "Przeciw twierdzeniu — " + side(refuting)].join("\n");
      }
      if (v.missingContext && v.missingContext.length <= 180) return "Nie wiem. Brakuje dowodu: " + sentenceEnd(v.missingContext);
      return "Nie wiem. W sprawdzonych źródłach brakuje dowodu.";
    case "WPROWADZAJACE":
      if (v.ruleApplied === 4) return "Nie w tym czasie. Informacja dotyczy innego okresu.";
      const quote = correction(v);
      if (quote) return "Nie w tej formie. " + quote;
      if (v.missingContext && v.missingContext.length <= 165) return "Nie w tej formie. " + sentenceEnd(v.missingContext);
      if (v.evidence.some(e => e.relation === "WSPIERA") && v.evidence.some(e => e.relation === "OBALA")) {
        return "Częściowo. " + (correction(v) ?? "Źródła potwierdzają tylko część twierdzenia.");
      }
      return "Nie w tej formie. Brakuje ważnego kontekstu.";
    case "NIE_PODLEGA":
      return claim?.type === "prognoza" ? "To prognoza. Jej wynik można sprawdzić dopiero po zdarzeniu."
        : claim?.type === "opinia" ? "To opinia." : "Tego nie da się ocenić jako prawdy lub fałszu.";
  }
}

export function citizenAnswerPl(report: VerdictReport): string {
  // A question about a fact-check (did they publish it?) and the proposition it rates can have opposite answers.
  if (report.status !== "OK") return report.statusMessagePl || report.summaryPl;
  if (report.answer) return report.answer.answerPl;
  if (report.inputMode === "transcription" || report.imageAnalysis?.only || report.questionParts?.length) return report.summaryPl;
  const claim = report.claims.find(c => c.isMain) ?? report.claims[0];
  const verdict = report.verdicts.find(v => v.claimId === claim?.id) ?? report.verdicts[0];
  if (verdict) return shortVerdict(verdict, claim);
  if (report.inputMode === "question_open") {
    const scope = report.summaryPl.trim();
    if (scope.length > 0 && scope.length <= 180) return /^nie wiem\b/iu.test(scope) ? scope : "Nie wiem. " + scope;
    return "Nie wiem. W sprawdzonych źródłach brakuje odpowiedzi.";
  }
  return report.summaryPl;
}
