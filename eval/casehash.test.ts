import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseFilesFor, compareCaseSets, fingerprintCaseFiles } from "./casehash";
import { HELDOUT_V2_FILE, parseArgs } from "./harness";
import { loadRefreshCases } from "./render";

const line = (id: string) =>
  JSON.stringify({ id, split: "dev", scenario: "X", input: { kind: "text", text: `t ${id}` }, expected: { verdict: null, status: "OK" } });

function dirWith(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "fons-cases-"));
  for (const [f, ids] of Object.entries(files)) writeFileSync(join(dir, f), ids.map(line).join("\n") + "\n");
  return dir;
}

describe("case set fingerprint", () => {
  it("hashes files and lists ids; identical content gives no warning", () => {
    const dir = dirWith({ "a.jsonl": ["A1", "A2"] });
    const fp = fingerprintCaseFiles(["a.jsonl"], dir);
    expect(fp["a.jsonl"]).toMatchObject({ count: 2, ids: ["A1", "A2"] });
    expect(fp["a.jsonl"]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(compareCaseSets(fp, fingerprintCaseFiles(["a.jsonl"], dir))).toEqual([]);
  });

  it("warns with added and removed ids when a case file changed", () => {
    const before = fingerprintCaseFiles(["a.jsonl"], dirWith({ "a.jsonl": ["A1", "A2"] }));
    const after = fingerprintCaseFiles(["a.jsonl"], dirWith({ "a.jsonl": ["A2", "A3"] }));
    const w = compareCaseSets(before, after);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/a\.jsonl.*zmienił się.*usunięte: A1.*dodane: A3/);
  });

  it("warns when the file disappeared; old results without a fingerprint give no warning", () => {
    const before = fingerprintCaseFiles(["a.jsonl"], dirWith({ "a.jsonl": ["A1"] }));
    expect(compareCaseSets(before, {})[0]).toMatch(/nie istnieje/);
    expect(compareCaseSets(undefined, {})).toEqual([]);
  });

  it("chooses the suite files, or the separate case file", () => {
    expect(caseFilesFor("main")).toEqual(["dev.jsonl", "heldout.jsonl"]);
    expect(caseFilesFor("redteam")).toEqual(["redteam.jsonl"]);
    expect(caseFilesFor("main", HELDOUT_V2_FILE)).toEqual([HELDOUT_V2_FILE]);
  });
});

describe("eval:render case pool", () => {
  it("refreshOutcomes source includes heldout-v2.jsonl", () => {
    const dir = dirWith({ "dev.jsonl": ["D1"], "heldout.jsonl": ["H1"], "redteam.jsonl": ["R1"], "demo.jsonl": ["M1"], [HELDOUT_V2_FILE]: ["V2A", "V2B"] });
    expect(loadRefreshCases(dir).map((c) => c.id)).toEqual(["D1", "H1", "R1", "M1", "V2A", "V2B"]);
  });
});

describe("--live flag", () => {
  it("is off by default and set by --live", () => {
    expect(parseArgs([]).live).toBeUndefined();
    expect(parseArgs(["--live"]).live).toBe(true);
    expect(parseArgs(["--split", "heldout-v2", "--live"])).toMatchObject({ live: true, caseFile: HELDOUT_V2_FILE });
  });
});
