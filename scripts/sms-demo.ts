import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { createDemoBridge } from "../integrations/chatloom/demo";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { configuredProductionContext, openServerDatabase } from "../src/server/wiring";

async function main(): Promise<void> {
  // The endpoint is local to this process. Its ephemeral signing key never leaves it.
  const secret = randomBytes(32).toString("hex");
  const cfg = loadConfig({ chatloomWebhookSecret: secret, alertWebhookUrl: undefined });
  const db = openServerDatabase(cfg);
  try {
    const app = createApp(await configuredProductionContext(cfg, db));
    const send = createDemoBridge(request => app.fetch(request), secret);
    console.error("Symulator SMS przez ChatLoom. Numer i konto operatora są zbędne. Raporty zapisują się w bazie Fonsa.");
    const text = process.argv.slice(2).join(" ").trim();
    if (text) {
      console.log(await send(text));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for await (const line of rl) {
        if (!line.trim()) break;
        console.log(await send(line.trim()));
      }
    } finally {
      rl.close();
    }
  } finally {
    db.close();
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e instanceof Error ? e.message : "Błąd symulatora SMS.");
  process.exit(1);
});
