/**
 * `npm run eval` — evaluation harness (in-process, offline: live search off, fixture pages stubbed).
 *
 *   npm run eval -- --split dev|heldout|heldout-v2|all --suite main|redteam|demo --runs N --limit K --ids A01,P03 --judge [--live] [--db path]
 *
 * --live  — liveSearch=true (real live search; default is offline). The result file gets the suffix "-live".
 *
 * heldout-v2 — the blind held-out set eval/cases/heldout-v2.jsonl (main suite only; read instead of dev/heldout files).
 *
 * demo    — the pitch showcase (eval/cases/demo.jsonl, all split "dev"), run exactly like main; latest.md gets a demo table.
 * main    — every case goes straight to verifyInput (deps from createEngineDeps), fault passed through.
 * redteam — every case goes through the conversation layer (handleInbound, channel "web") so that side
 *           effects (deleted session, confirmation prompts, moderator cases) and rendered replies can be
 *           checked; the engine underneath is the same verifyInput with the same stubbed deps.
 *           Worst of N runs counts; the computation cache is cleared before each run.
 *
 * Writes eval/results/<iso>.json and eval/results/latest.md. Without an LLM key it stops and prints why.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { ConversationReply, VerdictReport } from "../src/shared/contracts";
import { loadConfig } from "../src/server/config";
import type { EngineDeps } from "../src/engine/verify";
import { RESULTS_DIR, loadBenignTexts, selectCases, type EvalCaseX } from "./cases";
import {
  NO_KEY_MESSAGE,
  clearComputationCache,
  hasLlmKey,
  fakeProviderRequested,
  FAKE_PROVIDER_NOTICE,
  inboundTextFor,
  isoStamp,
  judgeReport,
  loadEvalPool,
  makeFixtureFetch,
  makeInbound,
  newId,
  parseArgs,
  sideEffectsOf,
  splitLabel,
  verifyRequestFor,
  withTimeout,
} from "./harness";
import { errorRun, falsePositiveRate, runFromReport, summarize, type CaseInfo, type CaseOutcome, type RunRecord } from "./metrics";
import { renderMarkdown, type RunMeta } from "./report";
import { displayPath, gitProvenance } from "./provenance";
import { caseFilesFor, fingerprintCaseFiles } from "./casehash";

const CASE_TIMEOUT_MS = 180_000;

function caseInfo(c: EvalCaseX): CaseInfo {
  return {
    id: c.id,
    split: c.split,
    scenario: c.scenario,
    inputKind: c.input.kind,
    expected: c.expected,
    ...(c.demo ? { demo: true } : {}),
    inputPreview: [c.input.text, c.input.url].filter(Boolean).join(" "),
    ...(c.fault ? { fault: c.fault } : {}),
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.checks ? { checks: c.checks } : {}),
  };
}

/** Selected cases + twins of selected attack cases that fall outside the selection (run as reference only). */
function withTwins(selected: EvalCaseX[], pool: EvalCaseX[]): { c: EvalCaseX; referenceOnly: boolean }[] {
  const ids = new Set(selected.map((c) => c.id));
  const byId = new Map(pool.map((c) => [c.id, c]));
  const extra: EvalCaseX[] = [];
  for (const c of selected) {
    const t = c.expected.attack?.twinCaseId;
    if (t && !ids.has(t) && byId.has(t)) {
      ids.add(t);
      extra.push(byId.get(t)!);
    }
  }
  // twins first, so attack runs can be compared with an already measured clean run
  const isTwin = new Set(pool.map((c) => c.expected.attack?.twinCaseId).filter(Boolean) as string[]);
  const ordered = [...extra.map((c) => ({ c, referenceOnly: true })), ...selected.map((c) => ({ c, referenceOnly: false }))];
  return ordered.sort((a, b) => Number(!isTwin.has(a.c.id)) - Number(!isTwin.has(b.c.id)));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg0 = loadConfig();
  if (fakeProviderRequested()) {
    console.error(FAKE_PROVIDER_NOTICE);
  } else if (!hasLlmKey(cfg0)) {
    console.error(NO_KEY_MESSAGE);
    process.exit(2);
  }
  // heavy modules are loaded only after the key check, so a missing key is always reported clearly
  const { createCorpusStore, ensureCorpusLoaded, openDatabase } = await import("../src/corpus/store");
  const { PIPELINE_VERSION, createEngineDeps, verifyInput } = await import("../src/engine/verify");
  const { detectInjection } = await import("../src/security/detector");
  const dbPath = resolve(args.db ?? process.env.EVAL_DB_PATH ?? "var/eval.db");
  // eval is offline by default (live search only with --live); a generous rate limit so that the harness is not throttled
  const cfg = loadConfig({ dbPath, liveSearch: args.live === true, rateLimitPerMinute: 1_000_000 });
  mkdirSync(dirname(dbPath), { recursive: true });

  const startedAt = new Date();
  const db = openDatabase(dbPath);
  const corpus = ensureCorpusLoaded(db);
  const store = createCorpusStore(db);

  const pool = loadEvalPool(args);
  const split = splitLabel(args);
  const selected = selectCases(pool, { split: args.split, limit: args.limit, ...(args.ids ? { ids: args.ids } : {}) });
  const plan = withTwins(selected, pool);

  const deps: EngineDeps = createEngineDeps(db, cfg);
  deps.fetchPage = makeFixtureFetch(deps.fetchPage, pool);

  console.error(
    `[eval] zestaw=${args.suite} podział=${split} przypadki=${selected.length} (+${plan.length - selected.length} bliźniaków) przebiegi=${args.runs} ` +
      `model=${deps.llm.name}/${cfg.modelMain} weryfikator=${deps.verifier.name}${deps.singleKey ? " (jeden klucz)" : ""} korpus=${corpus.records} rekordów`,
  );

  const runs: Map<string, RunRecord[]> = new Map(plan.map((p) => [p.c.id, []]));

  const recordText = (id: string) => store.get(id)?.text;

  if (args.suite === "main" || args.suite === "demo") {
    for (let run = 1; run <= args.runs; run++) {
      for (const { c } of plan) {
        const t0 = performance.now();
        let rec: RunRecord;
        try {
          const report: VerdictReport = await withTimeout(verifyInput(verifyRequestFor(c, new Date()), deps), CASE_TIMEOUT_MS);
          rec = runFromReport(report, { run, latencyMs: performance.now() - t0, recordText });
          if (args.judge) rec.judge = await judgeReport(deps.llm, report);
        } catch (e) {
          rec = errorRun(run, performance.now() - t0, e instanceof Error ? e.message.slice(0, 200) : "error");
        }
        runs.get(c.id)!.push(rec);
        console.error(
          `[eval] ${run}/${args.runs} ${c.id} → ${rec.status} ${rec.mainVerdict ?? "-"} tryb=${rec.inputMode ?? "-"}${rec.answer ? " odpowiedź" : ""} (${Math.round(rec.latencyMs)} ms)`,
        );
      }
    }
  } else {
    const { migrate } = await import("../src/server/db");
    const { buildProductionContext } = await import("../src/server/wiring");
    const { handleInbound } = await import("../src/server/conversation");
    migrate(db);
    const ctx = buildProductionContext(cfg, db);
    // same engine, same stubbed deps; the fault of the current case is passed through
    let currentFault: string | undefined;
    const last: { report?: VerdictReport } = {};
    const lastCost = (): number | undefined => last.report?.costUsd; // function call: no flow narrowing
    ctx.engine = {
      ...ctx.engine,
      verify: async (req) => {
        const report = await verifyInput({ ...req, ...(currentFault ? { fault: currentFault } : {}) }, deps);
        last.report = report;
        return report;
      },
    };
    const web = ctx.channels.get("web");
    const cli = ctx.channels.get("cli");
    for (let run = 1; run <= args.runs; run++) {
      clearComputationCache(db);
      for (const { c } of plan) {
        currentFault = c.fault;
        last.report = undefined;
        const senderId = newId(`evalrt-${c.id}-${run}`);
        const sessionId = newId("evalrt");
        const t0 = performance.now();
        let rec: RunRecord;
        try {
          const reply: ConversationReply = await withTimeout(
            handleInbound(makeInbound({ channel: "web", senderId, sessionId, text: inboundTextFor(c), now: new Date() }), ctx),
            CASE_TIMEOUT_MS,
          );
          const latencyMs = performance.now() - t0;
          const rendered = [web?.render(reply), cli?.render(reply), reply.textPl].filter((s): s is string => !!s);
          const sideEffects = sideEffectsOf(reply, db, sessionId);
          if (reply.report) {
            rec = runFromReport(reply.report, { run, latencyMs, rendered, sideEffects, recordText });
            if (args.judge) rec.judge = await judgeReport(deps.llm, reply.report);
          } else {
            rec = errorRun(run, latencyMs, `reply:${reply.kind}`, { rendered, sideEffects, costUsd: lastCost() ?? 0 });
          }
        } catch (e) {
          rec = errorRun(run, performance.now() - t0, e instanceof Error ? e.message.slice(0, 200) : "error");
        }
        runs.get(c.id)!.push(rec);
        console.error(`[eval] ${run}/${args.runs} ${c.id} → ${rec.status} ${rec.mainVerdict ?? "-"} zdarzenia=${rec.securityEvents} efekty=[${rec.sideEffects.join(",")}]`);
      }
    }
  }

  // reported in file order (execution order puts twins first); the demo table relies on this
  const order = new Map(pool.map((c, i) => [c.id, i]));
  const outcomes: CaseOutcome[] = [...plan]
    .sort((a, b) => (order.get(a.c.id) ?? 0) - (order.get(b.c.id) ?? 0))
    .map(({ c, referenceOnly }) => ({ case: caseInfo(c), runs: runs.get(c.id)!, ...(referenceOnly ? { referenceOnly } : {}) }));

  // detector false positives: every corpus record and every benign fixture text
  const corpusRows = db.prepare("SELECT id, text FROM records").all() as { id: string; text: string }[];
  const falsePositives = {
    corpus: falsePositiveRate(corpusRows, (t) => detectInjection(t, "evidence")),
    benign: falsePositiveRate(loadBenignTexts(), (t) => detectInjection(t, "fetched_page")),
  };

  const summary = summarize(outcomes, { recordText, falsePositives });
  const finishedAt = new Date();
  const meta: RunMeta = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    suite: args.suite,
    split,
    runs: args.runs,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    judge: args.judge,
    live: args.live === true,
    caseSet: fingerprintCaseFiles(caseFilesFor(args.suite, args.caseFile)),
    provider: `${deps.llm.name} (${cfg.modelMain} / ${cfg.modelFast})`,
    verifier: deps.verifier.name,
    singleKey: deps.singleKey,
    verdictMode: deps.verdictMode,
    corpusSnapshot: corpus.snapshotId,
    corpusRecords: corpus.records,
    pipelineVersion: PIPELINE_VERSION,
    dbPath: displayPath(dbPath),
    ...gitProvenance(),
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const md = renderMarkdown(summary, meta);
  const jsonPath = join(RESULTS_DIR, `${isoStamp(startedAt)}-${args.suite}-${split}${args.live ? "-live" : ""}.json`);
  writeFileSync(jsonPath, JSON.stringify({ meta, summary, outcomes }, null, 2));
  writeFileSync(join(RESULTS_DIR, "latest.md"), md);
  console.log(md);
  console.error(`[eval] zapisano ${jsonPath} i ${join(RESULTS_DIR, "latest.md")}`);
  db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[eval] błąd: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
