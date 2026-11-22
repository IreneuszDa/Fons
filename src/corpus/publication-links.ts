import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { CorpusRecord } from "../shared/contracts";
import { dataDir } from "./paths";

const Link = z.object({
  publicationId: z.string(),
  url: z.string().url(),
  archiveQuery: z.string().min(1).optional(),
  documents: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  context: z.array(z.string()).optional(),
  appearances: z.array(z.string().url()).optional(),
  excerpts: z.array(z.string().min(1).max(300)).optional(),
});
export type PublicationLink = z.infer<typeof Link>;
const cache = new Map<string, { mtimeMs: number; links: PublicationLink[] }>();

export function publicationLinks(override?: string): PublicationLink[] {
  const path = resolve(dataDir(override), "publication-links.json");
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return [];
  const cached = cache.get(path);
  if (cached?.mtimeMs === info.mtimeMs) return cached.links;
  const links = z.array(Link).parse(JSON.parse(readFileSync(path, "utf8")));
  cache.set(path, { mtimeMs: info.mtimeMs, links });
  return links;
}

export const EXCERPT_ATTRIBUTION = "Dodatkowe krótkie cytaty z uzasadnienia wskazanej recenzji, dobrane redakcyjnie i przypisane wydawcy. Prawa do cytowanych fragmentów pozostają przy wydawcy.";

export function includePublishedExcerpts(record: CorpusRecord, link?: PublicationLink): CorpusRecord {
  if (link?.url !== record.url || !link.excerpts?.length) return record;
  return { ...record, text: [record.text, ...link.excerpts].join("\n"), licence: record.licence + " " + EXCERPT_ATTRIBUTION };
}
