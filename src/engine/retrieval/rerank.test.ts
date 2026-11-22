import { describe, expect, it } from "vitest";
import type { CorpusRecord, EvidenceCandidate } from "../../shared/contracts";
import { lexicalRerank, queryStems, scoreCandidates } from "./rerank";
import { readCorpus } from "../../corpus/files";
import { asksForElectionWinner, electionResultStage } from "../election-result";
import { mobileEVariant } from "./stem";

function rec(id: string, title: string, text: string, extra: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id,
    sourceId: "s",
    url: `https://example.org/${id}`,
    title,
    publisher: "P",
    publishedAt: "2024-01-01",
    fetchedAt: "2025-01-01",
    lang: "pl",
    text,
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: "g",
    licence: "CC0",
    topics: [],
    origin: "corpus",
    ...extra,
  };
}

const cands = (ids: string[]): EvidenceCandidate[] => ids.map((id, i) => ({ recordId: id, score: 1 / (i + 1), via: "bm25" }));

describe("lexical rerank", () => {
  const records = new Map(
    [
      rec("noise", "Szwecja wysyła strażaków do Polski", "Szwecja wysłała zastępy strażackie do walki z powodzią."),
      rec("eu", "Unia Europejska: Szwecja", "Szwecja jest państwem członkowskim UE od 1995 roku."),
      rec("gold", "NATO member countries", "Finland 2023\nSweden 2024\nPoland 1999"),
    ].map((r) => [r.id, r]),
  );

  it("must-have terms with language alternatives lift the record that has all of them", () => {
    const ranked = lexicalRerank(cands(["noise", "eu", "gold"]), records, {
      queryTexts: ["Szwecja jest w NATO od 2024 roku.", "Sweden joined NATO in 2024"],
      mustHave: ["Szwecja | Sweden", "NATO", "2024"],
    });
    expect(ranked[0]!.recordId).toBe("gold");
  });

  it("dla pytania o zwycięzcę przedkłada rozstrzygnięcie PKW nad listę kandydatów do ponownego głosowania", () => {
    const bulletins = readCorpus().records.filter(r => r.sourceId === "sejm-eli" && r.publishedAt?.startsWith("2025"));
    const first = bulletins.find(r => electionResultStage(r) === "runoff_pending")!;
    const final = bulletins.find(r => electionResultStage(r) === "elected")!;
    const query = "Kto wygrał wybory prezydenckie w Polsce w 2025 roku?";
    expect(asksForElectionWinner("Kto wygrał pierwszą turę wyborów?")).toBe(false);
    const ranked = lexicalRerank(cands([first.id, final.id]), new Map([[first.id, first], [final.id, final]]), { queryTexts: [query] });
    expect(ranked[0]?.recordId).toBe(final.id);
  });

  it("without must-have terms the fusion order mostly stays", () => {
    const ranked = lexicalRerank(cands(["eu", "noise", "gold"]), records, { queryTexts: ["zupełnie inny temat"] });
    expect(ranked.map((c) => c.recordId)).toEqual(["eu", "noise", "gold"]);
  });

  it.each([24, 60])("wybiera definicję liczebności dla tej samej jednostki zarówno przy liczbie zgodnej, jak i innej (%s)", value => {
    const gold = rec("statut", "Statut", "Komitet składa się z 24 delegatów.");
    const noise = rec("inne", "Komitet i 60 delegatów", "Okręg liczy 60 delegatów. Komitet zbiera dokumenty.");
    const ranked = lexicalRerank(cands([noise.id, gold.id]), new Map([[noise.id, noise], [gold.id, gold]]), {
      queryTexts: [`Komitet liczy ${value} delegatów.`], mustHave: ["Komitet", String(value)],
    });
    expect(ranked[0]?.recordId).toBe(gold.id);
  });

  it("gives privacy placeholders no weight in the score", () => {
    const candidates = cands(["noise", "eu", "gold"]);
    expect(scoreCandidates(candidates, records, {
      queryTexts: ["Szwecja [TELEFON] w NATO w 2024 roku"], mustHave: ["Szwecja", "[DOWOD]", "NATO", "2024"],
    })).toEqual(scoreCandidates(candidates, records, {
      queryTexts: ["Szwecja w NATO w 2024 roku"], mustHave: ["Szwecja", "NATO", "2024"],
    }));
  });

  it("limit cuts the list; unknown records keep only their rank score", () => {
    const s = scoreCandidates(cands(["missing", "gold"]), records, { queryTexts: ["NATO"], mustHave: ["NATO"] });
    expect(s[0]!.parts).toEqual({ rank: 1, mustHave: 0, title: 0, text: 0 });
    expect(lexicalRerank(cands(["noise", "eu", "gold"]), records, { queryTexts: ["x"], limit: 2 })).toHaveLength(2);
  });

  it("years and short tokens match exactly, longer stems as prefixes (with Polish mobile e)", () => {
    expect(queryStems(["Marszałkiem Sejmu jest"])).toEqual(["marszalk", "sejm"]);
    expect(queryStems(["NATO 2024 UE"])).toEqual(["nato", "2024$", "ue$"]);
    expect(mobileEVariant("marszalk")).toBe("marszalek");
    const r = new Map([["m", rec("m", "Marszałek Sejmu RP", "Marszałek Sejmu podpisał obwieszczenie.")]]);
    const [s] = scoreCandidates(cands(["m"]), r, { queryTexts: ["Kto jest marszałkiem Sejmu?"] });
    expect(s!.parts.title).toBe(1);
    const y = new Map([["y", rec("y", "Rok", "W roku 20245 nic.")]]);
    expect(scoreCandidates(cands(["y"]), y, { queryTexts: ["x"], mustHave: ["2024"] })[0]!.parts.mustHave).toBe(0);
  });
});
