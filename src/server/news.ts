import publications from "../../data/news.json";
import type { NewsArticle } from "../shared/news";
import type { ServerContext } from "./context";

// Each publication preserves the review and sources as cited at publication time.
// Later updates of the rolling search corpus must not change an article the reader quoted.
const articles: NewsArticle[] = publications.map(({ review, sources, ...publication }) => ({
  ...publication,
  publisher: "Fons",
  reviewer: review.publisher,
  reviewedAt: review.publishedAt,
  url: review.url,
  sources: [review, ...sources],
})).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.reviewedAt.localeCompare(a.reviewedAt));

const warsawDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
});

export function latestNews(ctx: ServerContext): NewsArticle[] {
  const today = warsawDay.format(ctx.now());
  return articles.filter(article => article.publishedAt <= today).slice(0, 4);
}

export function getNewsArticle(ctx: ServerContext, id: string): NewsArticle | undefined {
  const today = warsawDay.format(ctx.now());
  return articles.find(article => article.id === id && article.publishedAt <= today);
}
