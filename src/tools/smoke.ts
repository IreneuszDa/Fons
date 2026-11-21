/**
 * Ręczny test wyszukiwania na żywo z prawdziwym modelem i prawdziwymi stronami (kosztuje ok. 0,02–0,03 USD za
 * twierdzenie). Użycie:  OPENAI_DATA_RESIDENCY= npm run live:smoke -- "Szwecja dołączyła do NATO w 2024 roku."
 * Pusty OPENAI_DATA_RESIDENCY = przetwarzanie w USA (projekt bez rezydencji w UE). Nie wypisuje klucza API.
 */
import { loadCatalog } from "../corpus/catalog";
import { ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { createLiveBranch } from "../engine/retrieval/live";
import { getLiveSnapshot } from "../engine/retrieval/live-store";
import { loadConfig } from "../server/config";
import type { Claim } from "../shared/contracts";
import { createOpenAiSearchProvider, type SearchUsage } from "./search";

async function main() {
  const text = process.argv.slice(2).join(" ").trim() || "Szwecja dołączyła do NATO w 2024 roku.";
  const extra = process.env.EXTRA_QUERY ? [process.env.EXTRA_QUERY] : [];
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) {
    console.error("Brak OPENAI_API_KEY — nie ma czym wyszukiwać.");
    process.exit(1);
  }
  console.log(`przetwarzanie: ${cfg.openaiDataResidency?.toLowerCase() === "eu" ? "UE (eu.api.openai.com)" : "USA (api.openai.com)"}; model: ${cfg.modelFast}`);
  const usage: SearchUsage[] = [];
  const db = openDatabase(":memory:");
  ensureCorpusLoaded(db);
  const provider = createOpenAiSearchProvider(cfg, { onUsage: (u) => usage.push(u), timeoutMs: Number(process.env.SEARCH_TIMEOUT_MS ?? 20_000) });
  const t0 = Date.now();
  // Ta sama reguła co gałąź live (live.ts): tylko pierwotne/factcheck z liveSearch=true (np. bez Demagoga — dane tylko przez Fact Check Tools API).
  const hosts = [...new Set(loadCatalog().filter((s) => (s.type === "pierwotne" || s.type === "factcheck") && s.liveSearch).flatMap((s) => s.hosts))];
  if (process.env.SEARCH_ONLY) {
    const found = await provider.search(text, hosts);
    console.log(`wyszukiwanie: ${Date.now() - t0} ms, ${found.length} adresów`);
    for (const f of found) console.log(" -", f.url, f.title ? `(${f.title})` : "");
  } else {
    const branch = createLiveBranch(db, {
      searchProvider: process.env.VERBOSE
        ? {
            id: provider.id,
            search: async (q, h, sig) => {
              const r = await provider.search(q, h, sig);
              console.log(`  [propozycje dla «${q.slice(0, 50)}»]`, r.map((x) => x.url));
              return r;
            },
          }
        : provider,
      limits: { overallTimeoutMs: Number(process.env.LIVE_TIMEOUT_MS ?? 20_000) },
      onDrop: (d) => console.log(`  odrzucono [${d.reason}] ${d.url}`),
      onSecurityEvent: (h, i) => console.log(`  detektor [${h.severity}] ${h.pattern} @ ${i.url} (strona odrzucona: ${i.pageDropped})\n      «${h.excerpt.slice(0, 110)}»`),
    });
    const claim: Claim = { id: "c1", text, type: "fakt", isMain: true, temporal: { kind: "brak" }, inputOverlap: 1 };
    try {
      const res = await branch.search({ claim, extraQueries: extra });
      console.log(`gałąź live: ${Date.now() - t0} ms, ${res.length} kandydatów`);
      for (const c of res) {
        const r = getLiveSnapshot(db, c.recordId, new Date());
        console.log(` - ${c.score.toFixed(2)} ${r?.publisher} (poziom ${r?.level}, ${r?.type}) ${r?.url}\n     ${r?.text.slice(0, 160).replace(/\s+/g, " ")}`);
      }
    } catch (e) {
      console.log(`gałąź live niedostępna po ${Date.now() - t0} ms:`, e instanceof Error ? e.message : "?");
    }
  }
  const total = usage.reduce((s, u) => s + u.costUsd, 0);
  console.log(`wyszukiwań: ${usage.length}, tokeny: ${usage.reduce((s, u) => s + u.inputTokens, 0)} wej. / ${usage.reduce((s, u) => s + u.outputTokens, 0)} wyj., koszt: ${total.toFixed(4)} USD`);
}

main().catch((e) => {
  console.error("błąd:", e instanceof Error ? e.message : "?");
  process.exit(1);
});
