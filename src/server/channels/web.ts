/** Adapter kanału WWW. Wiadomości przychodzą przez POST /api/chat (nie przez webhook), odpowiedź niesie odpowiedź HTTP. */
import type { ChatDocument, ImageOptions } from "../../shared/attachments";
import { randomBytes } from "node:crypto";
import type { ChannelAdapter, ConversationReply, InboundMessage } from "../../shared/contracts";
import type { ServerContext } from "../context";
import { renderReplyText } from "./render";

export const webAdapter: ChannelAdapter = {
  id: "web",
  capabilities: { maxChars: 4000, supportsImagesIn: true, supportsButtons: true, supportsMarkdown: false },
  // Kanał WWW nie ma webhooka: każde takie żądanie jest nieprawidłowe.
  verifySignature: () => false,
  parseInbound: () => null,
  render(reply: ConversationReply): string {
    return renderReplyText(reply, { buttons: true });
  },
  async send(): Promise<void> {
    /* odpowiedź wraca w odpowiedzi HTTP */
  },
};

export interface WebInboundParts {
  sessionId: string;
  senderId: string;
  text?: string;
  action?: string;
  image?: { mime: string; base64: string };
  document?: ChatDocument;
  imageOptions?: ImageOptions;
}

/** Buduje InboundMessage dla kanału WWW; obraz trafia do tymczasowego magazynu mediów (usuwany po przetworzeniu). */
export function buildWebInbound(ctx: ServerContext, p: WebInboundParts): InboundMessage {
  const images: InboundMessage["images"] = [];
  if (p.image) {
    const dataRef = `media_${randomBytes(8).toString("hex")}`;
    ctx.media.set(dataRef, { mime: p.image.mime, base64: p.image.base64 });
    images.push({ mime: p.image.mime, dataRef });
  }
  const document = p.document ? { dataRef: `media_${randomBytes(8).toString("hex")}` } : undefined;
  if (document && p.document) ctx.media.set(document.dataRef, p.document);
  return {
    channel: "web",
    ...(document ? { document } : {}),
    ...(p.image && p.imageOptions ? { imageOptions: p.imageOptions } : {}),
    senderId: p.senderId,
    sessionId: p.sessionId,
    messageId: `web_${randomBytes(8).toString("hex")}`,
    receivedAt: ctx.now().toISOString(),
    text: p.text ?? "",
    ...(p.action ? { action: p.action } : {}),
    images,
  };
}
