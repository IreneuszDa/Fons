/** Live acceptance run through the public HTTP handlers. No fixture pages and no production user database. */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDemoBridge } from "../integrations/chatloom/demo";
import { createCorpusStore } from "../src/corpus/store";
import { createApp } from "../src/server/app";
import { verifyChain } from "../src/server/audit";
import { loadConfig } from "../src/server/config";
import { buildProductionContext, openServerDatabase } from "../src/server/wiring";
import { ConversationReply, VerdictReport, reportEvidence } from "../src/shared/contracts";
import { CASES_DIR, RESULTS_DIR, loadCaseFile, type EvalCaseX } from "./cases";
import { evidenceChain } from "./consistency";
import { hasLlmKey, inboundTextFor, isoStamp, NO_KEY_MESSAGE, withTimeout } from "./harness";
import { errorRun, isRunCorrect, runFromReport, summarize, type CaseOutcome } from "./metrics";
import { gitProvenance } from "./provenance";

// Fixed public sample, chosen before the run. Sources and labels are never passed to verification.
const sample = [
  "A01", "A06", "A08", "A10", "A13", "A15", "A19", "A22", "N01", "N02",
  "B01", "B02", "B04", "B08", "C01", "C02", "D01", "D02", "D04", "D06",
  "O01", "O02", "O04", "G01", "G02", "H01", "H02", "P05", "P07", "L05",
];

function sourceDigest(): string {
  const hash = createHash("sha256");
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (/\.(?:ts|tsx)$/u.test(name) && !name.includes(".test.")) hash.update(name + "\0").update(readFileSync(name));
    }
  };
  visit("src");
  return hash.update(readFileSync("integrations/chatloom/demo.ts")).update(readFileSync("eval/acceptance.ts")).digest("hex");
}

async function main() {
  const secret = randomBytes(32).toString("hex");
  const cfg = loadConfig({ dbPath: ":memory:", usersPath: undefined, alertWebhookUrl: undefined,
    chatloomWebhookSecret: secret, publicBaseUrl: "http://localhost", rateLimitPerMinute: 1000,
    dailyTokenBudget: 6_000_000, ipDailyTokenShare: 1 });
  if (!hasLlmKey(cfg)) throw new Error(NO_KEY_MESSAGE);
  const file = join(CASES_DIR, "dev.jsonl");
  const pool = loadCaseFile(file);
  const cases = sample.map(id => {
    const c = pool.find(item => item.id === id);
    if (!c) throw new Error("Nie znaleziono przypadku " + id);
    return c;
  });
  const db = openServerDatabase(cfg);
  try {
    const ctx = buildProductionContext(cfg, db);
    const app = createApp(ctx);
    const store = createCorpusStore(db);
    const recordText = (id: string) => store.get(id)?.text;
    const started = new Date();
    const codeSha256 = sourceDigest();
    const verify = async (c: EvalCaseX) => {
      const text = inboundTextFor(c);
      const start = performance.now();
      let report: VerdictReport | undefined;
      let error = "";
      let webAnswer = "";
      let persisted = false;
      let audit = false;
      try {
        const signal = AbortSignal.timeout(180_000);
        const response = await withTimeout(Promise.resolve(app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal })), 181_000);
        if (!response.ok) throw new Error("HTTP " + response.status);
        const reply = ConversationReply.parse((await response.json()).reply);
        webAnswer = reply.shortAnswer?.bodyPl ?? reply.textPl;
        report = reply.report;
        if (!report) throw new Error("Brak raportu: " + reply.kind);
        const saved = await app.request("/api/report/" + report.token);
        const stored = saved.ok ? VerdictReport.parse(await saved.json()) : undefined;
        persisted = !!stored && JSON.stringify(stored) === JSON.stringify(report);
        const row = db.prepare("SELECT verdict, status, record_ids_json, input_masked, created_at FROM runs WHERE request_id=? AND channel='web'").get(report.id) as
          { verdict: string | null; status: string; record_ids_json: string; input_masked: string; created_at: string } | undefined;
        audit = !!row && !!report.inputEchoMasked && row.input_masked === report.inputEchoMasked &&
          Number.isFinite(Date.parse(row.created_at)) && row.verdict === report.mainVerdict &&
          row.status === report.status && JSON.stringify(JSON.parse(row.record_ids_json).sort()) === JSON.stringify(reportEvidence(report).map(e => e.recordId).sort());
      } catch (e) {
        error = e instanceof Error ? e.message : "Błąd żądania";
      }
      const latencyMs = Math.round(performance.now() - start);
      const info = { ...c, inputKind: c.input.kind };
      const run = report ? runFromReport(report, { run: 1, latencyMs, recordText }) : errorRun(1, latencyMs, error);
      const correct = isRunCorrect(info, run);
      console.error(c.id, run.status, run.mainVerdict ?? "-", correct ? "zgodny" : "rozbieżność");
      return { id: c.id, outcome: { case: info, runs: [run] } satisfies CaseOutcome, correct, persisted, audit, error, webAnswer,
        // No bearer tokens or session cookies in the replay artifact.
        report: report && { status: report.status, mainVerdict: report.mainVerdict, claims: report.claims, verdicts: report.verdicts,
          answer: report.answer, questionParts: report.questionParts, summaryPl: report.summaryPl, warnings: report.warnings,
          models: report.models, cacheHit: report.cacheHit, moderatorCase: report.moderatorCase } };
    };
    const rows: Awaited<ReturnType<typeof verify>>[] = [];
    // Separate sessions. Finish the first repeat before sending its paraphrase.
    const pending = cases.filter(c => c.id !== "H02").values();
    const worker = async () => { for (const c of pending) rows.push(await verify(c)); };
    await Promise.all([worker(), worker(), worker()]);
    rows.push(await verify(cases.find(c => c.id === "H02")!));
    rows.sort((a, b) => sample.indexOf(a.id) - sample.indexOf(b.id));
    const channels = [];
    for (const id of ["G01", "G02", "P07", "D01"]) {
      const c = cases.find(x => x.id === id)!;
      const send = createDemoBridge(req => app.fetch(req), secret);
      const reply = await withTimeout(send(inboundTextFor(c)), 180_000);
      const token = /\/w\/([A-Za-z0-9_-]{16,64})/.exec(reply)?.[1];
      const res = token && await app.request("/api/report/" + token);
      const second = res && res.ok ? VerdictReport.parse(await res.json()) : undefined;
      const first = rows.find(r => r.id === id)?.report;
      const logged = second && db.prepare("SELECT 1 FROM runs WHERE request_id=? AND channel='chatloom'").get(second.id);
      channels.push({ id, verdict: second?.mainVerdict, cacheHit: second?.cacheHit, saved: !!logged,
        consistent: !!logged && first?.status === "OK" && second?.status === "OK" && first.mainVerdict === second.mainVerdict &&
          evidenceChain(first) === evidenceChain(second) });
    }
    const [h1, h2] = ["H01","H02"].map(id => rows.find(r => r.id === id)?.report);
    const caseId = h1?.moderatorCase?.caseId;
    const senders = caseId && db.prepare("SELECT COUNT(*) AS n FROM case_senders WHERE case_id=?").get(caseId) as { n: number } | undefined;
    const feedback = !!caseId && h1?.mainVerdict === "BRAK_DOWODOW" && h2?.mainVerdict === "BRAK_DOWODOW" &&
      caseId === h2?.moderatorCase?.caseId && !!senders && senders.n >= 2;
    const result = {
      meta: { startedAt: started.toISOString(), finishedAt: new Date().toISOString(), ...gitProvenance(),
        pipeline: ctx.engine.pipelineVersion, codeSha256, corpusSnapshot: store.snapshotId(), records: store.count(),
        devSha256: createHash("sha256").update(readFileSync(file)).digest("hex"), provider: cfg.llmProvider, main: cfg.modelMain,
        fast: cfg.modelFast, liveSearch: cfg.liveSearch, parallel: 3, sample },
      metrics: summarize(rows.map(row => row.outcome), { recordText }),
      webReportsWithAudit: rows.filter(r => r.persisted && r.audit).length,
      channels, feedback, auditChain: verifyChain(db), correct: rows.filter(r => r.correct).length,
      rows: rows.map(({ outcome, ...r }) => ({ ...r, input: inboundTextFor(outcome.case),
        expected: outcome.case.expected, latencyMs: outcome.runs[0]!.latencyMs, costUsd: outcome.runs[0]!.costUsd })),
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    const path = join(RESULTS_DIR, "acceptance-" + isoStamp(started) + ".json");
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
    console.log(path);
    if (result.webReportsWithAudit !== cases.length || !result.auditChain.ok || !feedback || channels.some(c => !c.consistent)) process.exitCode = 1;
  } finally {
    db.close();
  }
}

await main().catch(e => { console.error(e instanceof Error ? e.message : "Błąd testu"); process.exitCode = 1; });
