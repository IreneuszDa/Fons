/**
 * `npm run eval:render -- eval/results/<file>.json` — rebuilds eval/results/latest.md from a saved run
 * WITHOUT calling any model: case metadata (expected answers, demo flag, order) is refreshed from the current
 * eval/cases/*.jsonl, run records are taken as saved, and the summary is recomputed. Quote checks use the
 * flags stored at run time; citation correctness re-checks evidence quotes against the record texts in
 * data/corpus/*.jsonl (no database needed — records of live snapshots are not in the files and count as missing).
 * Detector false-positive numbers are copied from the saved summary.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/corpus/paths";
import { CASES_DIR, RESULTS_DIR, loadAllCases, loadCaseFile, type EvalCaseX, type Suite } from "./cases";
import { HELDOUT_V2_FILE } from "./harness";
import { summarize, type CaseInfo, type CaseOutcome, type EvalSummary } from "./metrics";
import { caseFilesFor, compareCaseSets, fingerprintCaseFiles } from "./casehash";
import { renderMarkdown, type RunMeta } from "./report";

/** Case pool the refresh reads: suite files plus the separate blind heldout-v2 file. */
export function loadRefreshCases(dir = CASES_DIR): EvalCaseX[] {
  return [...loadAllCases(dir), ...loadCaseFile(join(dir, HELDOUT_V2_FILE))];
}

export function refreshOutcomes(outcomes: CaseOutcome[], cases: EvalCaseX[]): CaseOutcome[] {
  const byId = new Map(cases.map((c, i) => [c.id, { c, i }]));
  return outcomes
    .map((o) => {
      const cur = byId.get(o.case.id)?.c;
      if (!cur) return o;
      const info: CaseInfo = {
        ...o.case,
        expected: cur.expected,
        ...(cur.demo ? { demo: true } : {}),
        inputPreview: [cur.input.text, cur.input.url].filter(Boolean).join(" "),
      };
      return { ...o, case: info };
    })
    .sort((a, b) => (byId.get(a.case.id)?.i ?? 1e9) - (byId.get(b.case.id)?.i ?? 1e9));
}

/** Record id → text, read from the committed corpus files (the same snapshot the runs used). */
export function loadRecordTexts(dir = paths.corpusDir()): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { id?: unknown; text?: unknown };
        if (typeof r.id === "string" && typeof r.text === "string") out.set(r.id, r.text);
      } catch {
        /* a broken line is skipped; its quotes count as missing */
      }
    }
  }
  return out;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("Użycie: npm run eval:render -- eval/results/<plik>.json");
    process.exit(2);
  }
  const saved = JSON.parse(readFileSync(file, "utf8")) as { meta: RunMeta; summary: EvalSummary; outcomes: CaseOutcome[] };
  // the blind held-out v2 file is separate from the suite files, so it is added to the case map explicitly
  const outcomes = refreshOutcomes(saved.outcomes, loadRefreshCases());
  const suite = (saved.meta.suite ?? "main") as Suite;
  const caseFile = saved.meta.split === "heldout-v2" ? HELDOUT_V2_FILE : undefined;
  for (const w of compareCaseSets(saved.meta.caseSet, fingerprintCaseFiles(caseFilesFor(suite, caseFile)))) console.error(`[eval:render] OSTRZEŻENIE: ${w}`);
  if (!saved.meta.caseSet) console.error("[eval:render] uwaga: wynik nie zawiera odcisku plików przypadków (starszy format) — nie można sprawdzić, czy przypadki się zmieniły.");
  const texts = loadRecordTexts();
  const summary = summarize(outcomes, {
    recordText: (id) => texts.get(id),
    ...(saved.summary.falsePositives ? { falsePositives: saved.summary.falsePositives } : {}),
  });
  const md = renderMarkdown(summary, saved.meta);
  writeFileSync(join(RESULTS_DIR, "latest.md"), md);
  console.log(md);
}

if (process.argv[1] && /render\.ts$/.test(process.argv[1])) main();
