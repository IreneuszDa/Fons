/**
 * Typed client for the Fons API (docs/MODULES.md, section src/server/ → API).
 */
import type { ChatImage, ChatDocument, ImageOptions } from "../shared/attachments";
import type { CatalogSource, ConversationReply, VerdictReport } from "../shared/contracts";
import { CHAT_STREAM_CONTENT_TYPE, VERIFICATION_STAGES, type ChatResponse, type ChatStreamEvent, type VerificationStage } from "../shared/chat";

export interface ChatInput {
  text?: string;
  action?: string;
  image?: ChatImage;
  document?: ChatDocument;
  imageOptions?: ImageOptions;
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

let sessionId: string | undefined;

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

export async function sendChat(input: ChatInput, onProgress: ProgressHandler): Promise<ConversationReply> {
  const res = await request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: `${CHAT_STREAM_CONTENT_TYPE}, application/json` },
    body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), ...input }),
  });
  const isStream = res.headers.get("content-type")?.split(";")[0] === CHAT_STREAM_CONTENT_TYPE;
  const body = isStream ? await readChatStream(res, onProgress) : await readJson(res);
  // 429 also carries a reply of kind "rate_limited".
  if (body && typeof body === "object" && "reply" in body) {
    const data = body as ChatResponse;
    sessionId = data.sessionId || undefined;
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
