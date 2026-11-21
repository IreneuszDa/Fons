import { describe, expect, it } from "vitest";
import { CatalogSource, ConversationReply, Verdict } from "../../shared/contracts";
import sources from "./sources.json";
import { fixtureChat, fixtureReport, FIXTURE_REPLIES } from "./index";

describe("fixtures conform to contracts", () => {
  it.each(Object.entries(FIXTURE_REPLIES))("%s is a valid ConversationReply", (_name, reply) => {
    const parsed = ConversationReply.safeParse(reply);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
  });

  it("sources.json catalog entries are valid CatalogSource", () => {
    for (const s of sources.catalog) expect(CatalogSource.safeParse(s).success).toBe(true);
  });

  it("covers every verdict, a NIEPELNE status, an injection warning and conflicting sources", () => {
    const replies = Object.values(FIXTURE_REPLIES);
    const verdicts = new Set(replies.map((r) => r.report?.mainVerdict).filter(Boolean));
    expect([...verdicts].sort()).toEqual([...Verdict.options].sort());
    expect(replies.some((r) => r.kind === "status" && r.report?.status === "NIEPELNE" && r.report.mainVerdict === null)).toBe(true);
    expect(replies.some((r) => r.report?.warnings.some((w) => w.kind === "injection_detected"))).toBe(true);
    expect(replies.some((r) => r.report?.verdicts.some((v) => v.conflicting && v.conflicting.supporting.length && v.conflicting.refuting.length))).toBe(true);
  });
});

describe("answer fixtures", () => {
  it("has an answered open question and a no-answer case", () => {
    const a = FIXTURE_REPLIES.odpowiedz!;
    expect(a.kind).toBe("answer");
    expect(a.report?.inputMode).toBe("question_open");
    expect(a.report?.answer?.evidence.length).toBeGreaterThan(0);
    expect(a.report!.answer!.answerPl).toContain(a.report!.answer!.evidence[0]!.quote); // answer built from the quote
    const n = FIXTURE_REPLIES.brakOdpowiedzi!;
    expect(n.report?.inputMode).toBe("question_open");
    expect(n.report?.answer).toBeUndefined();
    expect(n.report?.status).toBe("OK");
  });
  it("routes questions to the answer fixtures", async () => {
    expect((await fixtureChat({ text: "Kiedy Szwecja dołączyła do NATO?" })).kind).toBe("answer");
    expect((await fixtureChat({ text: "Kto jest prezydentem Marsa?" })).report?.answer).toBeUndefined();
  });
});

describe("fixture backend", () => {
  it("maps keywords to fixtures", async () => {
    expect((await fixtureChat({ text: "Inflacja wynosi 18%" })).report?.mainVerdict).toBe("WPROWADZAJACE");
    expect((await fixtureChat({ text: "https://example.net/x" })).report?.mainVerdict).toBe("FALSZYWE");
    expect((await fixtureChat({ text: "awaria" })).kind).toBe("status");
    expect((await fixtureChat({ action: "delete" })).kind).toBe("confirm_delete");
  });
  it("finds reports by token and returns null for unknown tokens", async () => {
    const token = FIXTURE_REPLIES.potwierdzone!.report!.token;
    expect((await fixtureReport(token))?.mainVerdict).toBe("POTWIERDZONE");
    expect(await fixtureReport("nieznany")).toBeNull();
  });
});
