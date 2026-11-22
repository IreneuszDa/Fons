import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCorpusStore, ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { whyText } from "../server/conversation/templates";
import type { LlmProvider } from "../shared/contracts";
import { createDemagogTopicIndex } from "./retrieval/demagog-topic";
import { verifyInput, type EngineDeps } from "./verify";

const now = new Date("2026-11-22T10:00:00Z");
const url = "https://demagog.org.pl/wypowiedzi/transport-publiczny/";
const thesis = "Jedynie Wrocław oferował darmowe przejazdy dla 65-latków.";
const question = "Czy Demagog sprawdzał, czy " + thesis;
const answer = (text: string, deps: EngineDeps) => verifyInput({
  kind: "text", channel: "web", text, receivedAt: "2026-11-21T10:00:00Z",
}, deps);
const review = (claim: string, label: string) => Response.json({ claims: [{ text: claim,
  claimReview: [{ url, textualRating: label }] }] });

describe("raport o publikacji w bieżącym indeksie Google", () => {
  const db = openDatabase(":memory:");
  const llm: LlmProvider = { name: "offline", family: "test", available: false, async complete() { throw Error("unexpected model call"); } };
  let deps: EngineDeps;
  beforeAll(() => {
    ensureCorpusLoaded(db);
    deps = { db, store: createCorpusStore(db), llm, verifier: llm, singleKey: true, branches: [],
      fetchPage: async () => { throw Error("unexpected page request"); }, now: () => now, verdictMode: "model_proposed" };
  });
  afterAll(() => db.close());

  it("przy każdym sprawdzeniu korzysta z bieżącej oceny i odróżnia odmowę dostępu od pustej odpowiedzi", async () => {
    const fetchIndex = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(review(thesis, "Fałsz"))
      .mockResolvedValueOnce(review(thesis, "Przeważnie fałsz"))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockImplementation(async () => Response.json({}));
    const engine = { ...deps, demagogTopicIndex: createDemagogTopicIndex("key", fetchIndex) };
    for (const label of ["Fałsz", "Przeważnie fałsz"]) {
      const hit = await answer(question, engine);
      expect(hit).toMatchObject({ status: "OK", verdictMode: "rules", mainVerdict: "FALSZYWE", models: [] });
      expect(hit.answer?.answerPl).toContain(label);
      expect(hit.verdicts[0]?.evidence).toMatchObject([{ url, quote: thesis, ratingRaw: label }]);
      expect(hit.sourceActivity?.branches.map(b => b.id)).toEqual(["google_claimreview"]);
    }
    const unavailable = await answer(question, engine);
    expect(unavailable).toMatchObject({ status: "NIEPELNE", summaryPl: "Nie mogę teraz sprawdzić indeksu Google z powodu błędu dostępu.", mainVerdict: null });
    const empty = await answer(question, engine);
    expect(empty.status).toBe("OK");
    expect(empty.summaryPl).toContain("Nie znalazłem w indeksie");
  });

  it("dla podobnej publikacji podaje moment sprawdzenia i prosi o potwierdzenie właściwej tezy", async () => {
    const index = createDemagogTopicIndex("key", async () => review("W 2030 roku w Polsce ma zostać wprowadzone euro.", "Fałsz"));
    const report = await answer("Czy Demagog sprawdzał, czy w 2026 roku w Polsce ma zostać wprowadzone euro?", { ...deps, demagogTopicIndex: index });
    expect(report).toMatchObject({ status: "OK", verdictMode: "rules", mainVerdict: null, verdicts: [], models: [] });
    expect(report.answer?.evidence[0]?.fetchedAt).toBe(now.toISOString());
    const why = whyText(report);
    expect(why).toContain("podobny temat");
    expect(why).not.toContain("dosłowny cytat");
  });
});
