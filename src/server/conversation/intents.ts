/**
 * Rozpoznawanie intencji: przyciski (action) i słowa kluczowe. Słowo kluczowe działa tylko wtedy,
 * gdy jest CAŁĄ wiadomością — fraza w dłuższym, przekazanym tekście niczego nie uruchamia (PLAN §7).
 * „Usuń moje dane” i „zgłoś” zawsze wymagają potwierdzenia (przycisk albo druga jawna wiadomość).
 */
import type { InboundMessage } from "../../shared/contracts";
import { foldWords } from "../util";

export type PendingType = "delete" | "report";

export type Intent =
  | { type: "verify" }
  | { type: "help" }
  | { type: "sources" }
  | { type: "why" }
  | { type: "request"; what: PendingType }
  | { type: "confirm"; what: PendingType }
  | { type: "cancel" }
  | { type: "stale_confirm" };

export const ACTION = {
  help: "help",
  sources: "sources",
  why: "why",
  report: "report",
  reportConfirm: "report_confirm",
  reportCancel: "report_cancel",
  delete: "delete",
  deleteConfirm: "delete_confirm",
  deleteCancel: "delete_cancel",
} as const;

const PHRASES = {
  sources: ["zrodla", "zrodlo", "pokaz zrodla", "jakie zrodla", "podaj zrodla"],
  why: ["jak to sprawdziles", "dlaczego", "dlaczego tak", "dlaczego taki wynik", "uzasadnienie", "uzasadnij"],
  report: ["zglos", "zglos to", "zglos wynik", "zglos do sprawdzenia", "zglos do moderatora"],
  delete: ["usun moje dane", "usun dane", "skasuj moje dane", "usun wszystkie moje dane"],
  help: ["pomoc", "pomocy", "help", "start", "menu"],
  confirmDelete: ["tak", "tak usun", "potwierdzam", "potwierdzam usuniecie", "tak usun moje dane"],
  confirmReport: ["tak", "tak zglos", "potwierdzam", "potwierdzam zgloszenie", "tak zglos to"],
  cancel: ["nie", "anuluj", "rezygnuje", "nie usuwaj", "nie zglaszaj", "stop", "nie teraz"],
} as const;

export function detectIntent(msg: Pick<InboundMessage, "text" | "action" | "images">, pending: PendingType | undefined): Intent {
  if (msg.action) {
    switch (msg.action) {
      case ACTION.help:
        return { type: "help" };
      case ACTION.sources:
        return { type: "sources" };
      case ACTION.why:
        return { type: "why" };
      case ACTION.report:
        return { type: "request", what: "report" };
      case ACTION.delete:
        return { type: "request", what: "delete" };
      case ACTION.reportConfirm:
        return pending === "report" ? { type: "confirm", what: "report" } : { type: "stale_confirm" };
      case ACTION.deleteConfirm:
        return pending === "delete" ? { type: "confirm", what: "delete" } : { type: "stale_confirm" };
      case ACTION.reportCancel:
      case ACTION.deleteCancel:
        return { type: "cancel" };
      default:
        return { type: "help" };
    }
  }

  if (msg.images.length > 0) return { type: "verify" };
  const norm = foldWords(msg.text);
  if (norm === "") return { type: "help" };
  // Tylko krótkie wiadomości mogą być poleceniami.
  if (norm.split(" ").length > 6) return { type: "verify" };

  if (pending) {
    const confirms: readonly string[] = pending === "delete" ? [...PHRASES.confirmDelete, ...PHRASES.delete] : [...PHRASES.confirmReport, ...PHRASES.report];
    if (confirms.includes(norm)) return { type: "confirm", what: pending };
    if ((PHRASES.cancel as readonly string[]).includes(norm)) return { type: "cancel" };
  }
  const is = (list: readonly string[]) => list.includes(norm);
  if (is(PHRASES.delete)) return { type: "request", what: "delete" };
  if (is(PHRASES.report)) return { type: "request", what: "report" };
  if (is(PHRASES.sources)) return { type: "sources" };
  if (is(PHRASES.why)) return { type: "why" };
  if (is(PHRASES.help)) return { type: "help" };
  return { type: "verify" };
}
