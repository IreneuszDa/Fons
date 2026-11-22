/**
 * Serwer MCP przez stdio — dla Claude Desktop, IDE i innych klientów uruchamiających proces lokalnie.
 * Uruchomienie: `npm run mcp` (tsx src/mcp/stdio.ts). Stdout jest kanałem protokołu, więc wszystko, co zwykle
 * trafia na stdout (console.log), przekierowujemy na stderr. Proces ustawia katalog roboczy na korzeń repozytorium
 * (żeby działały .env, var/ i data/), niezależnie od miejsca uruchomienia przez klienta.
 *
 * Dostęp lokalny = zaufany użytkownik tej maszyny: rola „analyst” (wszystkie narzędzia), bez tokenów.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);

async function main(): Promise<void> {
  // Importy dynamiczne PO zmianie katalogu: config.ts czyta .env z bieżącego katalogu.
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { loadConfig } = await import("../server/config");
  const { ensureCorpusLoaded, openDatabase } = await import("../corpus/store");
  const { createEngineDeps } = await import("../engine/verify");
  const { loadExtensions } = await import("../server/extensions");
  const { warmUp } = await import("../engine/retrieval");
  const { createFonsMcpServer } = await import("./server");

  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  ensureCorpusLoaded(db);
  const deps = createEngineDeps(db, cfg, { extensions: await loadExtensions(cfg, db) });
  // Rozgrzewka modelu wektorów (nigdy nie rzuca), żeby pierwsze zapytanie nie dostało adnotacji o niedostępnej gałęzi.
  // Czekamy najwyżej 10 s — klient MCP czeka na odpowiedź initialize.
  await Promise.race([warmUp(deps.branches), new Promise((r) => setTimeout(r, 10_000))]);

  const server = createFonsMcpServer({ db, deps, cfg, principal: { id: "stdio-local", role: "analyst" } });
  await server.connect(new StdioServerTransport());
  console.error("[fons-mcp] gotowy (stdio)");
}

main().catch((e) => {
  console.error("[fons-mcp] błąd uruchomienia:", e instanceof Error ? e.message : "nieznany");
  process.exit(1);
});
