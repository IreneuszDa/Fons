import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { makeTestConfig } from "./testkit";
import { configuredProductionContext, openServerDatabase } from "./wiring";
import { createApp } from "./app";

it("ładuje kanał, wyszukiwarkę i model z lokalnego modułu przy starcie usługi", async () => {
  const cfg = makeTestConfig({ dbPath: ":memory:",
    extensionsModule: fileURLToPath(new URL("../../tests/fixtures/operator-extension.ts", import.meta.url)) });
  const db = openServerDatabase(cfg);
  try {
    const ctx = await configuredProductionContext(cfg, db);
    expect(ctx.engine.llm).toMatchObject({ provider: "fake", singleKey: true });
    expect(ctx.engineDeps?.branches.map(b => b.id)).toContain("partner-index");
    const app = createApp(ctx);
    // Registered adapter rejected the signature (unknown channel would return 501).
    expect((await app.request("/api/channels/partner-chat/webhook", { method: "POST", body: "{}" })).status).toBe(403);
    const report = await ctx.engine.verify({ kind: "text", text: "Polska i Litwa wstąpiły do NATO w 1999 roku.",
      channel: "partner-chat", receivedAt: "2026-11-22T12:00:00Z" });
    expect(report.pipelineVersion).toBe(ctx.engine.pipelineVersion);
    expect(report.pipelineVersion).toContain("acceptance-v1");
    expect(report.mainVerdict).toBe("WPROWADZAJACE");
  } finally { db.close(); }
});
