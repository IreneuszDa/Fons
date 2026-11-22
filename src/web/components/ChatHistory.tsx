import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, LayoutHeader, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { Bars3BottomLeftIcon, EllipsisHorizontalIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { ChatSummary } from "../../shared/chat";

interface ChatHistoryProps {
  chats: readonly ChatSummary[];
  activeId?: string | null;
  isLoading?: boolean;
  error?: string | null;
  isBusy?: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRetry?: () => void;
  children: ReactNode;
}

// Keyboard focus exposes the same action as hovering. Touch always has a visible target.
const chatStyles = `
  .fons-chat-header {
    position: relative;
    width: 100%;
  }
  .fons-chat-header .fons-signature {
    position: absolute;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    font: 500 1.55rem/1.15 "Iowan Old Style", Georgia, serif;
    letter-spacing: -.045em;
  }
  .fons-chat-body {
    position: relative;
    isolation: isolate;
    overflow: clip;
  }
  .fons-chat-body .fons-history-panel {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: 1;
    transform: translateX(-100%);
    background: color-mix(in srgb, var(--color-background-surface) 96%, var(--color-text-primary));
  }
  .fons-chat-body .fons-history-panel[aria-hidden="false"] { transform: translateX(0); }
  @media (prefers-reduced-motion: no-preference) {
    .fons-chat-body .fons-history-panel { transition: transform 180ms ease-out; }
  }
  @media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
    .fons-history .astryx-side-nav-item:not(:hover):not(:focus-within):not([data-selected]) [data-history-delete] {
      opacity: 0;
      pointer-events: none;
    }
  }
`;

type HistoryListProps = Omit<ChatHistoryProps, "children" | "onDelete"> & {
  onRequestDelete: (chat: ChatSummary) => void;
};

export function HistoryList({
  chats, activeId, isLoading, error, isBusy, onNew, onOpen, onRequestDelete, onRetry,
}: HistoryListProps) {
  return (
    <SideNav
      className="fons-history" aria-label="Historia czatów" style={{ width: "100%", height: "100%" }}
      topContent={
        <SideNavItem label="Nowy czat" icon={PencilSquareIcon} size="lg" isDisabled={isBusy}
          onClick={onNew} />
      }>
      <SideNavSection title="Historia czatów">
        {error && (
          <VStack padding={2} gap={2} hAlign="start">
            <Text as="p" role="alert" type="supporting">{error}</Text>
            {onRetry && <Button label="Spróbuj ponownie" variant="ghost" size="sm" onClick={onRetry} />}
          </VStack>
        )}
        {chats.map(chat => (
          <SideNavItem key={chat.id} label={chat.title}
            isSelected={chat.id === activeId} isDisabled={isBusy}
            onClick={() => onOpen(chat.id)}
            actions={
              <IconButton data-history-delete label={`Usuń czat „${chat.title}”`} tooltip="Usuń czat"
                size="sm" variant="ghost" icon={<Icon icon={TrashIcon} size="sm" color="secondary" />}
                isDisabled={isBusy} onClick={() => onRequestDelete(chat)} />
            }
          />
        ))}
        {!chats.length && !error && (
          <VStack padding={2}>
            <Text as="p" type="supporting" color="secondary" role="status">
              {isLoading ? "Wczytuję historię…" : "Brak zapisanych rozmów."}
            </Text>
          </VStack>
        )}
      </SideNavSection>
    </SideNav>
  );
}

export default function ChatHistory({
  chats, activeId, isLoading, error, isBusy, onNew, onOpen, onDelete, onRetry, children,
}: ChatHistoryProps) {
  const isMobile = useMediaQuery("(max-width: 47.99rem)");
  const historyId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      setDeleteError("Nie udało się usunąć tej rozmowy. Spróbuj ponownie.");
    } finally {
      setDeleting(false);
    }
  }

  const history = (
    <HistoryList chats={chats} activeId={activeId} isLoading={isLoading} error={error} isBusy={isBusy}
      onRetry={onRetry}
      onNew={() => { if (isMobile) setHistoryOpen(false); onNew(); }}
      onOpen={id => { if (isMobile) setHistoryOpen(false); onOpen(id); }}
      onRequestDelete={chat => {
        if (isMobile) setHistoryOpen(false);
        setDeleteError("");
        setDeleteTarget(chat);
      }}
    />
  );

  const header = (
    <LayoutHeader padding={3} hasDivider={false}>
      <HStack className="fons-chat-header" hAlign="between" vAlign="center">
        <IconButton ref={toggle} label="Historia czatów" tooltip={historyOpen ? "Zwiń historię" : "Rozwiń historię"}
          variant="ghost" aria-expanded={historyOpen} aria-controls={!isMobile || historyOpen ? historyId : undefined}
          aria-haspopup={isMobile ? "dialog" : undefined}
          onClick={() => setHistoryOpen(open => !open)} icon={<Icon icon={Bars3BottomLeftIcon} />} />
        <Text as="p" className="fons-signature">Fons</Text>
        <DropdownMenu
          alignment="end" presentation="popover"
          renderTrigger={trigger => (
            <IconButton {...trigger} label="Menu czatu" variant="ghost"
              icon={<Icon icon={EllipsisHorizontalIcon} size="lg" />} />
          )}
          items={[{ label: "Źródła i metoda", href: "/zrodla" }]}
        />
      </HStack>
    </LayoutHeader>
  );

  return (
    <>
      <style>{chatStyles}</style>
      <Layout height="fill" padding={0} header={header}
        content={
          <LayoutContent className="fons-chat-body" padding={0} isScrollable={false}>
            {!isMobile && (
              <LayoutPanel id={historyId} className="fons-history-panel" width="16rem"
                inert={!historyOpen} aria-hidden={!historyOpen} padding={0} isScrollable={false}
                onKeyDown={event => {
                  if (event.key === "Escape" && !event.defaultPrevented) {
                    toggle.current?.focus();
                    setHistoryOpen(false);
                  }
                }}>
                <VStack height="100%" paddingBlock={2}>{history}</VStack>
              </LayoutPanel>
            )}
            {children}
          </LayoutContent>
        }
      />
      {isMobile && (
        <Drawer label="Historia czatów" side="start" width="18rem" padding={0}
          isOpen={historyOpen} onOpenChange={setHistoryOpen}>
          <VStack id={historyId} height="100%" gap={0}>
            <VStack padding={3}><DrawerHeader title="Fons" onOpenChange={setHistoryOpen} /></VStack>
            {history}
          </VStack>
        </Drawer>
      )}
      {deleteTarget && (
        <Dialog isOpen onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null); }} padding={5}>
          <VStack gap={4}>
            <DialogHeader title="Usunąć czat?" hasDivider={false} />
            <Text as="p" wordBreak="break-word">Rozmowa „{deleteTarget.title}” zostanie trwale usunięta.</Text>
            {deleteError && <Text as="p" role="alert">{deleteError}</Text>}
            <HStack gap={2} hAlign="end" wrap="wrap">
              <Button label="Anuluj" variant="secondary" isDisabled={deleting} onClick={() => setDeleteTarget(null)} />
              <Button label="Usuń czat" variant="destructive" isLoading={deleting} onClick={() => void confirmDelete()} />
            </HStack>
          </VStack>
        </Dialog>
      )}
    </>
  );
}
