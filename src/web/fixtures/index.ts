/**
 * Fixture backend for ?fixtures=1 (UI review without the API). Loaded lazily by api.ts,
 * so these JSON files are a separate chunk that the normal app never downloads.
 * Every reply-*.json conforms to ConversationReply (checked in fixtures.test.ts).
 */
import type { ConversationReply, VerdictReport } from "../../shared/contracts";
import type { ChatInput, SourcesResponse } from "../api";
import answer from "./reply-answer.json";
import answerNone from "./reply-answer-none.json";
import brak from "./reply-brak-dowodow-conflict.json";
import falszywe from "./reply-falszywe-injection.json";
import niePodlega from "./reply-nie-podlega.json";
import potwierdzone from "./reply-potwierdzone.json";
import niepelne from "./reply-status-niepelne.json";
import wprowadzajace from "./reply-wprowadzajace.json";
import sources from "./sources.json";

export const FIXTURE_REPLIES: Record<string, ConversationReply> = {
  potwierdzone: potwierdzone as unknown as ConversationReply,
  falszywe: falszywe as unknown as ConversationReply,
  wprowadzajace: wprowadzajace as unknown as ConversationReply,
  brak: brak as unknown as ConversationReply,
  niePodlega: niePodlega as unknown as ConversationReply,
  niepelne: niepelne as unknown as ConversationReply,
  odpowiedz: answer as unknown as ConversationReply,
  brakOdpowiedzi: answerNone as unknown as ConversationReply,
};

const ORDER = ["potwierdzone", "falszywe", "wprowadzajace", "brak", "niePodlega", "niepelne", "odpowiedz", "brakOdpowiedzi"] as const;

/** Keyword → fixture, so the suggestion chips and manual tests are predictable. */
const KEYWORDS: [RegExp, (typeof ORDER)[number]][] = [
  [/mars|atlanty/i, "brakOdpowiedzi"],
  [/^\s*(kto|kiedy|gdzie|ile|jak[aiey]?|który|która|które|co)\b[^?]*\?\s*$/i, "odpowiedz"],
  [/unii|unia|schengen/i, "potwierdzone"],
  [/msz|niemiec|zakaz|https?:\/\//i, "falszywe"],
  [/inflac/i, "wprowadzajace"],
  [/turyst|japon/i, "brak"],
  [/najpi|opini|uważam/i, "niePodlega"],
  [/awari|niepełn|niepeln|podatek/i, "niepelne"],
];

let cursor = 0;

const TEXT_REPLIES: Record<string, string> = {
  why: "Wynik wynika z reguł, które stosuje kod: liczy się to, co mówią cytaty ze źródeł z katalogu, ich daty i niezależność wydawców. Szczegóły są w sekcji „Jak sprawdziłem” przy wyniku.",
  sources: "Źródła wyniku są wypisane pod kartą wyniku, w grupach „Co potwierdza”, „Co przeczy” i „Kontekst”. Pełną listę źródeł usługi znajdziesz na stronie Źródła.",
  help: "Wyślij mi informację, którą chcesz sprawdzić (tekst albo link do strony). Odpowiem, czy jest potwierdzona, fałszywa, wprowadzająca w błąd, czy brakuje dowodów, i pokażę źródła. Nie wysyłaj tu haseł ani numerów kart.",
};

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fixtureChat(input: ChatInput, onVerificationStart?: () => void): Promise<ConversationReply> {
  const text = input.text?.trim() ?? "";
  const greeting = /^(?:(?:hej|cześć|dzień dobry|siema)[,!\s]+)?(?:co to(?: jest| za aplikacja)?|kim jesteś|co potrafisz)[.!?\s]*$/i.test(text)
    || /^(?:hej|cześć|dzień dobry|siema)[.!?\s]*$/i.test(text);
  const help = /^(pomoc|help)[.!?\s]*$/i.test(text);
  if (!input.action && !greeting && !help) onVerificationStart?.();
  await delay(900);
  if (input.action) {
    if (input.action === "delete") {
      return {
        kind: "confirm_delete",
        textPl: "Czy na pewno usunąć wszystkie Twoje dane z tej rozmowy (wiadomości i wyniki)?",
        quickReplies: [
          { id: "delete_confirm", labelPl: "Tak, usuń" },
          { id: "delete_cancel", labelPl: "Nie, zostaw" },
        ],
      };
    }
    if (input.action === "delete_confirm") return { kind: "deleted", textPl: "Usunięto dane tej rozmowy.", quickReplies: [{ id: "help", labelPl: "Pomoc" }] };
    if (input.action === "report") {
      return {
        kind: "confirm_report",
        textPl: "Zgłosić tę informację do sprawdzenia przez moderatora?",
        quickReplies: [
          { id: "report_confirm", labelPl: "Tak, zgłoś" },
          { id: "report_cancel", labelPl: "Nie" },
        ],
      };
    }
    if (input.action === "report_confirm") return { kind: "reported", textPl: "Dziękuję. Zgłoszenie trafiło do moderatora.", quickReplies: [] };
    const kind = input.action === "why" ? "why" : input.action === "sources" ? "sources" : "help";
    return { kind, textPl: TEXT_REPLIES[kind] ?? TEXT_REPLIES.help!, quickReplies: [{ id: "help", labelPl: "Pomoc" }] };
  }
  if (input.image || input.document) return {
    kind: "help",
    textPl: "Tryb danych przykładowych nie analizuje załączników. Aby sprawdzić własny plik, otwórz czat z parametrem ?fixtures=0.",
    quickReplies: [],
  };
  if (greeting) return {
    kind: "help",
    textPl: "Jestem Fons. Pomagam sprawdzać informacje w źródłach. Zadaj mi pytanie albo wklej tekst lub link.",
    quickReplies: [],
  };
  if (help) return { kind: "help", textPl: TEXT_REPLIES.help!, quickReplies: [] };
  const hit = KEYWORDS.find(([re]) => re.test(text));
  const key = hit ? hit[1] : ORDER[cursor++ % ORDER.length]!;
  return structuredClone(FIXTURE_REPLIES[key]!);
}

export async function fixtureReport(token: string): Promise<VerdictReport | null> {
  await delay(300);
  for (const r of Object.values(FIXTURE_REPLIES)) if (r.report?.token === token) return structuredClone(r.report);
  return null;
}

export async function fixtureSources(): Promise<SourcesResponse> {
  await delay(200);
  return sources as unknown as SourcesResponse;
}
