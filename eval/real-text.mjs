import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/server/config.ts";
import { openDatabase, ensureCorpusLoaded } from "../src/corpus/store.ts";
import { createEngineDeps, verifyInput, PIPELINE_VERSION } from "../src/engine/verify.ts";
import { warmUp } from "../src/engine/retrieval/index.ts";
import { errorRun, isRunCorrect, runFromReport, summarize } from "./metrics.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputArg = process.argv[2];
if (process.argv.length !== 3 || outputArg === "--help") {
  console.log("node --import tsx eval/real-text.mjs <katalog-wyników> — 100 rzeczywistych, płatnych zapytań przez dostawców skonfigurowanych w .env");
  process.exit(outputArg === "--help" ? 0 : 1);
}
const output = resolve(outputArg);
process.chdir(root);
mkdirSync(output, { recursive: true });
const digest = data => createHash("sha256").update(data).digest("hex");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const selectionFile = join(root, "eval/real-text-selection.json");
const selection = readJson(selectionFile).map(([source, id, expectedHash]) => {
  const dataset = readFileSync(source, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const item = dataset.find(row => row.id === id);
  if (!item || item.input.kind !== "text" || item.expected.attack || item.checks?.fixture
    || item.fault || digest(item.input.text) !== expectedHash) throw Error("Wejście niezgodne z manifestem: " + id);
  return {
    id, dataset: basename(source, ".jsonl"), split: item.split, scenario: item.scenario, inputKind: "text",
    inputPreview: item.input.text, expected: item.expected, checks: item.checks ?? {}, tags: item.tags ?? [],
  };
});
if (selection.length !== 100 || new Set(selection.map(c => c.inputPreview)).size !== 100) {
  throw Error("Manifest musi zawierać 100 unikalnych tekstów");
}

function sourceHash() {
  const hash = createHash("sha256");
  const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
  for (const file of files) hash.update(file + "\0").update(readFileSync(file));
  return hash.digest("hex");
}

const config = loadConfig({ dbPath: join(output, "metrics.db"), liveSearch: true });
const db = openDatabase(config.dbPath);
try {
  const corpus = ensureCorpusLoaded(db);
  const deps = createEngineDeps(db, config);
  if (!deps.llm.available || !deps.branches.some(branch => branch.id === "live")) throw Error("Brak konfiguracji dostawcy");
  const file = join(output, "live100.json");
  const previous = existsSync(file) ? readJson(file) : undefined;
  const meta = {
    started: previous?.meta.started ?? new Date().toISOString(), workers: 3, corpus, pipeline: PIPELINE_VERSION,
    main: config.modelMain, fast: config.modelFast, singleKey: deps.singleKey, provider: deps.llm.name,
    codeSha256: sourceHash(), selectionSha256: digest(readFileSync(selectionFile)), warm: await warmUp(deps.branches),
  };
  const previousConfig = previous?.meta;
  if (previousConfig && (previousConfig.corpus.snapshotId !== meta.corpus.snapshotId
    || ["codeSha256", "selectionSha256", "main", "fast", "singleKey", "provider"].some(k => previousConfig[k] !== meta[k]))) {
    throw Error("Wybierz nowy katalog. Zapisano w nim próbę innego kodu, korpusu, konfiguracji lub pytań.");
  }
  console.log(JSON.stringify(meta));
  const key = c => c.dataset + "/" + c.id;
  const rows = new Map((previous?.rows ?? []).map(row => [key(row.case), row]));
  const pending = selection.filter(c => !rows.has(key(c)));
  const recordText = id => deps.store.get(id)?.text;
  function save(complete) {
    const ordered = selection.map(c => rows.get(key(c))).filter(Boolean);
    const datasets = [...new Set(ordered.map(row => row.case.dataset))];
    const metrics = Object.fromEntries(datasets.map(dataset => {
      const outcomes = ordered.filter(row => row.case.dataset === dataset).map(row => ({ case: row.case, runs: [row.run] }));
      return [dataset, summarize(outcomes, { recordText })];
    }));
    const result = {
      meta: { ...meta, complete, ...(complete && { finished: new Date().toISOString() }) },
      total: ordered.length, correct: ordered.filter(row => row.correct).length, metrics, rows: ordered,
    };
    writeFileSync(file + ".tmp", JSON.stringify(result));
    renameSync(file + ".tmp", file);
  }
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const c = pending[cursor++];
      const start = performance.now();
      const receivedAt = new Date().toISOString();
      let run, report;
      const abort = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Przekroczono 180 sekund na rzeczywistą odpowiedź silnika");
          abort.abort(error);
          reject(error);
        }, 180_000);
      });
      try {
        // Tylko wiadomość obywatela trafia do prawdziwego silnika. Klucz służy do późniejszej oceny.
        report = await Promise.race([verifyInput({ channel: "eval", kind: "text", receivedAt, text: c.inputPreview }, deps,
          { signal: abort.signal }), deadline]);
        run = runFromReport(report, { run: 1, latencyMs: performance.now() - start, recordText });
        delete report.token;
      } catch (error) {
        run = errorRun(1, performance.now() - start, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
      }
      const correct = isRunCorrect(c, run);
      rows.set(key(c), { case: c, receivedAt, run, report, correct });
      save(false);
      console.log(rows.size, c.dataset, c.id, run.status, run.mainVerdict, correct, run.costUsd);
    }
  }
  await Promise.all(Array.from({ length: meta.workers }, worker));
  save(true);
} finally {
  db.close();
}
