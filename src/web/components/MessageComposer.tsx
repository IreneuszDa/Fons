import { useId, useRef, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { ChatComposerDrawer, ChatComposerInput, ChatSendButton, type ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { DocumentTextIcon, PaperClipIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { MAX_CHAT_TEXT_CHARS } from "../../shared/attachments";
import type { ChatInput } from "../api";
import { FILE_ACCEPT, FILE_HINT, prepareAttachment, type DraftAttachment } from "../lib/attachment";

export type SubmitMessage = (input: ChatInput, fileName?: string) => void;

export function MessageComposer({ onSubmit, isDisabled = false }: { onSubmit: SubmitMessage; isDisabled?: boolean }) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<DraftAttachment | null>(null);
  const [reading, setReading] = useState(false);
  const [searchWeb, setSearchWeb] = useState(false);
  const [fileError, setFileError] = useState("");
  const [editorFocused, setEditorFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useRef<ChatComposerInputHandle>(null);
  const selection = useRef(0);
  const errorId = useId();
  const textError = text.trim().length > MAX_CHAT_TEXT_CHARS ? `Skróć wiadomość do ${MAX_CHAT_TEXT_CHARS} znaków.` : "";
  const canSend = !isDisabled && !reading && !textError && (!!text.trim() || !!attachment);

  async function selectFiles(files: File[]) {
    if (isDisabled || !files.length) return;
    const version = ++selection.current;
    setFileError("");
    if (files.length > 1) {
      setReading(false);
      setFileError("Do jednej wiadomości możesz dołączyć jeden plik.");
      return;
    }
    setReading(true);
    try {
      const next = await prepareAttachment(files[0]!);
      if (version !== selection.current) return;
      setAttachment(next);
      setSearchWeb(false);
    } catch (err) {
      if (version === selection.current) setFileError(err instanceof Error ? err.message : "Nie udało się odczytać pliku.");
    } finally {
      if (version === selection.current) setReading(false);
    }
  }

  function removeAttachment() {
    selection.current++;
    setReading(false);
    setAttachment(null);
    setFileError("");
    setSearchWeb(false);
    editor.current?.focus();
  }

  function submit() {
    if (!canSend) return;
    const caption = text.trim();
    const input: ChatInput = caption ? { text: caption } : {};
    if (attachment?.kind === "image") {
      input.image = attachment.content;
      input.imageOptions = { searchWeb };
    } else if (attachment?.kind === "document") {
      input.document = attachment.content;
    }
    onSubmit(input, attachment?.name);
    setText("");
    setAttachment(null);
    setSearchWeb(false);
    setFileError("");
  }

  return (
    <VStack gap={0} width="100%">
      {attachment && (
        <ChatComposerDrawer label="Załącznik">
          <VStack gap={2} width="100%">
            <HStack gap={2} vAlign="center">
              {attachment.kind === "image"
                ? <Thumbnail src={`data:${attachment.content.mime};base64,${attachment.content.base64}`} alt="" />
                : <Icon icon={DocumentTextIcon} size="md" color="secondary" />}
              <StackItem size="fill">
                <Text size="sm" maxLines={1}>{attachment.name}</Text>
              </StackItem>
              <IconButton
                label="Usuń załącznik"
                icon={<Icon icon={XMarkIcon} />}
                variant="ghost"
                size="sm"
                isDisabled={isDisabled}
                onClick={removeAttachment}
              />
            </HStack>
            {attachment.kind === "image" && (
              <CheckboxInput
                label="Szukaj tego obrazu w Google"
                description="Po zaznaczeniu obraz zostanie wysłany do Google w celu znalezienia kopii."
                value={searchWeb}
                onChange={setSearchWeb}
                isDisabled={isDisabled}
              />
            )}
          </VStack>
        </ChatComposerDrawer>
      )}
      <Card
        padding={2}
        elevation="low"
        width="100%"
        style={{
          position: "relative",
          zIndex: 2,
          borderRadius: "var(--radius-chat)",
          outline: editorFocused ? "var(--border-width) solid var(--color-accent)" : undefined,
        }}
      >
        <HStack gap={1} vAlign="center">
          <input
            ref={picker}
            type="file"
            hidden
            accept={FILE_ACCEPT}
            onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void selectFiles(files);
            }}
          />
          <IconButton
            label="Dodaj plik"
            tooltip={FILE_HINT}
            variant="ghost"
            icon={<Icon icon={PaperClipIcon} />}
            isDisabled={isDisabled}
            isLoading={reading}
            onClick={() => picker.current?.click()}
          />
          <StackItem size="fill">
            <ChatComposerInput
              value={text}
              onChange={setText}
              label="Wiadomość do Fonsa"
              placeholder="Napisz wiadomość lub wklej link…"
              hasHistory={false}
              isDisabled={isDisabled}
              handleRef={editor}
              onFiles={selectFiles}
              onFocus={() => setEditorFocused(true)}
              onBlur={() => setEditorFocused(false)}
              aria-describedby={fileError || textError ? errorId : undefined}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </StackItem>
          <ChatSendButton isDisabled={!canSend} onSend={submit} />
        </HStack>
      </Card>
      {(fileError || textError) && <Text as="p" type="supporting" role="alert" id={errorId}>{fileError || textError}</Text>}
    </VStack>
  );
}
