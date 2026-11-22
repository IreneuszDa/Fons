import { z } from "zod";

export const ImageComparison = z.enum(["identical_file", "same_pixels", "similar", "no_match"]);
export type ImageComparison = z.infer<typeof ImageComparison>;

export const ImageCitation = z.object({
  url: z.httpUrl(), title: z.string(), quote: z.string(),
  kind: z.literal("official_profile").optional(),
});
export type ImageCitation = z.infer<typeof ImageCitation>;

export const LocalImageSearch = z.object({
  status: z.enum(["ok", "unavailable"]),
  checked: z.number().int().nonnegative(),
  catalogVersion: z.hash("sha256").optional(),
  matches: z.array(z.object({
    recordId: z.string().regex(/^image:[a-z0-9-]+$/).optional(),
    title: z.string(), publisher: z.string(), url: z.httpUrl(), publishedAt: z.iso.date(),
    kind: z.enum(["identical", "similar"]),
  })),
});
export type LocalImageSearch = z.infer<typeof LocalImageSearch>;

export const ImageSearchResult = z.object({
  status: z.enum(["ok", "unavailable", "disabled"]),
  messagePl: z.string(),
  matches: z.array(z.object({
    host: z.string(),
    kind: z.enum(["page", "full", "partial"]),
    pageMatch: z.enum(["full", "partial"]).optional(),
    publishedAt: z.iso.date().optional(),
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
  usage: z.object({
    provider: z.literal("google_cloud_vision"),
    feature: z.literal("WEB_DETECTION"),
    requests: z.number().int().positive(),
    costUsd: z.null(),
  }).optional(),
  /** Captions read from a catalogue publication next to an exact match for this image. */
  captions: z.array(ImageCitation).optional(),
});
export type ImageSearchResult = z.infer<typeof ImageSearchResult>;
