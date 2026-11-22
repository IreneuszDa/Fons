import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useAnnounce } from "@astryxdesign/core/hooks";
import type { ChatSummary } from "../../shared/chat";
import { ApiError, NETWORK_ERROR_PL, createChat, deleteChat, listChats, openChat, sendChat, type ChatInput } from "../api";
import ChatHistory from "../components/ChatHistory";
import { imagePreviewSrc } from "../lib/attachment";
import { announcementFor } from "../lib/report";
import ChatConversation, { progressLabels, type ChatEntry, type PendingPhase } from "../../app/ai-chat/page";
import ChatLanding from "../../app/ai-chat-landing/page";

interface Thread {
  entries: ChatEntry[];
  pending: PendingPhase | null;
  loadError?: string;
  pendingUserId?: string;
}

const EMPTY: Thread = { entries: [], pending: null };
const DRAFT = "draft";
const SELECTION = "fons.selectedChat";

function savedSelection(): string | null {
  try { return sessionStorage.getItem(SELECTION); } catch { return null; }
}

function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.messagePl : NETWORK_ERROR_PL;
}

export default function ChatPage() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [active, setActive] = useState(DRAFT);
  const [draftVersion, setDraftVersion] = useState(0);
  const draftEditor = useRef<ChatComposerInputHandle>(null);
  const focusNewDraft = useRef(false);
  const selected = useRef(DRAFT);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [creating, setCreating] = useState(false);
  const entrySequence = useRef(0);
  const nextId = () => `local-${++entrySequence.current}`;
  const sending = useRef(new Set<string>());
  const loading = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const listVersion = useRef(0);
  const initialList = useRef<Promise<ChatSummary[]> | null>(null);
  const initialized = useRef(false);
  const announce = useAnnounce();

  const select = useCallback((id: string) => {
    selected.current = id;
    setActive(id);
    try { sessionStorage.setItem(SELECTION, id); } catch { /* Cookies still protect history without tab storage. */ }
  }, []);

  useLayoutEffect(() => {
    if (focusNewDraft.current) {
      focusNewDraft.current = false;
      draftEditor.current?.focus();
    }
  }, [draftVersion]);

  const update = useCallback((id: string, change: (thread: Thread) => Thread) => {
    setThreads(all => removed.current.has(id) ? all : { ...all, [id]: change(all[id] ?? EMPTY) });
  }, []);

  const load = useCallback(async (id: string) => {
    if (loading.current.has(id) || sending.current.has(id)) return;
    loading.current.add(id);
    setThreads(all => {
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
    try {
      const detail = await openChat(id);
      update(id, () => ({ entries: detail.entries, pending: null }));
    } catch (error) {
      update(id, () => ({ ...EMPTY, loadError: messageFor(error) }));
    } finally {
      loading.current.delete(id);
    }
  }, [update]);

  const show = (id: string) => {
    if (id === selected.current && !threads[id]?.loadError) return;
    select(id);
    if (!threads[id]?.entries.some(entry => entry.role === "error")) void load(id);
  };

  const restoreSelection = useCallback((list: ChatSummary[]) => {
    if (initialized.current) return;
    initialized.current = true;
    const saved = savedSelection();
    const id = saved === DRAFT ? undefined : list.find(chat => chat.id === saved)?.id ?? list[0]?.id;
    if (id) { select(id); void load(id); }
  }, [load, select]);

  const refreshList = useCallback(async () => {
    const version = ++listVersion.current;
    try {
      const list = await listChats();
      if (version !== listVersion.current) return;
      setChats(list);
      setHistoryError(null);
      restoreSelection(list);
      const id = selected.current;
      if (id !== DRAFT && !sending.current.has(id) && !list.some(chat => chat.id === id)) select(DRAFT);
    } catch (error) {
      if (version === listVersion.current) setHistoryError(messageFor(error));
    }
  }, [restoreSelection, select]);

  // Only one initial request can establish the browser cookie, including under StrictMode.
  useEffect(() => {
    let live = true;
    if (!initialized.current) {
      const request = initialList.current ??= listChats();
      request.then(list => {
        if (!live) return;
        setChats(list);
        setHistoryError(null);
        restoreSelection(list);
      }).catch(error => {
        if (live) { initialList.current = null; setHistoryError(messageFor(error)); }
      }).finally(() => { if (live) setInitializing(false); });
    }
    const onFocus = () => { if (initialized.current) void refreshList(); };
    window.addEventListener("focus", onFocus);
    return () => { live = false; window.removeEventListener("focus", onFocus); };
  }, [restoreSelection, refreshList]);

  async function remove(id: string) {
    try { await deleteChat(id); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    removed.current.add(id);
    listVersion.current++;
    setChats(list => list.filter(chat => chat.id !== id));
    setThreads(all => {
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
    if (selected.current === id) select(DRAFT);
    announce("Usunięto czat.");
    void refreshList();
  }

  async function run(key: string, input: ChatInput, user: Extract<ChatEntry, { role: "user" }>, retryId?: string) {
    if (sending.current.has(key) || removed.current.has(key)) return;
    sending.current.add(key);
    const startedAt = Date.now();
    const outgoing = { ...user, sentAt: user.sentAt ?? startedAt, attemptAt: startedAt };
    update(key, thread => ({
      entries: retryId
        ? thread.entries.filter(entry => entry.id !== retryId).map(entry => entry.id === user.id ? outgoing : entry)
        : [...thread.entries, outgoing],
      pending: "responding",
      pendingUserId: user.id,
    }));
    let id = key;
    try {
      if (key === DRAFT) {
        setCreating(true);
        const chat = await createChat();
        id = chat.id;
        sending.current.add(id);
        listVersion.current++;
        setChats(list => [chat, ...list.filter(item => item.id !== id)]);
        setThreads(all => ({ ...all, [id]: all[DRAFT] ?? EMPTY, [DRAFT]: EMPTY }));
        select(id);
        sending.current.delete(DRAFT);
        setCreating(false);
      }
      const reply = await sendChat(id, input, stage => {
        const phase = stage ?? (input.image ? "image" : "verifying");
        update(id, thread => ({ ...thread, pending: phase }));
        if (selected.current === id) announce(progressLabels[phase]);
      });
      const entry: ChatEntry = { id: nextId(), role: "assistant", replyTo: user.id, reply };
      if (reply.kind === "deleted") {
        // The server erased the owner's data. Drop local transcripts and attachment previews too.
        for (const other of [...sending.current, ...loading.current]) if (other !== DRAFT) removed.current.add(other);
        setThreads({ [DRAFT]: { entries: [entry], pending: null } });
        select(DRAFT);
      } else {
        update(id, thread => ({ entries: [...thread.entries, entry], pending: null }));
      }
      if (selected.current === id || reply.kind === "deleted") announce(announcementFor(reply));
    } catch (error) {
      const text = messageFor(error);
      const errorId = nextId();
      update(id, thread => ({ entries: [...thread.entries, { id: errorId, role: "error", replyTo: user.id, text,
        retry: () => void run(id, input, outgoing, errorId) }], pending: null }));
      if (selected.current === id) announce(text, "assertive");
    } finally {
      sending.current.delete(id);
      if (id === DRAFT) setCreating(false);
      void refreshList();
    }
  }

  function submit(input: ChatInput, fileName?: string) {
    const user: ChatEntry = { id: nextId(), role: "user", text: input.text ?? "", fileName,
      imageSrc: input.image ? imagePreviewSrc(input.image) : undefined };
    void run(active, { ...input, fileName }, user);
  }

  const thread = threads[active] ?? (active === DRAFT ? EMPTY : undefined);
  return (
    <ChatHistory chats={chats} activeId={active === DRAFT ? null : active} isLoading={initializing}
      error={historyError} isBusy={creating || initializing} onRetry={refreshList}
      onNew={() => {
        focusNewDraft.current = !window.matchMedia("(max-width: 47.99rem), (pointer: coarse)").matches;
        update(DRAFT, () => EMPTY);
        select(DRAFT);
        setDraftVersion(previous => previous + 1);
      }} onOpen={show} onDelete={remove}>
      {initializing || !thread ? (
        <Center height="100%"><Spinner label="Wczytuję rozmowę…" aria-label="Wczytuję rozmowę" /></Center>
      ) : thread.loadError ? (
        <Center height="100%"><VStack gap={3}><Text role="alert">{thread.loadError}</Text>
          <Button label="Spróbuj ponownie" onClick={() => void load(active)} /></VStack></Center>
      ) : thread.entries.length || thread.pending ? (
        <ChatConversation key={thread.entries[0]?.id.startsWith("local-") ? thread.entries[0].id : active} entries={thread.entries} pending={thread.pending} pendingUserId={thread.pendingUserId} onSubmit={submit}
          onAction={(action, label) => void run(active, { action }, { id: nextId(), role: "user", text: label })} />
      ) : <ChatLanding key={`${active}-${draftVersion}`} onSubmit={submit} editorRef={draftEditor} />}
    </ChatHistory>
  );
}
