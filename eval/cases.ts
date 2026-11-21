/**
 * Loading and validating evaluation cases (eval/cases/*.jsonl).
 *
 * The contract type is EvalCase from src/shared/contracts.ts. Cases may carry two optional,
 * eval-local fields that the contract does not have (reported to the orchestrator):
 *  - tags:   free labels such as "negation", "outdated", "wrong_context";
 *  - checks: soft checks reported separately (they never change verdict accuracy):
 *      fixture         — file in eval/fixtures/pages served by the fetch stub for this case's URL,
 *      expectConflict  — scenario C: the main claim verdict should carry a `conflicting` block,
 *      expectWarnings  — scenario I: at least one of these report warning kinds is expected,
 *      repeatGroup     — scenario H: cases that are paraphrases of one another (one moderator case).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvalCase } from "../src/shared/contracts";

export const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(EVAL_DIR, "cases");
export const PAGES_DIR = join(EVAL_DIR, "fixtures", "pages");
export const BENIGN_DIR = join(EVAL_DIR, "fixtures", "benign");
export const RESULTS_DIR = join(EVAL_DIR, "results");

/** Host whose pages are served from eval/fixtures/pages by the fetch stub. */
export const FIXTURE_HOST = "fixture.prawdowid.test";

export const CaseChecks = z.object({
  fixture: z.string().optional(),
  expectConflict: z.boolean().optional(),
  expectWarnings: z.array(z.string()).optional(),
  repeatGroup: z.string().optional(),
});

export const EvalCaseX = EvalCase.extend({
  tags: z.array(z.string()).optional(),
  checks: CaseChecks.optional(),
});
export type EvalCaseX = z.infer<typeof EvalCaseX>;

export type Suite = "main" | "redteam" | "demo";

export const SUITE_FILES: Record<Suite, string[]> = {
  main: ["dev.jsonl", "heldout.jsonl"],
  redteam: ["redteam.jsonl"],
  demo: ["demo.jsonl"],
};

export function parseCasesJsonl(text: string, source = "<jsonl>"): EvalCaseX[] {
  const out: EvalCaseX[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${source}:${i + 1}: niepoprawny JSON`);
    }
    const parsed = EvalCaseX.safeParse(raw);
    if (!parsed.success) throw new Error(`${source}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    out.push(parsed.data);
  });
  return out;
}

export function loadCaseFile(path: string): EvalCaseX[] {
  return parseCasesJsonl(readFileSync(path, "utf8"), path);
}

/** Main suite = dev.jsonl + heldout.jsonl; red team = redteam.jsonl; demo = demo.jsonl (pitch showcase, ordered as a story). */
export function loadSuite(suite: Suite, dir = CASES_DIR): EvalCaseX[] {
  return SUITE_FILES[suite].flatMap((f) => loadCaseFile(join(dir, f)));
}

export function loadAllCases(dir = CASES_DIR): EvalCaseX[] {
  return [...loadSuite("main", dir), ...loadSuite("redteam", dir), ...loadSuite("demo", dir)];
}

/** Expected input mode of a case (contract default: "claim"). */
export function expectedInputMode(c: Pick<EvalCaseX, "expected">): "claim" | "question_yesno" | "question_open" {
  return c.expected.inputMode ?? (c.expected.answerContains?.length ? "question_open" : "claim");
}

export function selectCases(all: EvalCaseX[], opts: { split: "dev" | "heldout" | "all"; limit?: number; ids?: string[] }): EvalCaseX[] {
  let picked = opts.split === "all" ? all : all.filter((c) => c.split === opts.split);
  if (opts.ids) {
    const want = new Set(opts.ids);
    picked = picked.filter((c) => want.has(c.id));
  }
  return opts.limit !== undefined ? picked.slice(0, opts.limit) : picked;
}

/** Fixture file name for a URL: explicit `checks.fixture`, or the path on the fixture host. */
export function fixtureFileFor(url: string, c?: Pick<EvalCaseX, "checks">): string | undefined {
  if (c?.checks?.fixture) return c.checks.fixture;
  try {
    const u = new URL(url);
    if (u.hostname !== FIXTURE_HOST) return undefined;
    const name = u.pathname.replace(/^\/+/, "");
    return /^[\w.-]+\.html$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

export function fixturePath(name: string): string {
  const p = resolve(PAGES_DIR, name);
  if (!p.startsWith(resolve(PAGES_DIR))) throw new Error("fixture path escapes fixtures dir");
  return p;
}

export function loadBenignTexts(dir = BENIGN_DIR): { id: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => ({ id: f, text: readFileSync(join(dir, f), "utf8") }));
}
