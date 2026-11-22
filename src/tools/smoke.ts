/**
 * Ręczny test wyszukiwania na żywo z prawdziwym modelem i prawdziwymi stronami (kosztuje ok. 0,02–0,03 USD za
 * twierdzenie). Użycie:  OPENAI_DATA_RESIDENCY= npm run live:smoke -- "Szwecja dołączyła do NATO w 2024 roku."
 * Pusty OPENAI_DATA_RESIDENCY = przetwarzanie w USA (projekt bez rezydencji w UE). Nie wypisuje klucza API.
 */
import { loadCatalog } from "../corpus/catalog";
import { ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { createLiveBranch, LIVE_LIMITS } from "../engine/retrieval/live";
import { getLiveSnapshot, reserveLiveRequest } from "../engine/retrieval/live-store";
import { loadConfig } from "../server/config";
import { fetchPage } from "../security/fetch";
import type { Claim } from "../shared/contracts";
import { openAiHost } from "../engine/llm/openai";
import { createOpenAiSearchProvider, DEFAULT_SEARCH_TIMEOUT_MS, type SearchUsage } from "./search";

async function main() {
  const text = process.argv.slice(2).join(" ").trim() || "Szwecja dołączyła do NATO w 2024 roku.";
  const extra = process.env.EXTRA_QUERY ? [process.env.EXTRA_QUERY] : [];
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) {
    console.error("Brak OPENAI_API_KEY — nie ma czym wyszukiwać.");
    process.exit(1);
  }
  const host = openAiHost(cfg.openaiDataResidency, cfg.openaiBaseUrl);
  const region = !cfg.openaiBaseUrl && cfg.openaiDataResidency?.toLowerCase() === "eu" ? "UE" : "USA";
  console.log(`przetwarzanie: ${region} (${host}); model: ${cfg.openaiSearchModel ?? cfg.modelFast}`);
  const usage: SearchUsage[] = [];
  const db = openDatabase(":memory:");
  ensureCorpusLoaded(db);
  const quotaDb = openDatabase(cfg.dbPath);
  const provider = createOpenAiSearchProvider(cfg, {
    onUsage: u => usage.push(u),
    reserveRequest: () => reserveLiveRequest(quotaDb, new Date(), cfg.webSearchDailyCap),
    timeoutMs: Number(process.env.SEARCH_TIMEOUT_MS ?? DEFAULT_SEARCH_TIMEOUT_MS),
  });
  const t0 = Date.now();
  // Ta sama reguła co gałąź live (live.ts): tylko pierwotne/factcheck z liveSearch=true (np. bez Demagoga — dane tylko przez Fact Check Tools API).
  const hosts = [...new Set(loadCatalog().filter((s) => (s.type === "pierwotne" || s.type === "factcheck") && s.liveSearch).flatMap((s) => s.hosts))];
  if (process.env.SEARCH_ONLY) {
    const found = await provider.search(text, hosts);
    console.log(`wyszukiwanie: ${Date.now() - t0} ms, ${found.length} adresów`);
    if (!found.length) process.exitCode = 1;
    for (const f of found) console.log(" -", f.url, f.title ? `(${f.title})` : "");
  } else {
    const branch = createLiveBranch(db, {
      searchProvider: process.env.VERBOSE
        ? {
            id: provider.id,
            search: async (q, h, sig) => {
              const r = await provider.search(q, h, sig);
              console.log(`  [propozycje dla «${q.slice(0, 50)}», ${h.length} hostów]`, r.map((x) => x.url));
              return r;
            },
          }
        : provider,
      fetchPage: process.env.VERBOSE ? async (url, opts) => {
        try { return await fetchPage(url, opts); }
        catch (error) {
          const cause = error as { name?: string; reason?: string; code?: string };
          console.log(`  [odczyt ${new URL(url).host}] ${cause.reason ?? cause.code ?? cause.name ?? "błąd"}`);
          throw error;
        }
      } : undefined,
      limits: { overallTimeoutMs: Number(process.env.LIVE_TIMEOUT_MS ?? LIVE_LIMITS.overallTimeoutMs) },
      onDrop: (d) => console.log(`  odrzucono [${d.reason}] ${d.url}`),
      onSecurityEvent: (h, i) => console.log(`  detektor [${h.severity}] ${h.pattern} @ ${i.url} (strona odrzucona: ${i.pageDropped})\n      «${h.excerpt.slice(0, 110)}»`),
    });
    const claim: Claim = { id: "c1", text, type: "fakt", isMain: true, temporal: { kind: "brak" }, inputOverlap: 1 };
    try {
      const res = await branch.search({ claim, extraQueries: extra, onCoverage: state => console.log(`pokrycie: ${state}`) });
      console.log(`gałąź live: ${Date.now() - t0} ms, ${res.length} kandydatów`);
      if (!res.length) process.exitCode = 1;
      for (const c of res) {
        const r = getLiveSnapshot(db, c.recordId, new Date());
        console.log(` - ${c.score.toFixed(2)} ${r?.publisher} (poziom ${r?.level}, ${r?.type}) ${r?.url}\n     ${r?.text.slice(0, 160).replace(/\s+/g, " ")}`);
      }
    } catch (e) {
      console.log(`gałąź live niedostępna po ${Date.now() - t0} ms:`, e instanceof Error ? e.message : "?");
      process.exitCode = 1;
    }
  }
  const total = usage.reduce((s, u) => s + u.costUsd, 0);
  console.log(`żądań Responses: ${usage.length}, wywołań web_search: ${usage.reduce((s, u) => s + u.searchCalls, 0)}, tokeny: ${usage.reduce((s, u) => s + u.inputTokens, 0)} wej. / ${usage.reduce((s, u) => s + u.outputTokens, 0)} wyj., koszt: ${total.toFixed(4)} USD`);
  db.close();
  quotaDb.close();
}

main().catch((e) => {
  console.error("błąd:", e instanceof Error ? e.message : "?");
  process.exit(1);
});
