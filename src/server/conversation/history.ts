import type { ConversationTurn } from "../../engine/llm/conversation";
import type { ConversationReply, InboundMessage } from "../../shared/contracts";
import type { ServerContext } from "../context";
import { canonicalUrl } from "../cache";
import { findSession, saveSessionState } from "../sessions";
import { truncate } from "../util";

const WEB_LINK = /https?:\/\/[^\s<>"„”«»]+/gi;
const MAX_TURNS = 12;

/** Keep sentence punctuation outside the address, including Markdown's closing parenthesis. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(WEB_LINK)].map(([raw]) => {
    const link = raw.replace(/[.,!;:]+$/u, "");
    const extraParens = (link.match(/\)/g)?.length ?? 0) - (link.match(/\(/g)?.length ?? 0);
    return extraParens > 0 ? link.replace(/\)+$/, (end) => end.slice(Math.min(end.length, extraParens))) : link;
  });
}

export function visibleLink(raw: string): string {
  try {
    const url = new URL(canonicalUrl(raw));
    // Report paths contain a bearer token. Query strings and credentials can carry private data.
    if (/\/(?:w|api\/report)\/[\w-]{16,}(?:\/|$)/.test(url.pathname)) return "[link do prywatnego wyniku]";
    return url.origin + url.pathname + (url.search || url.username || url.password ? "?…" : "");
  } catch {
    return "[link]";
  }
}

export function maskedConversationText(ctx: ServerContext, text: string, userSessionId?: string): string {
  let masked = "";
  let end = 0;
  for (const match of text.matchAll(WEB_LINK)) {
    const raw = match[0];
    const link = linksIn(raw)[0]!;
    const visible = ctx.security.maskPii(visibleLink(link)).text;
    const label = userSessionId && visible.endsWith("?…") && !link.includes("?…")
      ? ctx.conversationLinks.remember(userSessionId, visible, link)
      : visible;
    masked += ctx.security.maskPii(text.slice(end, match.index)).text + label + raw.slice(link.length);
    end = match.index + raw.length;
  }
  return masked + ctx.security.maskPii(text.slice(end)).text;
}

/** Resolve only user-supplied links. Restarts and expiry invalidate the opaque private references. */
export function resolveUserLink(ctx: ServerContext, chosen: string, current: string, history: readonly ConversationTurn[], sessionId: string): string | undefined {
  const currentLinks = linksIn(current).filter(link => !link.includes("?…") && (maskedConversationText(ctx, link, sessionId) === chosen || link === chosen));
  if (currentLinks.length) return new Set(currentLinks).size === 1 ? currentLinks[0] : undefined;
  if (!history.some(turn => turn.role === "user" && linksIn(turn.text).includes(chosen))) return undefined;
  if (chosen.includes("?…")) return ctx.conversationLinks.resolve(sessionId, chosen);
  if (chosen.includes("[") || chosen.includes("]")) return undefined;
  return chosen;
}

export function rememberExchange(ctx: ServerContext, msg: InboundMessage, reply: ConversationReply): void {
  if (msg.text.length > ctx.options.maxInputChars || ctx.security.hasInjection?.(msg.text)) return;
  const session = findSession(ctx.db, msg.sessionId);
  if (!session || reply.kind === "deleted") return;

  const user = msg.text.trim() || msg.action || (msg.images.length ? "[obraz]" : msg.document ? "[dokument]" : "");
  // A compact copy of what was actually returned gives follow-ups a subject. Do not replay report tokens.
  const assistant = reply.resultUrl ? reply.textPl.replaceAll(reply.resultUrl, "[wynik]") : reply.textPl;
  const history: ConversationTurn[] = [
    ...(session.state.history ?? []),
    { role: "user", text: maskedConversationText(ctx, user, session.id) },
    { role: "assistant", text: truncate(maskedConversationText(ctx, assistant), 1200) },
  ];
  saveSessionState(ctx, session.id, { ...session.state, history: history.slice(-MAX_TURNS) });
}
