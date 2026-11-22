import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import type { NewsArticle } from "../../shared/news";
import type { ReaderExcerpt } from "../../shared/chat";
import { NewsReader } from "./NewsReader";

const narrowScreen = "(max-width: 48rem)";
const styles = `
  .fons-landing-news {
    grid-row: 3; align-self: start; min-inline-size: 0;
    max-block-size: 100%; overflow-y: auto; overscroll-behavior-y: contain;
  }
  .fons-landing-news .fons-news-heading { font-size: var(--font-size-base); font-weight: var(--font-weight-medium); }
  .fons-news-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .fons-news-tile {
    aspect-ratio: 1; min-inline-size: 0;
    text-align: start;
  }
  .fons-news-tile .fons-news-title {
    font: 500 var(--font-size-xl)/1.13 "Iowan Old Style", Georgia, serif;
    letter-spacing: -.02em; overflow-wrap: anywhere;
  }
  .fons-reader-columns {
    flex: 1; display: grid; min-block-size: 0;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr);
  }
  .fons-reader-columns[data-open] { grid-template-columns: clamp(22rem, 33%, 34rem) minmax(0, 1fr); }
  .fons-reader-chat, .fons-reader-article { min-inline-size: 0; min-block-size: 0; }
  .fons-reader-chat:focus { outline: none; }
  .fons-reader-chat:focus-visible { outline: var(--border-width) solid var(--color-border-emphasized); outline-offset: calc(-1 * var(--border-width)); }
  .fons-reader-columns[data-open] .fons-reader-chat { border-inline-end: var(--border-width) solid var(--color-border); }
  .fons-reader-columns[data-open] .fons-chat-landing { grid-template-rows: 1fr auto; padding-block-end: var(--spacing-3); }
  .fons-reader-columns[data-open] .fons-chat-landing .fons-composer-extras { max-block-size: calc(100cqh - 100%); }
  .fons-reader-chat-content { flex: 1; min-block-size: 0; }
  .fons-reader-chat-title { flex-shrink: 0; }
  @media (max-width: 41rem) {
    .fons-news-tiles {
      grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: clamp(9.5rem, 46%, 11rem);
      overflow-x: auto; scroll-snap-type: x proximity; overscroll-behavior-inline: contain;
      padding: var(--spacing-1); margin: calc(-1 * var(--spacing-1));
    }
    .fons-news-tile { scroll-snap-align: start; }
  }
  @media ${narrowScreen} {
    .fons-reader-columns[data-open] { grid-template-columns: minmax(0, 1fr); }
    .fons-reader-columns[data-open] .fons-reader-chat { border: none; }
    .fons-reader-columns[data-pane="article"] .fons-reader-chat,
    .fons-reader-columns[data-pane="chat"] .fons-reader-article { display: none; }
  }
`;

export function ReaderWorkspace({ article, isChatBusy, onClose, onExplain, children }: {
  article: NewsArticle | null;
  isChatBusy: boolean;
  onClose: () => void;
  onExplain: (excerpt: ReaderExcerpt) => void;
  children: ReactNode;
}) {
  const narrow = useMediaQuery(narrowScreen);
  const [pane, setPane] = useState<"article" | "chat">("article");
  const chatPane = useRef<HTMLElement>(null);
  const closedArticle = useRef<string | null>(null);
  useLayoutEffect(() => {
    setPane("article");
    if (article || !closedArticle.current) return;
    const selector = `[data-news-id="${CSS.escape(closedArticle.current)}"] button`;
    const tile = chatPane.current?.querySelector<HTMLButtonElement>(selector);
    (tile ?? chatPane.current)?.focus({ preventScroll: true });
    closedArticle.current = null;
  }, [article]);

  return <VStack width="100%" height="100%" gap={0}>
    <style>{styles}</style>
    {article && narrow && (
      <HStack role="group" aria-label="Widok czytania" hAlign="center" gap={1} paddingBlock={1}>
        <Button size="sm" variant={pane === "chat" ? "secondary" : "ghost"} label="Czat"
          aria-pressed={pane === "chat"} onClick={() => setPane("chat")} />
        <Button size="sm" variant={pane === "article" ? "secondary" : "ghost"} label="Artykuł"
          aria-pressed={pane === "article"} onClick={() => setPane("article")} />
      </HStack>
    )}
    <HStack className="fons-reader-columns" gap={0} data-open={article ? true : undefined} data-pane={article ? pane : undefined}>
      <VStack ref={chatPane} tabIndex={-1} role="region" aria-label="Czat z Fonsem" className="fons-reader-chat" gap={0}>
        {article && !narrow && <HStack className="fons-reader-chat-title" paddingInline={4} paddingBlock={3}>
          <Text weight="semibold">Czat z Fonsem</Text>
        </HStack>}
        <VStack className="fons-reader-chat-content" gap={0}>{children}</VStack>
      </VStack>
      {article && <VStack className="fons-reader-article" gap={0}>
        <NewsReader key={article.id} article={article} isChatBusy={isChatBusy}
          onClose={() => { closedArticle.current = article.id; onClose(); }}
          onExplain={(quote, range) => {
            onExplain({ articleId: article.id, quote, ...range });
            if (narrow) {
              setPane("chat");
              requestAnimationFrame(() => chatPane.current?.focus({ preventScroll: true }));
            }
          }} />
      </VStack>}
    </HStack>
  </VStack>;
}
