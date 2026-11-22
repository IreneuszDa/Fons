import type { ConversationReply } from "../../../src/shared/contracts";
import answer from "./reply-answer.json";
import answerNone from "./reply-answer-none.json";
import brak from "./reply-brak-dowodow-conflict.json";
import falszywe from "./reply-falszywe-injection.json";
import niePodlega from "./reply-nie-podlega.json";
import potwierdzone from "./reply-potwierdzone.json";
import niepelne from "./reply-status-niepelne.json";
import wprowadzajace from "./reply-wprowadzajace.json";

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
