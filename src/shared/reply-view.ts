import type { ConversationReply, TechStatus, Verdict, VerdictReport } from "./contracts";
import type { ImageComparison, ImageSearchResult, LocalImageSearch } from "./image-search";
import type { ImageProvenance } from "./image-provenance";

export const imageComparisonPl: Record<ImageComparison, string> = {
  identical_file: "Oba pliki są identyczne bajt po bajcie.",
  same_pixels: "Pliki różnią się zapisem, ale mają te same wymiary i identyczne piksele po odczycie w sRGB.",
  similar: "Obrazy mają zbliżone proporcje i podobny rozkład kolorów. Taki wynik może dać zmiana rozmiaru lub kompresji. Drobne zmiany treści mogą pozostać niewidoczne dla tej metody.",
  no_match: "Obrazy nie spełniają kryteriów podobieństwa całego kadru. Inne kadrowanie, obrót lub duża zmiana kolorów mogą utrudniać wykrycie wspólnego pochodzenia.",
};

export function imageFileLabel(file: NonNullable<ImageProvenance["file"]>): string {
  return `${file.format.toUpperCase()} · ${file.width} × ${file.height} pikseli · ${file.bytes.toLocaleString("pl-PL")} B`;
}

export function imageMatchLabel(match: ImageSearchResult["matches"][number]): string {
  if (match.kind === "full") return "Cały obraz";
  if (match.kind === "partial") return "Fragment obrazu";
  if (match.publishedAt) return `Strona z obrazem · publikacja z ${match.publishedAt}`;
  if (match.pageMatch === "full") return "Strona z całym obrazem";
  if (match.pageMatch === "partial") return "Strona z fragmentem obrazu";
  return "Strona z obrazem";
}

/** Copy of VERDICT_LABEL_PL from contracts (value import would pull zod into the bundle). Kept in sync by a unit test. */
export const VERDICT_LABEL_PL: Record<Verdict, string> = {
  POTWIERDZONE: "Potwierdzone",
  FALSZYWE: "Fałszywe",
  WPROWADZAJACE: "Wprowadzające w błąd",
  BRAK_DOWODOW: "Brak wystarczających dowodów",
  NIE_PODLEGA: "Nie podlega weryfikacji",
};

export const STATUS_TITLE_PL: Record<TechStatus, string> = {
  OK: "Sprawdzenie zakończone",
  NIEPELNE: "Nie udało się dokończyć sprawdzenia",
  AWARIA: "Wystąpił problem techniczny",
  DOPRECYZUJ: "Potrzebuję więcej szczegółów",
  POZA_ZAKRESEM: "Tego nie sprawdzam",
};

/** How the chat should render a reply. A technical status is never shown as a verdict. */
export type ReplyView = "verdict" | "answer" | "status" | "text";

/** An open question ("Kto…?", "Kiedy…?") is answered only with a verified quote — rendered by AnswerCard, not VerdictCard. */
export function isOpenQuestion(report: VerdictReport | undefined): boolean {
  return !!report && (report.inputMode === "question_open" || !!report.answer);
}

export function replyView(reply: ConversationReply): ReplyView {
  if (reply.report && reply.report.status === "OK" && (reply.kind === "answer" || (reply.kind === "verdict" && isOpenQuestion(reply.report)))) return "answer";
  if (reply.kind === "answer") return reply.report ? "status" : "text"; // an answer reply without OK report is a technical status
  if (reply.kind === "verdict" && reply.report && reply.report.status === "OK" && reply.report.mainVerdict) return "verdict";
  if (reply.kind === "status" || reply.kind === "rate_limited") return "status";
  if (reply.kind === "verdict") return "status"; // defensive: a "verdict" without a usable verdict is a technical status
  return "text";
}

export type StatusKey = Exclude<TechStatus, "OK"> | "RATE_LIMITED" | "GENERIC";

export function statusOf(reply: ConversationReply): StatusKey {
  if (reply.kind === "rate_limited") return "RATE_LIMITED";
  const s = reply.report?.status;
  return s && s !== "OK" ? s : "GENERIC";
}

export const STATUS_KEY_TITLE_PL: Record<StatusKey, string> = {
  NIEPELNE: STATUS_TITLE_PL.NIEPELNE,
  AWARIA: STATUS_TITLE_PL.AWARIA,
  DOPRECYZUJ: STATUS_TITLE_PL.DOPRECYZUJ,
  POZA_ZAKRESEM: STATUS_TITLE_PL.POZA_ZAKRESEM,
  RATE_LIMITED: "Za dużo wiadomości w krótkim czasie",
  GENERIC: "Nie mogę teraz tego sprawdzić",
};

export function localImageScope(search: LocalImageSearch): string {
  if (search.status === "unavailable") return "Nie udało się porównać obrazu z lokalnym katalogiem.";
  return `Liczba zdjęć porównanych w lokalnym katalogu: ${search.checked}.` + (search.matches.length
    ? " Data publikacji dotyczy wskazanej strony. Samo dopasowanie nie potwierdza opisu przesłanego zdjęcia."
    : " Nie znaleziono dopasowania w tym zbiorze.");
}

export function localImageMatchLabel(match: LocalImageSearch["matches"][number]): string {
  return `${match.kind === "identical" ? "Identyczny plik" : "Podobny obraz"} · ${match.publisher} · publikacja z ${match.publishedAt}`;
}
