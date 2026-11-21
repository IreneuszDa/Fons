/** Szablony odpowiedzi warstwy rozmowy — bez LLM, prosty polski. */
import { VERDICT_LABEL_PL, type ConversationReply, type VerdictReport } from "../../shared/contracts";
import { plural } from "../../engine/verdict/texts";
import type { CaseOutcome } from "../moderator/cases";
import { isoDatePart, safeHttpUrl, truncate } from "../util";
import { ACTION } from "./intents";

type QuickReply = ConversationReply["quickReplies"][number];

export const QR = {
  sources: { id: ACTION.sources, labelPl: "Źródła" },
  why: { id: ACTION.why, labelPl: "Dlaczego?" },
  report: { id: ACTION.report, labelPl: "Zgłoś do sprawdzenia" },
  delete: { id: ACTION.delete, labelPl: "Usuń moje dane" },
  help: { id: ACTION.help, labelPl: "Pomoc" },
} satisfies Record<string, QuickReply>;

export const STRENGTH_PL = { slaba: "słaba", srednia: "średnia", mocna: "mocna" } as const;

export const HELP_TEXT =
  "Wyślij mi informację, którą chcesz sprawdzić (tekst albo link do strony). Odpowiem, czy jest potwierdzona, fałszywa, wprowadzająca w błąd, czy brakuje dowodów, i pokażę źródła. " +
  "Możesz też napisać: „źródła”, „dlaczego”, „zgłoś” albo „usuń moje dane”. Nie wysyłaj tu haseł ani numerów kart.";

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

export function verdictText(report: VerdictReport, note?: string): string {
  const lines: string[] = [];
  if (report.mainVerdict) lines.push(`Wynik: ${VERDICT_LABEL_PL[report.mainVerdict]}.`);
  lines.push(report.summaryPl);
  for (const w of report.warnings) lines.push(`Uwaga: ${w.textPl}`);
  if (note) lines.push(note);
  return lines.filter(Boolean).join("\n");
}

/** Odpowiedź na pytanie otwarte: tekst złożony przez kod z cytatu + odnośnik do źródła (nigdy z wiedzy modelu). */
export function answerText(report: VerdictReport, note?: string): string {
  const a = report.answer;
  if (!a) return verdictText(report, note);
  const lines: string[] = [a.answerPl];
  const first = a.evidence[0];
  const url = first ? safeHttpUrl(first.url) : null;
  if (first && url) lines.push(`Źródło: ${first.title} (${first.publisher}): ${url}`);
  for (const w of report.warnings) lines.push(`Uwaga: ${w.textPl}`);
  if (note) lines.push(note);
  return lines.filter(Boolean).join("\n");
}

export function mainClaimVerdict(report: VerdictReport) {
  const main = report.claims.find((c) => c.isMain) ?? report.claims[0];
  return report.verdicts.find((v) => v.claimId === main?.id) ?? report.verdicts[0];
}

function searchSummary(report: VerdictReport): string {
  const activity = report.sourceActivity;
  if (!activity) return "";
  const summary: string[] = [];
  if (report.cacheHit) summary.push("Ten wynik pochodzi z zapisanego wcześniej sprawdzenia.");
  const searched = activity.branches.filter(branch => branch.status === "completed" || branch.status === "partial");
  if (searched.length) {
    summary.push(searched.map(b => `• ${b.labelPl}`).join("\n"));
    const count = activity.candidateCount;
    const assessed = activity.assessedCount;
    summary.push(`Wyszukiwanie zwróciło ${count} ${plural(count, "fragment", "fragmenty", "fragmentów")}. Model ocenił ${assessed} ${plural(assessed, "fragment", "fragmenty", "fragmentów")}.`);
  } else if (!activity.branches.length) {
    summary.push("W tym sprawdzeniu nie zarejestrowano przeszukania źródeł.");
  }
  const unavailable = activity.branches.filter(branch => branch.status === "partial" || branch.status === "unavailable");
  for (const branch of unavailable) summary.push(`${branch.labelPl} — ${branch.status === "partial" ? "część wyszukiwań się nie powiodła" : "metoda była niedostępna"}.`);
  return summary.join("\n");
}

export function sourcesText(report: VerdictReport, resultUrl?: string): string {
  if (report.imageAnalysis?.only) {
    const links = report.imageAnalysis.images.flatMap(({ search }) => [
      ...(search?.matches ?? []).map(match => match.url ?? match.host),
      ...(search?.factChecks ?? []).map(review => review.url),
    ]);
    return links.length ? [...new Set(links)].join("\n") : report.summaryPl;
  }
  const items = [...report.verdicts.flatMap((v) => v.evidence), ...(report.answer?.evidence ?? [])];
  if (items.length === 0) {
    const tried = mainClaimVerdict(report)?.triedPl;
    return [
      "Dla tego wyniku nie ma źródeł, które by go rozstrzygały.",
      searchSummary(report) || (tried ? `Co sprawdzałem: ${tried}` : undefined),
      resultUrl ? `Pełny wynik: ${resultUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
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
        `\n   Cytat: „${truncate(e.quote, 200)}”`,
    );
  }
  if (passages.size > 6) lines.push("Pełna lista jest na stronie wyniku.");
  if (resultUrl) lines.push(`Pełny wynik: ${resultUrl}`);
  lines.push("Przeczytaj źródło sam: to najpewniejszy sposób, żeby ocenić sprawę.");
  return lines.join("\n");
}

export function whyText(report: VerdictReport): string {
  if (report.imageAnalysis?.only) return [report.summaryPl, report.transparencyPl].join("\n");
  const activity = searchSummary(report);
  if (report.answer && !mainClaimVerdict(report)) {
    return [
      activity,
      "Podstawą odpowiedzi jest dosłowny cytat ze źródła z katalogu. Kod sprawdził jego zgodność z zapisanym fragmentem.",
      report.transparencyPl,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const v = mainClaimVerdict(report);
  if (!v) return [report.statusMessagePl || report.summaryPl, activity].filter(Boolean).join("\n");
  const lines: string[] = [`Dlaczego taki wynik: ${v.reasonPl}`];
  const s = v.strength;
  const points = typeof s.score === "number" ? `, ${s.score}/100` : "";
  lines.push(
    `Siła podstawy: ${STRENGTH_PL[s.level]}${points} (źródła pierwotne: ${s.primarySources}, niezależni wydawcy: ${s.independentPublishers}).`,
  );
  for (const f of s.factors ?? []) lines.push(`${f.effect === "plus" ? "+" : "−"} ${f.textPl}`);
  if (v.missingContext) lines.push(`Brakujący kontekst: ${v.missingContext}`);
  if (v.conflicting) lines.push("Źródła są sprzeczne: nie wskazuję zwycięzcy, obie strony są na stronie wyniku.");
  if (activity) lines.push(activity);
  else if (v.triedPl) lines.push(`Co sprawdzałem: ${v.triedPl}`);
  for (const n of s.notes) lines.push(`Uwaga: ${n}`);
  lines.push(report.transparencyPl);
  return lines.filter(Boolean).join("\n");
}

export function deletedText(counts: { reports: number; runs: number }): string {
  return (
    `Usunąłem Twoje dane: raporty (${counts.reports}), historię zapytań (${counts.runs}) i tę rozmowę. ` +
    "Zostają tylko zanonimizowane statystyki techniczne, bez treści wiadomości."
  );
}
