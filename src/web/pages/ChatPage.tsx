import { useCallback, useRef, useState } from "react";
import { useAnnounce } from "@astryxdesign/core/hooks";
import { ApiError, NETWORK_ERROR_PL, sendChat, type ChatInput } from "../api";
import { announcementFor } from "../lib/report";
import ChatConversation, { progressLabels, type ChatEntry, type PendingPhase } from "./ChatConversation";
import ChatLanding from "./ChatLanding";

/** "/" — zero state (ai-chat-landing) until the first message, then the conversation (ai-chat). */
export default function ChatPage() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [pending, setPending] = useState<PendingPhase | null>(null);
  const seq = useRef(0);
  const nextId = () => `m${++seq.current}`;
  const busy = useRef(false);
  // One polite live region for outcomes (verdict, answer, technical status); errors are assertive.
  const announce = useAnnounce();

  const run = useCallback(
    async (input: ChatInput) => {
      if (busy.current) return;
      busy.current = true;
      setPending("responding");
      try {
        const reply = await sendChat(input, (stage) => {
          const phase = stage ?? (input.image ? "image" : "verifying");
          setPending(phase);
          announce(progressLabels[phase]);
        });
        const entry: ChatEntry = { id: nextId(), role: "assistant", reply };
        setEntries((prev) => reply.kind === "deleted" ? [entry] : [...prev, entry]);
        announce(announcementFor(reply));
      } catch (err) {
        const text = err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL;
        const id = nextId();
        // Retry replaces the error message with a fresh attempt (same input, no duplicate user bubble).
        const retry = () => {
          setEntries((prev) => prev.filter((e) => e.id !== id));
          void run(input);
        };
        setEntries((prev) => [...prev, { id, role: "error", text, retry }]);
        announce(`Nie udało się wysłać wiadomości. ${text}`, "assertive");
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [announce],
  );

  const submit = useCallback(
    (input: ChatInput, fileName?: string) => {
      if (busy.current) return;
      setEntries((prev) => [...prev, { id: nextId(), role: "user", text: input.text ?? "", fileName }]);
      void run(input);
    },
    [run],
  );

  const action = useCallback(
    (id: string, label: string) => {
      if (busy.current) return;
      setEntries((prev) => [...prev, { id: nextId(), role: "user", text: label }]);
      void run({ action: id });
    },
    [run],
  );

  if (entries.length === 0 && !pending) return <ChatLanding onSubmit={submit} />;
  return <ChatConversation entries={entries} pending={pending} onSubmit={submit} onAction={action} />;
}
