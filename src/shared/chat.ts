import type { ConversationReply } from "./contracts";
import type { NewsArticle } from "./news";

export interface ReaderExcerpt {
  articleId: string;
  quote: string;
  start: number;
  end: number;
}

export const MAX_READER_QUOTE_CHARS = 3000;

export function readerPassages(article: NewsArticle): string[] {
  return [article.title, ...article.paragraphs];
}

export function normalizeReaderQuote(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function readerExcerptMessage(title: string, quote: string): string {
  return `Wyjaśnij fragment publikacji „${title}”.\n\n„${quote}”`;
}

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
