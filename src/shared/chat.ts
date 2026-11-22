import type { ConversationReply } from "./contracts";

export const CHAT_STREAM_CONTENT_TYPE = "application/x-ndjson";
export const VERIFICATION_STAGES = ["fetching_video", "analyzing_video", "transcribing_audio", "searching", "assessing", "checking_quotes"] as const;
export type VerificationStage = (typeof VERIFICATION_STAGES)[number];

export interface ChatResponse {
  sessionId: string;
  reply: ConversationReply;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type StoredChatEntry =
  | { id: string; role: "user"; text: string; fileName?: string }
  | { id: string; role: "assistant"; reply: ConversationReply };

export interface ChatDetail {
  chat: ChatSummary;
  entries: StoredChatEntry[];
}

export type ChatStreamEvent =
  | { type: "verification-start" }
  | { type: "verification-stage"; stage: VerificationStage }
  | ({ type: "reply" } & ChatResponse);
