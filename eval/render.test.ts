import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecordTexts } from "./render";

describe("loadRecordTexts (eval:render without a database)", () => {
  it("maps record ids to texts and skips broken lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "fons-render-"));
    writeFileSync(join(dir, "a.jsonl"), '{"id":"nato:1","text":"Sweden joined NATO."}\nnot json\n{"id":"x"}\n');
    const m = loadRecordTexts(dir);
    expect(m.get("nato:1")).toBe("Sweden joined NATO.");
    expect(m.size).toBe(1);
  });

  it("reads the committed corpus (so citation correctness is not reported as 0%)", () => {
    expect(loadRecordTexts().size).toBeGreaterThan(1000);
  });
});
