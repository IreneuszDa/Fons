import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ChatBubbleLeftEllipsisIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { MAX_READER_QUOTE_CHARS, normalizeReaderQuote, readerPassages } from "../../shared/chat";
import type { NewsArticle } from "../../shared/news";
import { formatDate } from "../lib/format";
import { safeUrl } from "../lib/safeUrl";

interface Interval { start: number; end: number }

// Offsets refer to the article text, so identical phrases in different paragraphs stay distinct.
function selectedInterval(article: HTMLElement): Interval | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return null;

  let result: Interval | null = null;
  for (const block of article.querySelectorAll<HTMLElement>("[data-passage-offset]")) {
    if (!range.intersectsNode(block)) continue;
    const part = range.cloneRange();
    if (!block.contains(range.startContainer)) part.setStart(block, 0);
    if (!block.contains(range.endContainer)) part.setEnd(block, block.childNodes.length);
    const length = part.toString().length;
    if (!length) continue;

    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(part.startContainer, part.startOffset);
    const start = Number(block.dataset.passageOffset) + prefix.toString().length;
    if (result) result.end = start + length;
    else result = { start, end: start + length };
  }
  return result;
}

function mergeUnderline(existing: Interval[], added: Interval): Interval[] {
  const merged: Interval[] = [];
  for (const item of [...existing, added].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && previous.end >= item.start) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

function markedText(text: string, offset: number, marks: Interval[]): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mark of marks) {
    const start = Math.max(0, mark.start - offset);
    const end = Math.min(text.length, mark.end - offset);
    if (start >= end) continue;
    parts.push(text.slice(cursor, start), <mark key={start}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts;
}

const styles = `
  .fons-news-reader { background: var(--color-background-surface); min-inline-size: 0; }
  .fons-news-reader .news-reader-header, .fons-news-reader .news-reader-actions {
    flex: none;
    padding-inline: clamp(var(--spacing-4), 4vw, var(--spacing-10));
  }
  .fons-news-reader .news-reader-actions { border-block-start: var(--border-width) solid var(--color-border); }
  .fons-news-reader .news-reader-scroll {
    flex: 1 1 0%; min-block-size: 0; overflow-y: auto; overscroll-behavior: contain;
    padding-inline: clamp(var(--spacing-4), 4vw, var(--spacing-10));
  }
  .fons-news-reader .news-reader-copy { margin-inline: auto; overflow-wrap: anywhere; }
  .fons-news-reader .news-reader-title {
    font: 500 clamp(var(--font-size-2xl), 3.4vw, var(--font-size-5xl))/1.12 "Iowan Old Style", Georgia, serif;
    letter-spacing: -.025em;
  }
  .fons-news-reader [data-passage-offset] { -webkit-user-select: text; user-select: text; }
  .fons-news-reader p[data-passage-offset] { font-size: var(--font-size-lg); line-height: 1.6; }
  .fons-news-reader mark {
    background: transparent; color: inherit; text-decoration: underline;
    text-decoration-color: var(--color-text-warning); text-decoration-thickness: .13em; text-underline-offset: .19em;
  }
  .fons-news-reader .news-reader-preview { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
`;

interface NewsReaderProps {
  article: NewsArticle;
  isChatBusy: boolean;
  onClose: () => void;
  onExplain: (quote: string, range: Interval) => void;
}

export function NewsReader({ article, isChatBusy, onClose, onExplain }: NewsReaderProps) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<Interval | null>(null);
  const [marks, setMarks] = useState<Interval[]>([]);
  const passages = useMemo(() => {
    let offset = 0;
    return readerPassages(article).map((text, index) => {
      const start = offset;
      offset += text.length + 2; // Two newlines between passages in the canonical text.
      const label = index === 0 ? "Nagłówek" : `Akapit ${index}`;
      return { text, start, end: start + text.length, label };
    });
  }, [article]);
  const text = passages.map(passage => passage.text).join("\n\n");
  const quote = selected ? normalizeReaderQuote(text.slice(selected.start, selected.end)) : "";
  const tooLong = quote.length > MAX_READER_QUOTE_CHARS;
  const alreadyMarked = !!selected && marks.some(mark => mark.start <= selected.start && selected.end <= mark.end);

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    function readSelection() {
      const interval = body.current && selectedInterval(body.current);
      // Tapping a toolbar button can collapse the native selection before its click.
      if (interval) setSelected(interval);
    }
    document.addEventListener("selectionchange", readSelection);
    return () => document.removeEventListener("selectionchange", readSelection);
  }, []);

  function underline() {
    if (selected && !alreadyMarked) setMarks(current => mergeUnderline(current, selected));
  }

  function selectPassage(passage: Interval) {
    setSelected(passage);
    const block = body.current?.querySelector<HTMLElement>(`[data-passage-offset="${passage.start}"]`);
    const selection = window.getSelection();
    if (!block || !selection) return;
    block.scrollIntoView({ block: "nearest", inline: "nearest" });
    const range = document.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearSelection() {
    const selection = window.getSelection();
    if (selection && body.current?.contains(selection.anchorNode)) selection.removeAllRanges();
    setSelected(null);
  }

  return <VStack as="section" className="fons-news-reader" height="100%" gap={0} aria-labelledby={titleId}>
    <style>{styles}</style>
    <HStack className="news-reader-header" hAlign="between" vAlign="center" gap={2} paddingBlock={3}>
      <VStack gap={0}>
        <Text weight="semibold">{article.publisher}</Text>
        <Text type="supporting" color="secondary">{formatDate(article.publishedAt)}</Text>
      </VStack>
      <IconButton label="Zamknij wiadomość" tooltip="Zamknij wiadomość" variant="ghost"
        onClick={onClose} icon={<Icon icon={XMarkIcon} />} />
    </HStack>
    <VStack className="news-reader-scroll" paddingBlock={5}>
      <VStack className="news-reader-copy" maxWidth="62ch" width="100%" gap={8}>
        <VStack as="article" ref={body} gap={4} aria-labelledby={titleId}
          onClick={() => { if (window.getSelection()?.isCollapsed) setSelected(null); }}>
          {passages.map(({ text, start }, index) => {
            const content = markedText(text, start, marks);
            if (index === 0) return <Heading key={start} id={titleId} className="news-reader-title"
              level={2} tabIndex={-1} ref={title} data-passage-offset={start}>{content}</Heading>;
            return <Text key={start} as="p" data-passage-offset={start}>{content}</Text>;
          })}
        </VStack>
        <VStack gap={3} as="section" aria-label="Źródła wiadomości">
          <Heading level={3}>Źródła</Heading>
          {article.sources.map(item => {
            const href = safeUrl(item.url);
            return <VStack key={item.url} gap={0.5}>
              {href ? <Link href={href} isExternalLink newTabLabel="(otwiera się w nowej karcie)" rel="noopener noreferrer">
                {item.title}
              </Link> : <Text>{item.title}</Text>}
              <Text type="supporting" color="secondary">{item.publisher} · {formatDate(item.publishedAt)}</Text>
            </VStack>;
          })}
        </VStack>
      </VStack>
    </VStack>
    <VStack as="footer" className="news-reader-actions" gap={2} paddingBlock={3}>
      <Text as="p" type="supporting" color="secondary" className="news-reader-preview">
        {quote ? `„${quote}”` : "Zaznacz tekst, żeby go podkreślić lub omówić w czacie."}
      </Text>
      {tooLong && <Text as="p" type="supporting" role="status">
        Do czatu możesz wysłać fragment do {MAX_READER_QUOTE_CHARS} znaków. Skróć zaznaczenie.
      </Text>}
      <HStack gap={2} vAlign="center" wrap="wrap">
        <DropdownMenu placement="above" button={{ label: quote ? "Zmień fragment" : "Wybierz fragment", size: "sm", variant: "ghost" }}
          items={[
            ...passages.map(passage => ({ label: passage.label, onClick: () => selectPassage(passage) })),
            ...(selected ? [{ label: "Wyczyść zaznaczenie", onClick: clearSelection }] : []),
          ]} />
        {quote && selected && <>
          <Button size="sm" label={alreadyMarked ? "Podkreślono" : "Podkreśl"} isDisabled={alreadyMarked} onClick={underline} />
          <Button size="sm" variant="primary" label="Wyjaśnij w czacie" icon={<Icon icon={ChatBubbleLeftEllipsisIcon} />}
            isDisabled={isChatBusy || tooLong} onClick={() => { underline(); onExplain(quote, selected); }} />
        </>}
      </HStack>
    </VStack>
  </VStack>;
}
