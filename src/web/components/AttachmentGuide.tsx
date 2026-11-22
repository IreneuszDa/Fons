import { useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowUpTrayIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { attachmentGuides, type AttachmentMode } from "../lib/attachment";

interface AttachmentGuideProps {
  mode: AttachmentMode;
  needsSecondImage: boolean;
  reading: boolean;
  isDisabled: boolean;
  onChoose: () => void;
  onFiles: (files: File[]) => void;
  onClose: () => void;
}

export function AttachmentGuide({ mode, needsSecondImage, reading, isDisabled, onChoose, onFiles, onClose }: AttachmentGuideProps) {
  const guide = attachmentGuides[mode];
  const titleId = useId();
  const descriptionId = useId();
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const hint = mode === "compare" ? (needsSecondImage ? "drugi obraz" : "obrazy") : "plik";

  function handleDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isDisabled || reading ? "none" : "copy";
  }

  return (
    <VStack as="section" className="fons-attachment-guide" aria-labelledby={titleId}
      aria-describedby={descriptionId} data-dragging={dragging || undefined}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onDragOver={handleDragOver}
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes("Files") || isDisabled || reading) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={event => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!isDisabled && !reading) onFiles(files);
      }}>
      <VStack className="fons-attachment-layout" padding={4} gap={2}>
        <VStack className="fons-attachment-art" hAlign="center" vAlign="center" aria-hidden>
          <img src={`/illustrations/attach-${mode}.webp`} alt="" width={432} height={288} draggable={false} />
        </VStack>
        <Heading id={titleId} className="fons-attachment-title" level={2} tabIndex={-1}>{guide.label}</Heading>
        <Text as="p" id={descriptionId} className="fons-attachment-description">{guide.description}</Text>
        <HStack className="fons-attachment-actions" gap={2} wrap="wrap" vAlign="center">
          <Button label={needsSecondImage ? "Wybierz drugi obraz" : guide.choose}
            variant="primary" icon={<Icon icon={ArrowUpTrayIcon} size="sm" />}
            isDisabled={isDisabled} isLoading={reading} onClick={onChoose} />
          <Text type="supporting" color="secondary">{dragging ? "Upuść tutaj" : `lub przeciągnij ${hint} tutaj`}</Text>
        </HStack>
        <Text as="p" type="supporting" color="secondary" className="fons-attachment-formats">{guide.formats}</Text>
        <IconButton className="fons-attachment-close" label="Zamknij podpowiedź" variant="ghost"
          size="sm" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
      </VStack>
    </VStack>
  );
}
