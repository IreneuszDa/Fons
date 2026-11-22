// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from the Astryx ai-chat-landing template.
import type { ReactNode, RefObject } from "react";
import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { MessageComposer, type ComposerDraftRef, type SubmitMessage } from "../../web/components/MessageComposer";

interface ChatLandingProps {
  onSubmit: SubmitMessage;
  isDisabled?: boolean;
  editorRef?: RefObject<ChatComposerInputHandle | null>;
  news?: ReactNode;
  draftRef?: ComposerDraftRef;
}

export default function ChatLanding({ onSubmit, isDisabled, editorRef, news, draftRef }: ChatLandingProps) {
  return (
    <Layout
      height="fill"
      padding={0}
      content={
        <LayoutContent padding={0} isScrollable={false}>
          <VStack className="fons-chat-landing" height="100%" paddingInline={4}>
            <MessageComposer onSubmit={onSubmit} isDisabled={isDisabled} editorRef={editorRef} draftRef={draftRef} />
            {news && <VStack className="fons-landing-news" width="100%" maxWidth="44rem" paddingBlock={4}>{news}</VStack>}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
