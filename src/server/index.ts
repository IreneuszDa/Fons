/** Start usługi: Hono na PORT, w produkcji serwuje web-dist/. Logi: JSON, jedna linia na zdarzenie. */
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { purgeRetention } from "./db";
import { buildProductionContext, openServerDatabase } from "./wiring";

async function main(): Promise<void> {
  // Hasło administratora: pokazywane tylko raz (przy pierwszym wygenerowaniu pliku), na stderr,
  // żeby nie trafiło do strumienia logów JSON na stdout.
  const hadPasswordFile = existsSync("var/admin-password");
  const hadUsersFile = existsSync(process.env.USERS_PATH?.trim() || "var/users.json");
  const cfg = loadConfig();
  if (cfg.adminPasswordGenerated && !hadPasswordFile && !hadUsersFile) {
    process.stderr.write(`[fons] Wygenerowane hasło konta "admin" (pokazane tylko raz): ${cfg.adminPassword}\n`);
  }

  const db = openServerDatabase(cfg);
  const ctx = buildProductionContext(cfg, db);
  const app = createApp(ctx);
  if (!cfg.adminPasswordGenerated && cfg.adminPassword.length < 10) {
    ctx.log.warn({ event: "weak_bootstrap_password", hint: "ADMIN_PASSWORD ma mniej niż 10 znaków; zmień je albo dodaj użytkownika: npm run user" });
  }
  if (!hadUsersFile) ctx.log.info({ event: "users_file_created", path: cfg.usersPath });

  const purge = () => {
    try {
      const r = purgeRetention(db, new Date());
      if (Object.values(r).some((n) => n > 0)) ctx.log.info({ event: "retention", ...r });
    } catch (e) {
      ctx.log.error({ event: "retention_failed", error: e instanceof Error ? e.name : "error" });
    }
  };
  purge();
  const timer = setInterval(purge, 3_600_000);
  timer.unref();

  // HOST lets a private deployment bind to one interface (e.g. a Tailscale address).
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: process.env.HOST?.trim() || undefined }, (info) => {
    ctx.log.info({ event: "listening", port: info.port, env: cfg.env, llm: ctx.engine.llm.provider });
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "startup_failed", error: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(1);
});
