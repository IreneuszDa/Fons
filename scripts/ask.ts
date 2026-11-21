/**
 * `npm run ask "tekst"` — uruchamia warstwę rozmowy jako kanał cli i drukuje odpowiedź.
 * Sesja jest stała (cli-local), więc kolejne wywołania mogą pytać o „źródła”, „dlaczego” itd.
 * Bez argumentów: prosta pętla interaktywna (puste polecenie kończy).
 */
import { createInterface } from "node:readline/promises";
import { cliAdapter, buildCliInbound } from "../src/server/channels/cli";
import { loadConfig } from "../src/server/config";
import { handleInbound } from "../src/server/conversation";
import { buildProductionContext, openServerDatabase } from "../src/server/wiring";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const db = openServerDatabase(cfg);
  const ctx = buildProductionContext(cfg, db);
  const senderId = ctx.security.pseudonymize("cli:local");

  const ask = async (text: string, action?: string) => {
    const reply = await handleInbound(buildCliInbound(ctx, { senderId, text, action }), ctx);
    console.log(cliAdapter.render(reply));
  };

  if (args.length > 0) {
    await ask(args.join(" "));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("> ")).trim();
      if (!line) break;
      await ask(line);
    }
    rl.close();
  }
  db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`Błąd: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
