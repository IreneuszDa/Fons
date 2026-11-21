// Phone simulator for the demo SMS channel: the same conversation layer as the web chat, reached through the
// signed SMS webhook (server-side signer at POST /api/sim/sms). Replies are the exact SMS texts (≤ 320 chars).
import { useRef, useState } from "react";

import { Avatar } from "@astryxdesign/core/Avatar";
import { Card } from "@astryxdesign/core/Card";
import { ChatComposer, ChatComposerInput, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { useAnnounce } from "@astryxdesign/core/hooks";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ApiError, NETWORK_ERROR_PL, sendSimSms } from "../api";
import { resultPathFor } from "../lib/safeUrl";

type SmsEntry = { id: string; from: "me" | "fons" | "error"; text: string };

const SENDER = "Fons SMS";
const RESULT_URL_RE = /https?:\/\/\S+\/w\/[A-Za-z0-9_-]{8,128}/;

/** Splits an SMS into text + the result link (rendered as an in-app link; exported for tests). */
export function splitSmsLink(text: string): { before: string; path: string | null; after: string } {
  const m = RESULT_URL_RE.exec(text);
  const path = m ? resultPathFor(undefined, m[0]) : null;
  if (!m || !path) return { before: text, path: null, after: "" };
  return { before: text.slice(0, m.index), path, after: text.slice(m.index + m[0].length) };
}

function SmsText({ text }: { text: string }) {
  const { before, path, after } = splitSmsLink(text);
  return (
    <Text style={{ whiteSpace: "pre-wrap" }}>
      {before}
      {path ? <Link href={path}>{path}</Link> : null}
      {after}
    </Text>
  );
}

export default function PhonePage() {
  const [entries, setEntries] = useState<SmsEntry[]>([]);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const announce = useAnnounce();
  const nextId = () => `sms-${++seq.current}`;

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || pending) return;
    setEntries((e) => [...e, { id: nextId(), from: "me", text }]);
    setPending(true);
    try {
      const messages = await sendSimSms(text);
      setEntries((e) => [...e, ...messages.map((m) => ({ id: nextId(), from: "fons" as const, text: m }))]);
      if (messages[0]) announce(`Nowy SMS: ${messages[0]}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.messagePl : NETWORK_ERROR_PL;
      setEntries((e) => [...e, { id: nextId(), from: "error", text: msg }]);
      announce(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <Center axis="horizontal" width="100%" height="100%" padding={4}>
      <VStack gap={3} width="100%" maxWidth={420} height="100%">
        <VStack gap={1}>
          <Heading level={1}>Symulator SMS</Heading>
          <Text color="secondary">
            Kanał demonstracyjny: wiadomość idzie podpisanym webhookiem jak z bramki SMS, a odpowiedź to SMS, który dostałby telefon
            (do 320 znaków). Bez operatora i opłat.
          </Text>
        </VStack>
        <Card padding={0} variant="muted" height="min(640px, calc(100dvh - 300px))" minHeight={360}>
          <ChatLayout
            density="compact"
            composer={
              <ChatComposer
                onSubmit={(t) => void submit(t)}
                isDisabled={pending}
                placeholder="Napisz SMS…"
                input={<ChatComposerInput label="Treść SMS-a" placeholder="Napisz SMS…" hasHistory={false} />}
              />
            }>
            <ChatMessageList isStreaming={pending}>
              <ChatSystemMessage variant="divider">Rozmowa SMS z numerem Fons</ChatSystemMessage>
              {entries.map((e) =>
                e.from === "me" ? (
                  <ChatMessage key={e.id} sender="user">
                    <ChatMessageBubble>
                      <Text>{e.text}</Text>
                    </ChatMessageBubble>
                  </ChatMessage>
                ) : (
                  <ChatMessage key={e.id} sender="assistant" avatar={<Avatar name={SENDER} size="sm" />}>
                    <ChatMessageBubble variant={e.from === "error" ? "ghost" : undefined}>
                      {e.from === "error" ? <Text color="secondary">{e.text}</Text> : <SmsText text={e.text} />}
                    </ChatMessageBubble>
                  </ChatMessage>
                ),
              )}
              {pending ? (
                <ChatMessage sender="assistant" avatar={<Avatar name={SENDER} size="sm" />}>
                  <ChatMessageBubble variant="ghost">
                    <Spinner size="sm" label="Czekam na odpowiedź…" aria-label="Czekam na odpowiedź" />
                  </ChatMessageBubble>
                </ChatMessage>
              ) : null}
            </ChatMessageList>
          </ChatLayout>
        </Card>
      </VStack>
    </Center>
  );
}
