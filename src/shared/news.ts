export interface NewsSource {
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
}

/** Full Fons article, with the publisher's assessment of the quoted claim. */
export interface NewsArticle {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  claim: string;
  rating: string;
  reviewer: string;
  reviewedAt: string;
  paragraphs: string[];
  sources: NewsSource[];
}
