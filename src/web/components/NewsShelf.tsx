import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { NewsArticle } from "../../shared/news";
import { listNews } from "../api";
import { formatDate } from "../lib/format";

export function useLatestNews() {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listNews(controller.signal).then(items => {
      if (controller.signal.aborted) return;
      setArticles(items);
      setStatus("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setStatus("error");
    });
    return () => controller.abort();
  }, [attempt]);
  return { articles, status, retry: () => { setStatus("loading"); setAttempt(value => value + 1); } };
}

export function NewsShelf({ news, onOpen }: {
  news: ReturnType<typeof useLatestNews>;
  onOpen: (article: NewsArticle) => void;
}) {
  return <VStack as="section" aria-label="Najnowsze sprawdzone wiadomości" width="100%" gap={3}>
    <Heading level={2} className="fons-news-heading">Najnowsze sprawdzone wiadomości</Heading>
    {news.articles.length > 0 ? (
      <Grid className="fons-news-tiles" columns={4} gap={2}>
        {news.articles.map(article => (
          <ClickableCard key={article.id} className="fons-news-tile" padding={3}
            data-news-id={article.id} label={`Czytaj: ${article.title}`} onClick={() => onOpen(article)}>
            <VStack gap={4}>
              <Text type="supporting" color="secondary"><time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time></Text>
              <Text className="fons-news-title" maxLines={4} hasTruncateTooltip={false}>{article.title}</Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>
    ) : (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="supporting" color="secondary" role="status">
          {news.status === "loading" ? "Wczytuję wiadomości…" : news.status === "error"
            ? "Nie udało się wczytać wiadomości." : "Brak opublikowanych wiadomości."}
        </Text>
        {news.status === "error" && <Button variant="ghost" size="sm" label="Spróbuj ponownie" onClick={news.retry} />}
      </HStack>
    )}
  </VStack>;
}
