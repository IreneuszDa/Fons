import { describe, expect, it } from "vitest";
import { comparePair } from "./consistency";

const ch = (channel: "web" | "cli", over: Partial<{ status: string; mainVerdict: string | null; recordIds: string[]; securityEvents: number }> = {}) =>
  ({ channel, replyKind: "verdict", status: "OK", mainVerdict: "FALSZYWE", recordIds: ["r1", "r2"], securityEvents: 0, cacheHit: false, ...over });

describe("consistency comparison", () => {
  it("compares the status, verdict and evidence across web and CLI", () => {
    expect(comparePair(ch("web"), ch("cli"), false)).toEqual([]);
    expect(comparePair(ch("web"), ch("cli", { status: "BLAD" }), false)).toEqual(["status OK ≠ BLAD"]);
    expect(comparePair(ch("web"), ch("cli", { mainVerdict: null, recordIds: [] }), false)).toHaveLength(2);
  });
  it("flags a missing report or security event", () => {
    expect(comparePair(ch("web", { securityEvents: 2 }), ch("cli"), true)).toEqual(["zdarzenie bezpieczeństwa tylko w jednym kanale"]);
    expect(comparePair(ch("web"), ch("cli", { status: "BRAK_RAPORTU" }), false)).toContain("brak raportu w co najmniej jednym kanale");
  });
});
