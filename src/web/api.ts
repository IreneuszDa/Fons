/**
 * Typed client for the Fons API (docs/MODULES.md, section src/server/ → API).
 */
import type { ChatImage, ChatDocument, ChatRecording, ImageOptions } from "../shared/attachments";
import type { CatalogSource, ConversationReply, VerdictReport } from "../shared/contracts";
import type { ArchiveMaterial, SavedMaterial } from "../shared/archive";
import type { NewsArticle } from "../shared/news";
import { CHAT_STREAM_CONTENT_TYPE, VERIFICATION_STAGES, type ChatDetail, type ChatResponse, type ChatStreamEvent, type ChatSummary, type ReaderExcerpt, type VerificationStage } from "../shared/chat";

export interface ChatInput {
  text?: string;
  action?: string;
  readerExcerpt?: ReaderExcerpt;
  image?: ChatImage;
  comparisonImage?: ChatImage;
  document?: ChatDocument;
  recording?: ChatRecording;
  imageOptions?: ImageOptions;
  fileName?: string;
}

export interface SourcesResponse {
  catalog: CatalogSource[];
  counts: Record<string, number>;
  snapshotId: string;
}

/** Error with a Polish, user-safe message (never the raw server/provider error). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly messagePl: string,
  ) {
    super(messagePl);
    this.name = "ApiError";
  }
}

export const NETWORK_ERROR_PL = "Nie mogę połączyć się z serwerem. To problem techniczny, a nie ocena informacji. Sprawdź internet i spróbuj ponownie.";

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "messagePl" in body && typeof (body as { messagePl: unknown }).messagePl === "string") {
    return (body as { messagePl: string }).messagePl;
  }
  return fallback;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, NETWORK_ERROR_PL);
  }
}

async function chatResource<T>(path: string, message: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  const body = await readJson(res);
  if (!res.ok || !body) throw new ApiError(res.status, messageFrom(body, message));
  return body as T;
}

export async function transcribeDictation(recording: ChatRecording, signal: AbortSignal): Promise<string> {
  const result = await chatResource<{ text: string }>("/api/dictation", "Nie udało się przepisać nagrania.", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recording }), signal,
  });
  return result.text;
}

export async function listChats(): Promise<ChatSummary[]> {
  const { chats } = await chatResource<{ chats: ChatSummary[] }>("/api/chats", "Nie udało się wczytać historii czatów.");
  return chats;
}

export async function listNews(signal: AbortSignal): Promise<NewsArticle[]> {
  const { articles } = await chatResource<{ articles: NewsArticle[] }>(
    "/api/news", "Nie udało się wczytać wiadomości.", { signal },
  );
  return articles;
}

export const readArchives = () => chatResource<{ items: SavedMaterial[] }>("/api/archives", "Nie udało się otworzyć archiwum.");
export const previewArchive = (url: string) => chatResource<{ items: ArchiveMaterial[] }>("/api/archives/preview", "Nie udało się odczytać materiału.", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
});
export const saveArchive = ({ url, recordId, sha256 }: ArchiveMaterial) => chatResource<{ item: SavedMaterial }>("/api/archives", "Nie udało się zapisać materiału.", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, recordId, sha256 }),
});
export const removeArchive = (id: string) => chatResource("/api/archives/" + encodeURIComponent(id), "Nie udało się usunąć materiału.", { method: "DELETE" });

export async function createChat(): Promise<ChatSummary> {
  const { chat } = await chatResource<{ chat: ChatSummary }>("/api/chats", "Nie udało się rozpocząć czatu.", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  return chat;
}

export function openChat(id: string): Promise<ChatDetail> {
  return chatResource(`/api/chats/${encodeURIComponent(id)}`, "Nie udało się otworzyć czatu.");
}

export async function deleteChat(id: string): Promise<void> {
  await chatResource(`/api/chats/${encodeURIComponent(id)}`, "Nie udało się usunąć czatu.", { method: "DELETE" });
}

type ProgressHandler = (stage?: VerificationStage) => void;

async function readChatStream(res: Response, onProgress: ProgressHandler): Promise<ChatResponse | null> {
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) return null;
  try {
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      const lines = (pending + value).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line) as ChatStreamEvent;
        if (event.type === "verification-start") onProgress();
        if (event.type === "verification-stage" && VERIFICATION_STAGES.includes(event.stage)) onProgress(event.stage);
        if (event.type === "reply") return event;
      }
    }
  } catch {
    throw new ApiError(0, NETWORK_ERROR_PL);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function sendChat(sessionId: string, input: ChatInput, onProgress: ProgressHandler): Promise<ConversationReply> {
  const res = await request(input.recording ? "/api/chat/recording" : "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: `${CHAT_STREAM_CONTENT_TYPE}, application/json` },
    body: JSON.stringify({ ...input, sessionId }),
  });
  const isStream = res.headers.get("content-type")?.split(";")[0] === CHAT_STREAM_CONTENT_TYPE;
  const body = isStream ? await readChatStream(res, onProgress) : await readJson(res);
  // 429 also carries a reply of kind "rate_limited".
  if (body && typeof body === "object" && "reply" in body) {
    const data = body as ChatResponse;
    return data.reply;
  }
  throw new ApiError(res.status, messageFrom(body, "Nie udało się wysłać wiadomości. Spróbuj ponownie."));
}

/** null = no such report (404). */
export async function fetchReport(token: string): Promise<VerdictReport | null> {
  const res = await request(`/api/report/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  const body = await readJson(res);
  if (!res.ok || !body) throw new ApiError(res.status, messageFrom(body, "Nie udało się wczytać wyniku. Spróbuj ponownie."));
  return body as VerdictReport;
}

export async function fetchSources(): Promise<SourcesResponse> {
  const res = await request("/api/sources");
  const body = await readJson(res);
  if (!res.ok || !body) throw new ApiError(res.status, messageFrom(body, "Nie udało się wczytać listy źródeł."));
  return body as SourcesResponse;
}

// The admin client lives in src/web/admin/adminApi.ts (lazy chunk, never downloaded by citizens).
