import { useId, useRef, useState, type RefObject } from "react";
import { ChatComposer, ChatComposerDrawer, ChatComposerInput, ChatSendButton, type ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { DocumentTextIcon, MicrophoneIcon, PlusIcon, StopIcon, VideoCameraIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { MAX_CHAT_TEXT_CHARS } from "../../shared/attachments";
import type { ChatInput } from "../api";
import { AUDIO_ACCEPT, DOCUMENT_ACCEPT, FILE_ACCEPT, VIDEO_ACCEPT, imagePreviewSrc, prepareAttachment, type DraftAttachment } from "../lib/attachment";
import { useVoiceNote } from "../lib/useVoiceNote";

export type SubmitMessage = (input: ChatInput, fileName?: string) => void;

interface MessageComposerProps {
  onSubmit: SubmitMessage;
  isDisabled?: boolean;
  editorRef?: RefObject<ChatComposerInputHandle | null>;
}

export function MessageComposer({ onSubmit, isDisabled = false, editorRef }: MessageComposerProps) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<DraftAttachment | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const localEditor = useRef<ChatComposerInputHandle>(null);
  const editor = editorRef ?? localEditor;
  const selection = useRef(0);
  const errorId = useId();
  const textError = text.trim().length > MAX_CHAT_TEXT_CHARS ? `Skróć wiadomość do ${MAX_CHAT_TEXT_CHARS} znaków.` : "";
  const voice = useVoiceNote(dictated => { setText(draft => [draft.trimEnd(), dictated].filter(Boolean).join(" ")); editor.current?.focus(); }, setFileError);
  const recordDisabled = isDisabled || reading || !voice.available;
  const canSend = !isDisabled && !reading && voice.state === "idle" && !textError && (!!text.trim() || !!attachment);
  function startRecording() {
    if (recordDisabled) return;
    setFileError("");
    void voice.start();
  }

  function pick(accept: string) {
    if (!picker.current) return;
    picker.current.accept = accept;
    picker.current.click();
  }

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
    editor.current?.focus();
  }

  function submit() {
    if (!canSend) return;
    const caption = text.trim();
    const input: ChatInput = caption ? { text: caption } : {};
    if (attachment?.kind === "image") {
      input.image = attachment.content;
    } else if (attachment?.kind === "document") {
      input.document = attachment.content;
    } else if (attachment?.kind === "recording") {
      input.recording = attachment.content;
    }
    onSubmit(input, attachment?.name);
    setText("");
    setAttachment(null);
    setFileError("");
  }

  return (
    <VStack gap={0} width="100%">
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
      <ChatComposer
        className="fons-composer"
        data-inline={voice.state === "idle" || undefined}
        value={text}
        onChange={setText}
        onSubmit={submit}
        isDisabled={isDisabled}
        elevation="low"
        density="compact"
        placeholder="Napisz wiadomość lub wklej link…"
        drawer={attachment && (
          <ChatComposerDrawer label="Załącznik">
            <VStack gap={2} width="100%">
              <HStack gap={2} vAlign="center">
                {attachment.kind === "image"
                  ? <Thumbnail src={imagePreviewSrc(attachment.content)} alt="" />
                  : <Icon icon={attachment.kind === "document" ? DocumentTextIcon : attachment.content.mime.startsWith("audio/") ? MicrophoneIcon : VideoCameraIcon} size="md" color="secondary" />}
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
                <Text type="supporting" color="secondary">Fons może wysłać obraz do Google, żeby znaleźć jego źródło.</Text>
              )}
            </VStack>
          </ChatComposerDrawer>
        )}
        input={
          <ChatComposerInput
            label="Wiadomość do Fonsa"
            hasHistory={false}
            handleRef={editor}
            onFiles={voice.state === "idle" ? selectFiles : undefined}
            aria-describedby={fileError || textError ? errorId : undefined}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                // Allow attachment-only sends while keeping invalid or still-loading drafts intact.
                event.preventDefault();
                submit();
              }
            }}
          />
        }
        footerActions={
          voice.state === "idle" ? (
            <DropdownMenu placement="above" presentation="adaptive" alignment="start"
              renderTrigger={trigger => <IconButton {...trigger} label="Dodaj plik" tooltip="Dodaj plik lub nagranie"
                variant="ghost" icon={<Icon icon={PlusIcon} />} isDisabled={isDisabled} isLoading={reading} />}
              items={[
                { label: "Dokument lub zdjęcie", onClick: () => pick(DOCUMENT_ACCEPT) },
                { label: "Film", onClick: () => pick(VIDEO_ACCEPT) },
                { label: "Plik audio", onClick: () => pick(AUDIO_ACCEPT) },
              ]} />
          ) : (
            <HStack gap={1} vAlign="center" wrap="wrap">
              <Text role="status" type="supporting">{voice.state === "requesting" ? "Czekam na mikrofon…" : voice.state === "transcribing" ? "Transkrypcja…" : "Nagrywanie…"}</Text>
              <Button label="Anuluj" size="sm" variant="ghost" onClick={voice.cancel} />
            </HStack>
          )
        }
        sendActions={voice.state === "recording" ? (
          <IconButton label="Zakończ" tooltip="Zakończ nagrywanie" icon={<Icon icon={StopIcon} />}
            variant="primary" onClick={voice.stop} />
        ) : voice.state === "idle" && (
          <IconButton label="Dyktuj wiadomość" tooltip="Dyktuj wiadomość" icon={<Icon icon={MicrophoneIcon} />}
            variant="ghost" isDisabled={recordDisabled} onClick={startRecording} />
        )}
        sendButton={<ChatSendButton isDisabled={!canSend} onSend={submit} />}
      />
      {(fileError || textError) && <Text as="p" type="supporting" role="alert" id={errorId}>{fileError || textError}</Text>}
    </VStack>
  );
}
