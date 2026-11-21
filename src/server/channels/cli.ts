/** Adapter kanału CLI (`npm run ask`): ten sam kontrakt co kanały wiadomości, wyjście na stdout. */
import { randomBytes } from "node:crypto";
import type { ChannelAdapter, ConversationReply, InboundMessage } from "../../shared/contracts";
import type { ServerContext } from "../context";
import { renderReplyText } from "./render";

export const CLI_SESSION_ID = "cli-local";

export const cliAdapter: ChannelAdapter = {
  id: "cli",
  capabilities: { maxChars: 100_000, supportsImagesIn: false, supportsButtons: false, supportsMarkdown: false },
  verifySignature: () => false,
  parseInbound: () => null,
  render(reply: ConversationReply): string {
    return renderReplyText(reply, { buttons: false });
  },
  async send(out): Promise<void> {
    process.stdout.write(`${cliAdapter.render(out.reply)}\n`);
  },
};

export function buildCliInbound(ctx: ServerContext, p: { senderId: string; text: string; action?: string }): InboundMessage {
  return {
    channel: "cli",
    senderId: p.senderId,
    sessionId: CLI_SESSION_ID,
    messageId: `cli_${randomBytes(8).toString("hex")}`,
    receivedAt: ctx.now().toISOString(),
    text: p.text,
    ...(p.action ? { action: p.action } : {}),
    images: [],
  };
}
