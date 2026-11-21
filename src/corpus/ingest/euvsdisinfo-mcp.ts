import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { baseFromCatalog, clipVerbatim, MAX_QUOTE_CHARS, newResult, recordId, sourceFromCatalog, USER_AGENT, type IngestOptions, type IngestResult } from "./common";

const MCP_URL = new URL("https://mcp.euvsd.info/mcp");
const CASE_ORIGIN = "https://euvsdisinfo.eu";
const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 50_000;
const TIMEOUT_MS = 20_000;
const MIN_TITLE_CHARS = 21;
const DAY_MS = 86_400_000;
export const EUVSDISINFO_MCP_TOPIC = "euvsdisinfo-mcp";

const CasesPage = z.object({
  offset: z.number().int().nonnegative(),
  hasNextPage: z.boolean(),
  cases: z.array(z.unknown()),
});
const CaseItem = z.object({
  title: z.string(),
  url: z.url(),
  date: z.number().finite().nullish(),
});

function caseMetadata(item: unknown, fetchedAt: Date): { path: string; title: string; date: string | null } | null {
  const parsed = CaseItem.safeParse(item);
  if (!parsed.success) return null;
  const { title, url, date } = parsed.data;
  const address = new URL(url);
  if (address.origin !== CASE_ORIGIN || address.username || address.password || !/^\/report\/[^/]+\/?$/.test(address.pathname)) return null;
  const heading = clipVerbatim(title, MAX_QUOTE_CHARS);
  if (heading.length < MIN_TITLE_CHARS) return null;
  const instant = date == null ? null : new Date(date * 1000);
  if (instant && (Number.isNaN(instant.getTime()) || instant.getTime() > fetchedAt.getTime() + DAY_MS)) return null;
  return {
    path: address.pathname.replace(/\/?$/, "/"),
    title: heading,
    date: instant ? instant.toISOString().split("T")[0]! : null,
  };
}

/** Importuje metadane opisanych przypadków przez autoryzowane API. Nie zapisuje treści ani recenzji. */
export async function ingestEuvsdisinfoMcp(
  opts: IngestOptions,
  token: string,
  deps: { fetch?: typeof fetch; paceMs?: number } = {},
): Promise<IngestResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`EUvsDisinfo MCP: --limit musi być liczbą całkowitą od 1 do ${MAX_LIMIT}`);
  }
  const result = newResult("euvsdisinfo");
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, result.id));
  const client = new Client({ name: "fons-corpus", version: "1.0.0" });
  const networkFetch = deps.fetch ?? fetch;
  let nextRequestAt = 0;
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT }, redirect: "error" },
    fetch: async (input, init) => {
      const now = Date.now();
      const start = Math.max(nextRequestAt, now);
      nextRequestAt = start + (deps.paceMs ?? 1000);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      if (start > now) await delay(start - now, undefined, { signal });
      return networkFetch(input, { ...init, signal });
    },
  });
  let offset = 0;
  let skipped = 0;
  const seen = new Set<string>();
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    while (offset < limit) {
      const size = Math.min(PAGE_SIZE, limit - offset);
      const response = await client.callTool({ name: "cases", arguments: { offset, limit: size } }, undefined, { timeout: TIMEOUT_MS });
      result.requests++;
      const page = CasesPage.safeParse(response.structuredContent);
      if (
        response.isError || !page.success || page.data.offset !== offset
        || page.data.cases.length > size || (page.data.hasNextPage && page.data.cases.length === 0)
      ) {
        throw new Error("nieprawidłowa strona przypadków");
      }
      const fetchedAt = new Date();
      for (const item of page.data.cases) {
        const entry = caseMetadata(item, fetchedAt);
        if (!entry) {
          skipped++;
          continue;
        }
        const id = recordId(result.id, entry.path);
        if (seen.has(id)) continue;
        seen.add(id);
        const url = `${CASE_ORIGIN}${entry.path}`;
        result.records.push({
          ...base,
          id,
          url,
          title: `EUvsDisinfo: ${entry.title}`,
          lang: "en",
          publishedAt: entry.date,
          fetchedAt: fetchedAt.toISOString(),
          text: entry.title,
          claimReviewed: entry.title,
          topics: ["dezinformacja", "euvsdisinfo", "narracja-prorosyjska", EUVSDISINFO_MCP_TOPIC],
          origin: "corpus",
        });
        result.incidents.push({
          id,
          title: entry.title,
          summary: "EUvsDisinfo (EEAS) opisuje podobną narrację w publicznej bazie przypadków dezinformacji.",
          url,
          domains: [],
          publishedAt: entry.date,
          recordId: id,
        });
      }
      offset += page.data.cases.length;
      if (!page.data.hasNextPage) break;
    }
  } catch {
    // Nie logujemy surowych błędów nagłówków, transportu ani odpowiedzi serwera.
    throw new Error(`EUvsDisinfo MCP: pobieranie nie powiodło się (offset ${offset}). Sprawdź dostęp do serwera i EUVSDISINFO_MCP_TOKEN.`);
  } finally {
    await client.close();
  }
  if (skipped > 0) result.notes.push(`${skipped} przypadków pominięto ze względu na nieprawidłowy tytuł, datę lub adres.`);
  result.notes.push(`EUvsDisinfo MCP: ${offset} pozycji w ${result.requests} str. narzędzia cases. Zapisane pola: tytuł, data i adres wpisu. Bez oceny i domen.`);
  return result;
}
