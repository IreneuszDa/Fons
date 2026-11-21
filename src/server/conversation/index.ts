/**
 * Warstwa rozmowy dla każdego kanału. Rozpoznaje polecenia i pytania do asystenta
 * przed przekazaniem materiału do weryfikacji.
 */
import type { ConversationReply, InboundMessage } from "../../shared/contracts";
import type { VerificationStage } from "../../shared/chat";
import type { ServerContext } from "../context";
import { recordUnresolved } from "../moderator/cases";
import { createSession, eraseSender, findSession, inTurnOrder, saveSessionState, type SessionRow } from "../sessions";
import { lastReport, reportReply, respondToMessage } from "./dialogue";
import { rememberExchange } from "./history";
import { ACTION, detectIntent, type PendingType } from "./intents";
import {
  CANCELLED_TEXT,
  CASE_FAILED_TEXT,
  HELP_TEXT,
  NO_REPORT_TEXT,
  QR,
  RATE_LIMITED_TEXT,
  STALE_CONFIRM_TEXT,
  caseNote,
  deletedText,
  mainClaimVerdict,
  TECH_ERROR_TEXT,
} from "./templates";

export { detectIntent } from "./intents";

function ensureSession(msg: InboundMessage, ctx: ServerContext): SessionRow {
  const existing = findSession(ctx.db, msg.sessionId);
  if (existing) {
    if (existing.senderId !== msg.senderId || existing.channel !== msg.channel) throw new Error("session_mismatch");
    return existing;
  }
  return createSession(ctx, { id: msg.sessionId, senderId: msg.senderId, channel: msg.channel });
}

const help = (text: string = HELP_TEXT): ConversationReply => ({ kind: "help", textPl: text, quickReplies: [QR.help] });

export interface InboundOptions {
  /** Klient (IP / sieć /64) wyczerpał swój udział w dobowym budżecie: tylko trafienia w cache (SEC-04). */
  clientOverBudget?: () => boolean;
  onRoutingTokens?: (tokens: number) => void;
  onVerificationStart?: () => void;
  onActivity?: (stage: VerificationStage) => void;
}

export async function handleInbound(msg: InboundMessage, ctx: ServerContext, opts: InboundOptions = {}): Promise<ConversationReply> {
  const mediaRefs = msg.images.map((i) => i.dataRef);
  try {
    if (!ctx.limiters.sender.check(`s:${msg.senderId}`)) {
      return { kind: "rate_limited", textPl: RATE_LIMITED_TEXT, quickReplies: [] };
    }
    const session = ensureSession(msg, ctx);
    // Two browser tabs or a webhook can speak at once. Each turn reads the state left by its predecessor.
    return await inTurnOrder(ctx, session.senderId, async () => {
      const current = findSession(ctx.db, session.id);
      if (!current) return help("Ta rozmowa została usunięta.");
      const reply = await respond(msg, ctx, current, opts);
      rememberExchange(ctx, msg, reply);
      return reply;
    });
  } catch {
    return { kind: "status", textPl: TECH_ERROR_TEXT, quickReplies: [QR.help] };
  } finally {
    for (const ref of mediaRefs) ctx.media.delete(ref);
    if (msg.document) ctx.media.delete(msg.document.dataRef);
  }
}

async function respond(msg: InboundMessage, ctx: ServerContext, session: SessionRow, opts: InboundOptions): Promise<ConversationReply> {
  const nowMs = ctx.now().getTime();
  const pendingActive: PendingType | undefined =
    session.state.pending && session.state.pending.expiresAt > nowMs ? session.state.pending.type : undefined;

  const intent = msg.document ? { type: "verify" as const } : detectIntent({ text: msg.text, action: msg.action, images: msg.images }, pendingActive);

  // Każda wiadomość inna niż potwierdzenie/anulowanie kasuje oczekujące potwierdzenie.
  const clearPending = () => saveSessionState(ctx, session.id, { ...session.state, pending: undefined });
  if (pendingActive && intent.type !== "confirm" && intent.type !== "cancel" && intent.type !== "request") clearPending();

  switch (intent.type) {
    case "help":
    case "sources":
    case "why": {
      const command = () => intent.type === "help" ? help() : reportReply(intent.type, ctx, session);
      if (msg.action || !msg.text.trim() || !ctx.conversationAgent) return command();
      return respondToMessage(msg, ctx, session, opts, command);
    }

    case "request": {
      if (intent.what === "report") {
        const report = lastReport(ctx, session);
        if (!report || report.status !== "OK" || !mainClaimVerdict(report)) return help(NO_REPORT_TEXT);
      }
      saveSessionState(ctx, session.id, {
        ...session.state,
        pending: { type: intent.what, expiresAt: nowMs + ctx.options.confirmTtlMs },
      });
      return intent.what === "delete"
        ? {
            kind: "confirm_delete",
            textPl:
              "Czy na pewno usunąć wszystkie Twoje dane (raporty, historię zapytań, tę rozmowę)? Tej operacji nie można cofnąć. Napisz „tak” albo użyj przycisku.",
            quickReplies: [
              { id: ACTION.deleteConfirm, labelPl: "Tak, usuń" },
              { id: ACTION.deleteCancel, labelPl: "Nie, zostaw" },
            ],
          }
        : {
            kind: "confirm_report",
            textPl:
              "Czy zgłosić ten wynik do sprawdzenia przez moderatora? Przekażę tylko zamaskowaną treść twierdzenia, bez Twoich danych. Napisz „tak” albo użyj przycisku.",
            quickReplies: [
              { id: ACTION.reportConfirm, labelPl: "Tak, zgłoś" },
              { id: ACTION.reportCancel, labelPl: "Nie" },
            ],
          };
    }

    case "confirm": {
      if (intent.what === "delete") {
        const res = eraseSender(ctx, session.senderId);
        return { kind: "deleted", textPl: deletedText(res), quickReplies: [QR.help] };
      }
      const report = lastReport(ctx, session);
      const claim = report && mainClaimVerdict(report) ? (report.claims.find((c) => c.isMain) ?? report.claims[0])?.text : undefined;
      clearPending();
      if (!report || !claim) return help(NO_REPORT_TEXT);
      try {
        const outcome = await recordUnresolved(ctx, { text: claim, senderId: session.senderId, channel: msg.channel });
        return { kind: "reported", textPl: caseNote(outcome), quickReplies: [QR.delete] };
      } catch {
        return { kind: "reported", textPl: CASE_FAILED_TEXT, quickReplies: [QR.report] };
      }
    }

    case "cancel":
      clearPending();
      return help(CANCELLED_TEXT);

    case "stale_confirm":
      return help(STALE_CONFIRM_TEXT);

    case "verify":
      return respondToMessage(msg, ctx, session, opts);
  }
}
