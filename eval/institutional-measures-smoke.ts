import { writeFileSync } from "node:fs";
import { createCorpusStore } from "../src/corpus/store";
import { normalizeQuoteText } from "../src/engine/quotes";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { buildProductionContext, openServerDatabase } from "../src/server/wiring";
import { ConversationReply, reportEvidence, VerdictReport } from "../src/shared/contracts";

const cases = [
  { text: "Kadencja Sejmu trwa 5 lat.", sourceId: "sejm-eli:4b0cf68c664f" },
  { text: "Senat RP liczy 150 senatorów.", sourceId: "sejm-eli:a52a0a8b9e4e" },
];
const cfg = loadConfig({ dbPath: ":memory:", usersPath: undefined, alertWebhookUrl: undefined, publicBaseUrl: "http://localhost",
  rateLimitPerMinute: 1000, dailyTokenBudget: 1_000_000, ipDailyTokenShare: 1 });
const db = openServerDatabase(cfg);
const app = createApp(buildProductionContext(cfg, db));
const corpus = createCorpusStore(db);
const rows = await Promise.all(cases.map(async c => {
  const started = Date.now();
  const res = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: c.text }), signal: AbortSignal.timeout(180_000) });
  const reply = ConversationReply.parse((await res.json()).reply);
  const report = reply.report;
  if (!report) throw new Error("Brak raportu dla zgłoszenia: " + c.text);
  const stored = await app.request("/api/report/" + report.token);
  const saved = stored.ok && VerdictReport.parse(await stored.json());
  const evidence = reportEvidence(report).filter(e => e.usedForVerdict === true).map(e => {
    const record = corpus.get(e.recordId);
    return { recordId: e.recordId, url: e.url, usedForVerdict: e.usedForVerdict, relation: e.relation, quote: e.quote,
      urlMatchesRecord: record?.url === e.url, quoteInRecord: !!record && !!e.quote && normalizeQuoteText(record.text).includes(normalizeQuoteText(e.quote)) };
  });
  const persisted = !!saved && JSON.stringify(saved) === JSON.stringify(report);
  const pass = res.ok && report.status === "OK" && report.mainVerdict === "FALSZYWE" && persisted &&
    evidence.some(e => e.recordId === c.sourceId && e.urlMatchesRecord && e.quoteInRecord && e.relation === "OBALA");
  return { text: c.text, http: res.status, elapsedMs: Date.now() - started, status: report.status, verdict: report.mainVerdict,
    rule: report.verdicts[0]?.ruleApplied, evidence, answer: reply.shortAnswer?.bodyPl ?? reply.textPl, persisted, pass };
}));
const at = new Date().toISOString();
writeFileSync("eval/results/numeric-mvp-" + at.slice(0, 10) + ".json", JSON.stringify({ at,
  method: "POST /api/chat, dwa osobne zgłoszenia, świeża baza, GET zapisanych raportów i porównanie użytych cytatów oraz adresów z rekordami korpusu",
  reproduce: "node --env-file-if-exists=.env --import tsx eval/institutional-measures-smoke.ts", rows }, null, 2) + "\n");
for (const row of rows) console.log(row.pass, row.verdict, row.evidence.map(e => e.recordId), row.text);
process.exit(rows.every(r => r.pass) ? 0 : 1);
