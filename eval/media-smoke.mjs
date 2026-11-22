/** Run with node --import tsx eval/media-smoke.mjs <fixture-directory> <output.json>. */
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/server/config.ts";
import { buildProductionContext, openServerDatabase } from "../src/server/wiring.ts";
import { createApp } from "../src/server/app.ts";

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Wskaż katalog dowodów z paczki audytu i docelowy plik JSON.");
// Restrict external processing to the publicly attributed, known competition fixtures.
const fixtures = [
  { id: "copies", file: "earth.jpg", sha256: "16eaa54446f761a80ee8de604107b66432a1e6b489aa99d4777dc92765fae80a", mime: "image/jpeg", text: "Gdzie wcześniej opublikowano to zdjęcie?" },
  { id: "ocr", file: "source.png", sha256: "65af8ea8e3aa25c130efdfac9834c31f46c3e2aced67564647fc06e82f892f7c", mime: "image/png", text: "Czy Demagog to sprawdzał?" },
  { id: "audio", file: "source.mp3", sha256: "e8be999119fef21072bd7c17aaf994c1128c123a759a59d2e89b0cdd8e7a9623", mime: "audio/mpeg", text: "Co zostało powiedziane w tym nagraniu?" },
];
const cfg = loadConfig({ env: "test", dbPath: ":memory:", usersPath: undefined,
  adminPassword: randomBytes(32).toString("hex"), adminPasswordGenerated: false, userIdPepper: randomBytes(32).toString("hex"),
  publicBaseUrl: "http://localhost", alertWebhookUrl: undefined });
const db = openServerDatabase(cfg);
const ctx = buildProductionContext(cfg, db);
const app = createApp(ctx);
const results = [];
try {
  for (const fixture of fixtures) {
    const bytes = await readFile(resolve(directory, fixture.file));
    if (createHash("sha256").update(bytes).digest("hex") !== fixture.sha256) throw new Error("Niezgodny plik: " + fixture.file);
    const audio = fixture.id === "audio";
    const payload = { text: fixture.text, [audio ? "recording" : "image"]: { mime: fixture.mime, base64: bytes.toString("base64") } };
    if (!audio) payload.imageOptions = { searchWeb: fixture.id === "copies" };
    const start = performance.now();
    const res = await app.request(audio ? "/api/chat/recording" : "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const { reply } = await res.json();
    const report = reply?.report;
    const stored = report?.token && await app.request("/api/report/" + report.token);
    const readback = stored?.status === 200 && (await stored.json()).id === report.id;
    const findings = report?.imageAnalysis?.images?.[0];
    const transcript = (report?.videoAnalysis?.transcript ?? []).map(item => item.text).join(" ");
    const fold = text => text.toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/g, " ").trim();
    const normalizedEcho = report?.inputEchoMasked?.toLowerCase() ?? "";
    const passed = readback && report.status === "OK" && (
      fixture.id === "copies" ? findings?.localSearch?.matches?.some(m => m.publisher === "NASA" && m.publishedAt === "2007-11-30") &&
          findings.search?.status === "ok" && findings.search.matches.length > 0 && report.mainVerdict === null
      : fixture.id === "ocr" ? report.models.some(m => m.purpose === "vision") && /(?:tusk|powodz|powód)/u.test(normalizedEcho)
      : report.inputMode === "transcription" && report.mainVerdict === null && fold(transcript) === fold("W Szczebrzeszynie chrząszcz brzmi w trzcinie.")
    );
    results.push({ fixture: fixture.file, sha256: fixture.sha256, question: fixture.text, passed: Boolean(passed), readback,
      http: res.status, durationMs: Math.round(performance.now() - start), status: report?.status, mode: report?.inputMode,
      verdict: report?.mainVerdict, answer: reply?.textPl, inputEcho: fixture.id === "ocr" ? report?.inputEchoMasked : undefined,
      local: findings?.localSearch, google: findings?.search && { status: findings.search.status, matches: findings.search.matches.length,
        usage: findings.search.usage, links: findings.search.matches.map(match => match.url).filter(Boolean).slice(0, 3) },
      provenance: findings?.provenance, transcript: transcript || undefined, modelCalls: report?.models?.map(m => ({ purpose: m.purpose, model: m.model })),
      costUsd: report?.costUsd, costStatus: report?.costStatus });
    console.log(fixture.id, results.at(-1).passed, report?.status, readback);
  }
} finally {
  await writeFile(output, JSON.stringify({ observedAt: new Date().toISOString(), pipelineVersion: ctx.engine.pipelineVersion,
    snapshotId: ctx.engine.snapshotId(), results }, null, 2) + "\n");
  db.close();
}
if (results.some(row => !row.passed)) process.exitCode = 1;
