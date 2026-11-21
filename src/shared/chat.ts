import type { ConversationReply } from "./contracts";

export const CHAT_STREAM_CONTENT_TYPE = "application/x-ndjson";
export const VERIFICATION_STAGES = ["searching", "assessing", "checking_quotes"] as const;
export type VerificationStage = (typeof VERIFICATION_STAGES)[number];

export interface ChatResponse {
  sessionId: string;
  reply: ConversationReply;
}

export type ChatStreamEvent =
  | { type: "verification-start" }
  | { type: "verification-stage"; stage: VerificationStage }
  | ({ type: "reply" } & ChatResponse);
