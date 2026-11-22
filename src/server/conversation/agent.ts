import type { ConversationReply } from "../../shared/contracts";
import { FONS_PROFILE } from "../../engine/llm/conversation-profile";
import { foldWords } from "../util";

type DialogueKind = "greeting" | "about" | "thanks" | "clarify" | "conversation" | "weather" | keyof typeof FONS_PROFILE;

const GREETING = /^(?:czesc|hej|hejka|siema|witam|dzien dobry|dobry wieczor|hello|hi)(?: |$)/;
const ABOUT = /^(?:fons|co to(?: jest| za (?:aplikacja|strona|narzedzie|asystent))?|czym jest fons|kim jestes|co (?:tu |to )?robisz|co potrafisz|co mozesz zrobic|do czego sluzysz|jak (?:to|fons) dziala|opowiedz (?:cos )?o sobie)$/;
const NAME = /^(?:od czego (?:jest |pochodzi )?(?:nazwa fons|twoja nazwa)|skad (?:sie wziela |pochodzi )?(?:nazwa fons|twoja nazwa)|(?:co (?:znaczy|oznacza)|dlaczego) (?:nazwa )?fons|dlaczego (?:nazywasz sie fons|tak sie nazywasz)|czy fons to skrot)$/;
const MISSION = /^(?:(?:po co|dlaczego|dla kogo) (?:powstales|powstal fons)|jaki jest (?:twoj cel|cel fonsa)|dla kogo jest fons|co (?:fons ma|masz) wspolnego z msz|na jakie zadanie powstales)$/;
const SOURCES = /^(?:z jakich zrodel korzystasz|skad (?:masz|bierzesz) zrodla|jak (?:dobierasz|wybierasz) zrodla)$/;
const THANKS = /^(?:dzieki|dziekuje|dziekuje bardzo|bardzo dziekuje|wielkie dzieki|do widzenia|na razie|nara|pa)(?: za pomoc)?$/;
const CLARIFY = /^(?:pomozesz(?: mi)?|czy (?:mi pomozesz|mozesz mi pomoc)|mam pytanie|chce cos sprawdzic|sprawdz(?: to)?|czy to prawda|czy tak jest|to prawda|o co chodzi|co|kto|kiedy|gdzie|jak|czyli|tak|nie|ok(?:ej)?|rozumiem)$/;
const CONVERSATION = /^(?:jak sie masz|co slychac|co u ciebie|jak leci|jak tam|jak mija dzien|wszystko dobrze|(?:czy mozesz )?(?:napisac|napisz|ulozyc|uloz|opowiedz|opowiedziec)(?: mi)? (?:dowcip|zart|bajke|opowiadanie|wiersz|list|piosenke))$/;

export function conversationReply(kind: DialogueKind): ConversationReply {
  switch (kind) {
    case "name":
    case "mission":
    case "sources":
      return { kind: "help", textPl: FONS_PROFILE[kind], quickReplies: [] };
    case "greeting":
      return { kind: "help", textPl: "Cześć! Jestem Fons. Co chcesz sprawdzić?", quickReplies: [] };
    case "about":
      return {
        kind: "help",
        textPl: "Jestem Fons. Pomagam sprawdzać informacje u źródła. Możesz wkleić wiadomość albo link, a pokażę Ci, co udało się potwierdzić i gdzie to znalazłem.",
        quickReplies: [],
      };
    case "thanks":
      return { kind: "help", textPl: "Jasne! Jeśli pojawi się kolejne pytanie, śmiało napisz.", quickReplies: [] };
    case "clarify":
      return { kind: "help", textPl: "Co dokładnie mam sprawdzić? Możesz wkleić jedno zdanie z wiadomości, którą masz na myśli.", quickReplies: [] };
    case "weather":
      return { kind: "help", textPl: "Nie mam dostępu do bieżących pomiarów pogody. Jeśli chodzi Ci o konkretną prognozę lub ostrzeżenie, podeślij jego treść, a mogę sprawdzić źródło.", quickReplies: [] };
    case "conversation":
      return { kind: "help", textPl: "Mogę pomóc Ci sprawdzić informację albo znaleźć odpowiedź na pytanie o fakt. Masz coś na myśli?", quickReplies: [] };
  }
}

export function localConversationKind(text: string): DialogueKind | undefined {
  const normalized = foldWords(text);
  const subject = normalized.replace(GREETING, "");
  const question = subject.replace(/^a /, "");
  if (normalized && !subject) return "greeting";
  if (/^(?:jaka (?:jest |bedzie )?pogoda|jaka (?:jest )?teraz pogoda)(?: |$)/.test(subject)) return "weather";
  if (NAME.test(question)) return "name";
  if (MISSION.test(question)) return "mission";
  if (SOURCES.test(question)) return "sources";
  if (ABOUT.test(subject)) return "about";
  if (THANKS.test(subject)) return "thanks";
  if (CLARIFY.test(subject)) return "clarify";
  if (CONVERSATION.test(subject)) return "conversation";
  return undefined;
}

/** During an API outage a short follow-up has no standalone subject for the engine. */
export function canVerifyWithoutDialogue(text: string): boolean {
  const words = foldWords(text);
  if (/^(?:sprawdz|zweryfikuj|czy to prawda ze) .+/.test(words)) return true;
  return words.split(" ").length >= 3
    && /^(?:czy|kto|kiedy|gdzie|ile|ilu|jaki|jaka|jakie|ktory|ktora|ktore|dlaczego|czemu|skad|od kiedy|do kiedy) /.test(words)
    && !/^(?:czy (?:mozesz|moglbys|moglabys|potrafisz)|(?:gdzie|kiedy|jaka) (?:to|tam|ona) )/.test(words);
}
