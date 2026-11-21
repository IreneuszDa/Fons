/** Validates the blind held-out set v2 (eval/cases/heldout-v2.jsonl): schema, coverage, twins, canaries, fixtures, CLI. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASES_DIR, expectedInputMode, fixtureFileFor, fixturePath, loadCaseFile, loadSuite, selectCases, type EvalCaseX } from "./cases";
import { HELDOUT_V2_FILE, loadEvalPool, parseArgs, splitLabel } from "./harness";
import { canaryKey } from "./metrics";

const v2 = loadCaseFile(join(CASES_DIR, HELDOUT_V2_FILE));
const others = [...loadSuite("main"), ...loadSuite("redteam"), ...loadSuite("demo")];
const byId = new Map(v2.map((c) => [c.id, c]));
const v = (c: EvalCaseX) => c.expected.verdict;
const has = (c: EvalCaseX, tag: string) => c.tags?.includes(tag) ?? false;
const count = (f: (c: EvalCaseX) => boolean) => v2.filter(f).length;

describe("heldout-v2: schema and identity", () => {
  it("parses as EvalCase, ≥ 45 cases, all split heldout, ids unique and disjoint from the other suites", () => {
    expect(v2.length).toBeGreaterThanOrEqual(45);
    for (const c of v2) {
      expect(c.split, c.id).toBe("heldout");
      expect(c.id, c.id).toMatch(/^V2-[A-Z]\d\d$/);
    }
    expect(new Set(v2.map((c) => c.id)).size).toBe(v2.length);
    const otherIds = new Set(others.map((c) => c.id));
    for (const c of v2) expect(otherIds.has(c.id), c.id).toBe(false);
  });

  it("no input text duplicates a case of the other suites (blind set, not a copy)", () => {
    const norm = (s?: string) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const seen = new Set(others.map((c) => norm(c.input.text)).filter((t) => t.length > 20));
    for (const c of v2) if (norm(c.input.text).length > 20) expect(seen.has(norm(c.input.text)), c.id).toBe(false);
  });

  it("every case has notes with the real-world basis", () => {
    for (const c of v2) expect((c.notes ?? "").length, c.id).toBeGreaterThan(15);
  });
});

describe("heldout-v2: coverage mirrors the jury's reference set", () => {
  it("has every verdict class, several cases each", () => {
    expect(count((c) => v(c) === "POTWIERDZONE")).toBeGreaterThanOrEqual(6);
    expect(count((c) => v(c) === "FALSZYWE")).toBeGreaterThanOrEqual(6);
    expect(count((c) => v(c) === "WPROWADZAJACE")).toBeGreaterThanOrEqual(6);
    expect(count((c) => v(c) === "WPROWADZAJACE" && has(c, "outdated"))).toBeGreaterThanOrEqual(3);
    expect(count((c) => v(c) === "WPROWADZAJACE" && has(c, "wrong_context"))).toBeGreaterThanOrEqual(3);
    expect(count((c) => c.scenario === "D" && v(c) === "BRAK_DOWODOW")).toBeGreaterThanOrEqual(5);
    expect(count((c) => c.scenario === "C" && v(c) === "BRAK_DOWODOW" && c.checks?.expectConflict === true)).toBeGreaterThanOrEqual(3);
    expect(count((c) => v(c) === "NIE_PODLEGA")).toBeGreaterThanOrEqual(4);
    expect(count((c) => has(c, "negation"))).toBeGreaterThanOrEqual(3);
  });

  it("status-only and open-question cases carry no verdict; other cases do", () => {
    for (const c of v2) {
      const open = expectedInputMode(c) === "question_open";
      if (open) {
        expect(c.expected.answerContains?.length, c.id).toBeGreaterThan(0);
        for (const f of c.expected.answerContains!) expect(f.trim().length, c.id).toBeGreaterThanOrEqual(4);
      } else expect(c.expected.answerContains, c.id).toBeUndefined();
      if (c.expected.status !== "OK" || open) expect(v(c), c.id).toBeNull();
      else expect(v(c), c.id).not.toBeNull();
    }
  });

  it("politician/official questions: yes/no and open, each verified against an official page with a date", () => {
    const qs = v2.filter((c) => has(c, "politician"));
    expect(qs.length).toBeGreaterThanOrEqual(8);
    expect(qs.filter((c) => expectedInputMode(c) === "question_yesno").length).toBeGreaterThanOrEqual(3);
    expect(qs.filter((c) => expectedInputMode(c) === "question_open").length).toBeGreaterThanOrEqual(3);
    for (const c of qs) {
      expect(c.notes, c.id).toMatch(/Sprawdzone 20\d\d-\d\d-\d\d/);
      expect(c.notes, c.id).toMatch(/https:\/\/[^ ]*(gov\.pl|senat\.gov\.pl|prezydent\.pl|nato\.int|europa\.eu)/);
    }
  });

  it("link cases: real official URLs served from snapshots, disinformation pages on the fixture host", () => {
    const links = v2.filter((c) => has(c, "link"));
    expect(links.length).toBeGreaterThanOrEqual(6);
    const official = links.filter((c) => has(c, "official_link"));
    const disinfo = links.filter((c) => has(c, "disinfo_page"));
    expect(official.length).toBeGreaterThanOrEqual(3);
    expect(disinfo.length).toBeGreaterThanOrEqual(2);
    for (const c of official) {
      expect(new URL(c.input.url!).hostname, c.id).toMatch(/(^|\.)(gov\.pl|prezydent\.pl|nato\.int|europa\.eu)$/);
      expect(c.checks?.fixture, c.id).toMatch(/^official_v2_/);
    }
    for (const c of disinfo) {
      expect(new URL(c.input.url!).hostname, c.id).toBe("fixture.prawdowid.test");
      expect(v(c), c.id).toBe("FALSZYWE");
    }
  });

  it("has 3 J fault cases using known fault names (required component → no verdict, optional → verdict stays)", () => {
    const j = v2.filter((c) => c.scenario === "J");
    expect(j).toHaveLength(3);
    for (const c of j) {
      expect(["llm_down", "corpus_down", "live_down", "ocr_down"]).toContain(c.fault);
      if (c.fault === "live_down") expect(c.expected.status, c.id).toBe("OK");
      else expect(c.expected.status, c.id).not.toBe("OK");
    }
  });

  it("repeat groups (H) have at least two cases each", () => {
    const groups = new Map<string, number>();
    for (const c of v2) if (c.checks?.repeatGroup) groups.set(c.checks.repeatGroup, (groups.get(c.checks.repeatGroup) ?? 0) + 1);
    expect(groups.size).toBeGreaterThanOrEqual(1);
    for (const [g, n] of groups) expect(n, g).toBeGreaterThanOrEqual(2);
  });
});

describe("heldout-v2: prompt injection", () => {
  const attacks = v2.filter((c) => c.expected.attack);

  it("has 6 attacks, each with a clean twin in this file and the twin's verdict", () => {
    expect(attacks).toHaveLength(6);
    for (const a of attacks) {
      expect(a.scenario, a.id).toBe("E");
      const twin = byId.get(a.expected.attack!.twinCaseId ?? "");
      expect(twin, a.id).toBeDefined();
      expect(twin!.expected.attack, `${a.id} twin must be clean`).toBeUndefined();
      expect(v(a), a.id).toBe(v(twin!));
    }
    expect(attacks.filter((a) => a.expected.attack!.canary).length).toBeGreaterThanOrEqual(4);
    expect(attacks.filter((a) => a.input.kind === "url").length).toBeGreaterThanOrEqual(2);
  });

  it("canaries are unique across all suites and never literally in the input or fixture page", () => {
    const all = [...others, ...v2].filter((c) => c.expected.attack?.canary);
    const keys = all.map((c) => canaryKey(c.expected.attack!.canary!));
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of attacks.filter((a) => a.expected.attack!.canary)) {
      const key = canaryKey(c.expected.attack!.canary!);
      const page = c.input.url ? readFileSync(fixturePath(fixtureFileFor(c.input.url, c)!), "utf8") : "";
      expect(canaryKey(`${c.input.text ?? ""}\n${page}`).includes(key), `${c.id} canary appears literally`).toBe(false);
    }
  });
});

describe("heldout-v2: fixtures", () => {
  it("every URL case resolves to an existing fixture page (no network in eval)", () => {
    for (const c of v2.filter((x) => x.input.kind === "url")) {
      const f = fixtureFileFor(c.input.url!, c);
      expect(f, c.id).toBeDefined();
      expect(existsSync(fixturePath(f!)), `${c.id} → ${f}`).toBe(true);
    }
  });
});

describe("heldout-v2: CLI selection", () => {
  it("--split heldout-v2 reads the separate file and labels the run", () => {
    const args = parseArgs(["--split", "heldout-v2"]);
    expect(args).toMatchObject({ split: "heldout", caseFile: HELDOUT_V2_FILE });
    expect(splitLabel(args)).toBe("heldout-v2");
    const pool = loadEvalPool(args);
    expect(pool.map((c) => c.id)).toEqual(v2.map((c) => c.id));
    expect(selectCases(pool, { split: args.split })).toHaveLength(v2.length);
    expect(() => loadEvalPool({ ...args, suite: "redteam" })).toThrow(/suite main/);
  });

  it("other splits keep the suite files", () => {
    const args = parseArgs(["--split=heldout-v2", "--split", "heldout"]);
    expect(args.caseFile).toBeUndefined();
    expect(splitLabel(args)).toBe("heldout");
    expect(loadEvalPool(args).some((c) => c.id.startsWith("V2-"))).toBe(false);
  });
});
