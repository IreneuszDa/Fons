// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx ai-chat-landing template.
import type { RefObject } from "react";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { MessageComposer, type SubmitMessage } from "../../web/components/MessageComposer";

interface ChatLandingProps {
  onSubmit: SubmitMessage;
  isDisabled?: boolean;
  editorRef?: RefObject<ChatComposerInputHandle | null>;
}

export default function ChatLanding({ onSubmit, isDisabled, editorRef }: ChatLandingProps) {
  return (
    <Layout
      height="fill"
      padding={0}
      content={
        <LayoutContent padding={0} isScrollable={false}>
          <VStack className="fons-chat-landing" height="100%" paddingInline={4}>
            <MessageComposer onSubmit={onSubmit} isDisabled={isDisabled} editorRef={editorRef} />
          </VStack>
        </LayoutContent>
      }
    />
  );
}
