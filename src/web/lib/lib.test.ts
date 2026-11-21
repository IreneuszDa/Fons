import { describe, expect, it } from "vitest";
import { VERDICT_LABEL_PL as CONTRACT_LABELS, type ConversationReply, type EvidenceItem } from "../../shared/contracts";
import { countLabel, formatDate, formatDuration, hostOf, paragraphs, plural } from "./format";
import { claimRows, conflictSides, groupEvidence, replyView, statusOf, VERDICT_LABEL_PL, VERDICT_TONE } from "./report";
import { resultPathFor, safeUrl } from "./safeUrl";

describe("safeUrl", () => {
  it("accepts http and https", () => {
    expect(safeUrl("https://www.gov.pl/web/dyplomacja")).toBe("https://www.gov.pl/web/dyplomacja");
    expect(safeUrl(" http://example.org ")).toBe("http://example.org/");
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "/relative/path",
    "//evil.example/x",
    "https://gov.pl@evil.example/",
    "vbscript:msgbox(1)",
    "",
  ])("rejects %s", (u) => {
    expect(safeUrl(u)).toBeNull();
  });
  it("rejects non-strings", () => {
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});

describe("resultPathFor", () => {
  it("builds /w/:token from a token or a resultUrl, nothing else", () => {
    expect(resultPathFor("abcDEF123_-xyz")).toBe("/w/abcDEF123_-xyz");
    expect(resultPathFor(undefined, "https://fons.example/w/abcDEF123456")).toBe("/w/abcDEF123456");
    expect(resultPathFor(undefined, "javascript:alert(1)")).toBeNull();
    expect(resultPathFor(undefined, "https://evil.example/other/abcDEF123456")).toBeNull();
    expect(resultPathFor("bad token with spaces")).toBeNull();
  });
});

describe("format", () => {
  it("formats Polish dates and unknown dates", () => {
    expect(formatDate("2026-11-21T10:00:00Z")).toBe("21 listopada 2026");
    expect(formatDate(null)).toBe("data nieznana");
    expect(formatDate("not a date", "brak")).toBe("brak");
  });
  it("pluralises in Polish", () => {
    expect(plural(1, "źródło", "źródła", "źródeł")).toBe("źródło");
    expect(plural(3, "źródło", "źródła", "źródeł")).toBe("źródła");
    expect(plural(5, "źródło", "źródła", "źródeł")).toBe("źródeł");
    expect(plural(12, "źródło", "źródła", "źródeł")).toBe("źródeł");
    expect(plural(22, "źródło", "źródła", "źródeł")).toBe("źródła");
    expect(countLabel(0, "źródło", "źródła", "źródeł")).toBe("0 źródeł");
  });
  it("helpers", () => {
    expect(hostOf("https://www.gov.pl/a")).toBe("www.gov.pl");
    expect(hostOf("nope")).toBe("");
    expect(paragraphs("a\n\n b \n")).toEqual(["a", "b"]);
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(12345)).toMatch(/^12,3 s$/);
  });
});

const item = (over: Partial<EvidenceItem>): EvidenceItem => ({
  recordId: "r",
  title: "t",
  publisher: "p",
  publishedAt: null,
  fetchedAt: "2026-11-20T00:00:00Z",
  url: "https://example.org",
  quote: "q",
  relation: "WSPIERA",
  aspect: "sedno",
  sourceType: "pierwotne",
  level: 1,
  role: "tresc",
  group: "wspierajace",
  ...over,
});

describe("report helpers", () => {
  it("keeps the local verdict labels identical to contracts.ts", () => {
    expect(VERDICT_LABEL_PL).toEqual(CONTRACT_LABELS);
  });
  it("gives every verdict a distinct tone", () => {
    expect(new Set(Object.values(VERDICT_TONE)).size).toBe(5);
  });
  it("groups evidence", () => {
    const g = groupEvidence([item({ recordId: "a" }), item({ recordId: "b", group: "obalajace" }), item({ recordId: "c", group: "kontekst" })]);
    expect(g.wspierajace.map((e) => e.recordId)).toEqual(["a"]);
    expect(g.obalajace.map((e) => e.recordId)).toEqual(["b"]);
    expect(g.kontekst.map((e) => e.recordId)).toEqual(["c"]);
  });
  it("resolves conflict sides from the claim's own evidence", () => {
    const base = { claimId: "c1", verdict: "BRAK_DOWODOW" as const, ruleApplied: 5, reasonPl: "", strength: {} as never };
    expect(conflictSides({ ...base, evidence: [] })).toBeNull();
    const sides = conflictSides({
      ...base,
      conflicting: { supporting: ["a"], refuting: ["b", "missing"] },
      evidence: [item({ recordId: "a" }), item({ recordId: "b", group: "obalajace" })],
    });
    expect(sides?.supporting.map((e) => e.recordId)).toEqual(["a"]);
    expect(sides?.refuting.map((e) => e.recordId)).toEqual(["b"]);
  });
  it("never renders a technical status as a verdict", () => {
    const r = (over: Partial<ConversationReply>): ConversationReply => ({ kind: "status", textPl: "x", quickReplies: [], ...over });
    expect(replyView(r({ kind: "status" }))).toBe("status");
    expect(replyView(r({ kind: "rate_limited" }))).toBe("status");
    expect(replyView(r({ kind: "help" }))).toBe("text");
    // "verdict" without an OK report is still a status
    expect(replyView(r({ kind: "verdict" }))).toBe("status");
    expect(replyView(r({ kind: "verdict", report: { status: "NIEPELNE", mainVerdict: null } as never }))).toBe("status");
    expect(replyView(r({ kind: "verdict", report: { status: "OK", mainVerdict: "FALSZYWE" } as never }))).toBe("verdict");
    expect(statusOf(r({ kind: "rate_limited" }))).toBe("RATE_LIMITED");
    expect(statusOf(r({ report: { status: "DOPRECYZUJ" } as never }))).toBe("DOPRECYZUJ");
    expect(statusOf(r({}))).toBe("GENERIC");
  });
  it("orders claims main-first", () => {
    const rows = claimRows({
      claims: [
        { id: "c1", text: "side", isMain: false },
        { id: "c2", text: "main", isMain: true },
      ],
      verdicts: [{ claimId: "c1" }, { claimId: "c2" }],
    } as never);
    expect(rows.map((r) => r.text)).toEqual(["main", "side"]);
  });
});
