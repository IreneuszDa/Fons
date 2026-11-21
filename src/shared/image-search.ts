import { z } from "zod";

export const ImageSearchResult = z.object({
  status: z.enum(["ok", "unavailable", "disabled"]),
  messagePl: z.string(),
  matches: z.array(z.object({
    host: z.string(),
    kind: z.enum(["page", "full", "partial"]),
    url: z.httpUrl().optional(),
    title: z.string().optional(),
  })),
  factChecks: z.array(z.object({
    url: z.httpUrl(),
    title: z.string(),
    publisher: z.string(),
    rating: z.string().optional(),
  })),
  factCheckStatus: z.enum(["ok", "unavailable", "not_applicable"]),
  factCheckMessagePl: z.string().optional(),
});
export type ImageSearchResult = z.infer<typeof ImageSearchResult>;
