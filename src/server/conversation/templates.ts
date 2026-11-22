/** Szablony odpowiedzi warstwy rozmowy — bez LLM, prosty polski. */
import { VERDICT_LABEL_PL, type ConversationReply, type VerdictReport } from "../../shared/contracts";
import { mediaClaimSubject } from "../../shared/attachments";
import { passageText, prioritizeConflictEvidence } from "../../shared/evidence";
import { citizenAnswerPl, shortVerdict } from "../../shared/citizen-answer";
import type { CaseOutcome } from "../moderator/cases";
import { isoDatePart, safeHttpUrl, truncate } from "../util";
import { ACTION } from "./intents";

type QuickReply = ConversationReply["quickReplies"][number];

export const QR = {
  sources: { id: ACTION.sources, labelPl: "Źródła" },
  why: { id: ACTION.why, labelPl: "Jak to sprawdziłeś?" },
  report: { id: ACTION.report, labelPl: "Zgłoś do sprawdzenia" },
  help: { id: ACTION.help, labelPl: "Pomoc" },
} satisfies Record<string, QuickReply>;

export const HELP_TEXT =
  "Wyślij mi informację, którą chcesz sprawdzić (tekst albo link do strony). Odpowiem, czy jest potwierdzona, fałszywa, wprowadzająca w błąd, czy brakuje dowodów, i pokażę źródła. " +
  "Możesz też napisać: „źródła”, „Jak to sprawdziłeś?”, „zgłoś” albo „usuń moje dane”. Nie wysyłaj tu haseł ani numerów kart.";

export const NO_REPORT_TEXT = "Nie mam jeszcze wyniku, który mógłbym pokazać. Wyślij mi najpierw informację do sprawdzenia.";

export function statusTextFor(report: VerdictReport): string {
  if (report.statusMessagePl) return report.statusMessagePl;
  switch (report.status) {
    case "NIEPELNE":
      return "Nie udało się sprawdzić tej informacji do końca, więc nie wydaję wyniku. Spróbuj ponownie za chwilę.";
    case "AWARIA":
      return "Wystąpił błąd techniczny. To nie jest wynik sprawdzenia. Spróbuj ponownie za chwilę.";
    case "DOPRECYZUJ":
      return "Nie jestem pewien, o co dokładnie pytasz. Napisz proszę, jakie konkretne twierdzenie mam sprawdzić.";
    case "POZA_ZAKRESEM":
      return "Tego nie sprawdzam: usługa weryfikuje twierdzenia o faktach.";
    default:
      return "Nie mogę teraz podać wyniku.";
  }
}

export const TECH_ERROR_TEXT = "Wystąpił błąd techniczny. To nie jest wynik sprawdzenia. Spróbuj ponownie za chwilę.";
export const BUDGET_TEXT =
  "Dzienny limit sprawdzeń został wyczerpany. Nie podaję wyniku bez sprawdzenia, więc spróbuj ponownie jutro.";
export const RATE_LIMITED_TEXT = "Wysyłasz zbyt wiele wiadomości naraz. Odczekaj minutę i spróbuj ponownie.";
export const TOO_LONG_TEXT = (max: number) => `Ta wiadomość jest za długa (limit to ${max} znaków). Wklej najważniejszy fragment albo jedno zdanie, które chcesz sprawdzić.`;
export const IMAGE_REJECTED_TEXT = "Nie mogę odczytać tego pliku. Wyślij zdjęcie lub zrzut ekranu w formacie JPG, PNG albo WebP.";
export const STALE_CONFIRM_TEXT = "To potwierdzenie wygasło albo nic nie czekało na potwierdzenie. Nic nie zostało zmienione.";
export const CANCELLED_TEXT = "Dobrze, nic nie zmieniam.";

export function caseNote(o: CaseOutcome): string {
  switch (o.action) {
    case "created":
      return o.alert === "sent"
        ? `Sprawa #${o.caseId} utworzona. Osoba odpowiedzialna została powiadomiona.`
        : `Sprawa #${o.caseId} utworzona i zapisana do przeglądu.`;
    case "updated":
      return o.alert === "sent"
        ? `Sprawa #${o.caseId} zaktualizowana. Osoba odpowiedzialna została powiadomiona.`
        : `Sprawa #${o.caseId} zaktualizowana: ktoś już zgłaszał podobną informację.`;
    case "recommended":
      return `Sprawa #${o.caseId} zapisana w kolejce moderatora. Zalecane szybkie sprawdzenie.`;
  }
}

export const CASE_FAILED_TEXT = "Nie udało się teraz zapisać sprawy. Możesz spróbować ponownie za chwilę.";

export function verdictText(report: VerdictReport): string {
  const lines: string[] = [];
  if (report.mainVerdict && (report.verdicts.length <= 1 || report.videoAnalysis)) {
    const claim = report.videoAnalysis && report.claims.find(c => c.isMain);
    lines.push(claim
      ? `Główne twierdzenie z ${mediaClaimSubject(report.videoAnalysis!)} „${claim.text}” — ${VERDICT_LABEL_PL[report.mainVerdict]}.`
      : `Wynik: ${VERDICT_LABEL_PL[report.mainVerdict]}.`);
  }
  lines.push(report.summaryPl);
  if (report.verdicts.length > 1) {
    for (const claim of report.claims) {
      const result = report.verdicts.find(v => v.claimId === claim.id);
      if (!result) continue;
      lines.push(`\n${claim.text}\n${VERDICT_LABEL_PL[result.verdict]}. ${result.reasonPl}`);
      const sources = new Set(result.evidence.map(e => safeHttpUrl(e.url)).filter(Boolean));
      for (const url of sources) lines.push(`Źródło: ${url}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function mainClaimVerdict(report: VerdictReport) {
  const main = report.claims.find((c) => c.isMain) ?? report.claims[0];
  return report.verdicts.find((v) => v.claimId === main?.id) ?? report.verdicts[0];
}

/** Both public channels lead with the same answer and reference the same publications. */
export function shortAnswerFor(report: VerdictReport, note?: string): NonNullable<ConversationReply["shortAnswer"]> {
  const sources = new Map<string, { title: string; publisher: string; url: string }>();
  const verdict = mainClaimVerdict(report);
  const evidence = report.questionParts?.flatMap(p => p.evidence) ?? report.answer?.evidence ?? (report.verdicts.length > 1
    ? report.verdicts.flatMap(item => item.evidence) : prioritizeConflictEvidence(
    [...(verdict?.evidence ?? [])].sort((a, b) => Number(!!b.usedForVerdict) - Number(!!a.usedForVerdict)), verdict?.conflicting));
  for (const item of evidence) {
    const url = safeHttpUrl(item.url);
    if (url && !sources.has(url)) sources.set(url, { url, title: item.title, publisher: item.publisher });
  }
  return {
    bodyPl: citizenAnswerPl(report),
    sources: [...sources.values()],
    ...(note && { caseNotePl: note }),
  };
}

export function shortAnswerText(answer: NonNullable<ConversationReply["shortAnswer"]>, report: VerdictReport): string {
  return report.questionParts?.length ? report.questionParts.map(p => p.questionPl + "\n" + p.answerPl).join("\n\n")
    : report.verdicts.length > 1 && !report.answer ? report.verdicts.map(v => {
      const claim = report.claims.find(c => c.id === v.claimId);
      return (claim?.text ?? "") + "\n" + shortVerdict(v, claim);
    }).join("\n\n") : answer.bodyPl;
}

export function sourcesText(report: VerdictReport): string {
  if (report.videoAnalysis?.status === "metadata_only") return "Parametry pochodzą z pliku przesłanego w tej rozmowie.";
  if (report.inputMode === "transcription") return "Źródłem transkrypcji jest nagranie przesłane w tej rozmowie.";
  const visual = report.imageAnalysis?.visual;
  if (visual) {
    if (visual.mode === "context") {
      const links = [...visual.citations.map(item => item.url), ...report.imageAnalysis!.images.flatMap(image => image.localSearch?.matches.map(item => item.url) ?? [])];
      return links.length ? [...new Set(links)].join("\n") : report.summaryPl;
    }
    if (!visual.citations.length) return visual.mode === "identity"
      ? "Nie mam publikacji z podpisem, który wskazywałby osobę na tym zdjęciu."
      : "Ta odpowiedź dotyczy tego, co widać na przesłanym obrazie.";
    return visual.citations.map(({ title, url, quote }) => [title, `„${quote}”`, safeHttpUrl(url)].filter(Boolean).join("\n")).join("\n\n");
  }
  if (report.imageAnalysis?.only) {
    const links = report.imageAnalysis.images.flatMap(({ search, localSearch }) => [
      ...(localSearch?.matches ?? []).map(match => match.url),
      ...(search?.matches ?? []).map(match => match.url ?? match.host),
      ...(search?.factChecks ?? []).map(review => review.url),
    ]);
    return links.length ? [...new Set(links)].join("\n") : report.summaryPl;
  }
  const items = [...report.verdicts.flatMap((v) => v.evidence), ...(report.answer?.evidence ?? []), ...(report.questionParts?.flatMap(p => p.evidence) ?? [])];
  if (items.length === 0) {
    return "Dla tego wyniku nie ma źródeł, które by go rozstrzygały.";
  }
  const passages = new Map(items.map(item => [
    JSON.stringify([safeHttpUrl(item.url) ?? item.recordId, item.quote]), item,
  ]));
  const lines: string[] = ["Źródła użyte w sprawdzeniu:"];
  for (const [index, e] of [...passages.values()].slice(0, 6).entries()) {
    const url = safeHttpUrl(e.url);
    lines.push(
      `${index + 1}. ${e.title} (${e.publisher}, opublikowano: ${isoDatePart(e.publishedAt)}, pobrano: ${isoDatePart(e.fetchedAt)})` +
        (url ? `\n   ${url}` : "") +
        `\n   ${e.passageKind === "excerpt" ? "Cytat: " : ""}${passageText(truncate(e.quote, 200), e.passageKind)}`,
    );
  }
  if (passages.size > 6) lines.push("Pełna lista jest na stronie wyniku.");
  return lines.join("\n");
}

export function whyText(report: VerdictReport): string {
  const reason = report.status === "OK" && !report.answer && !report.questionParts?.length && mainClaimVerdict(report)?.reasonPl;
  return [reason || citizenAnswerPl(report), sourcesText(report)].filter(Boolean).join("\n\n");
}

export function deletedText(counts: { reports: number; runs: number; archives: number }): string {
  return (
    `Usunąłem Twoje rozmowy, raporty (${counts.reports}) i historię zapytań (${counts.runs}). ` +
    (counts.archives ? `Usunąłem też zapisane fragmenty materiałów (${counts.archives}). ` : "") +
    "Zostają tylko zanonimizowane statystyki techniczne, bez treści wiadomości."
  );
}
