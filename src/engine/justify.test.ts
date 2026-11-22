import { describe, expect, it } from "vitest";
import type { Claim, CorpusRecord, EvidenceAssessment } from "../shared/contracts";
import { passageKind } from "../shared/evidence";
import { buildJustification, buildSummaryPl, firstSentencePl, type JustifyInput } from "./justify";

function rec(over: Partial<CorpusRecord> & { id: string }): CorpusRecord {
  return {
    sourceId: over.id.split(":")[0] ?? "src",
    url: `https://example.org/${over.id}`,
    title: `Tytuł ${over.id}`,
    publisher: `Wydawca ${over.id}`,
    publishedAt: "2025-08-06",
    fetchedAt: "2026-11-21T00:00:00Z",
    lang: "pl",
    text: "Fragment.",
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: `grp-${over.id}`,
    licence: "domena publiczna",
    topics: [],
    origin: "corpus",
    ...over,
  };
}

it("odróżnia autora ocenianej tezy od komentarza redakcji i fragmentu łączącego oba pola feedu", () => {
  const record = rec({ id: "factcheck:1", role: "stala_rola", claimReviewed: "Cytowana teza",
    text: "Cytowana teza\nKomentarz redakcji" });
  expect(passageKind(record, "Cytowana teza")).toBe("reviewed_claim");
  expect(passageKind(record, "Komentarz redakcji")).toBe("excerpt");
  expect(passageKind(record, "teza\nKomentarz")).toBe("structured_data");
});

function asm(recordId: string, over: Partial<EvidenceAssessment> = {}): EvidenceAssessment {
  return {
    claimId: "c1",
    recordId,
    relation: "OBALA",
    aspect: "sedno",
    quote: "cytat",
    quoteVerified: true,
    quoteMatchScore: 1,
    verifier: "zgoda",
    decisive: true,
    ...over,
  };
}

const claim: Claim = {
  id: "c1",
  text: "Jakub Siuda to prezydent polski.",
  type: "fakt",
  isMain: true,
  temporal: { kind: "stan" },
  inputOverlap: 1,
};

const KPRP = rec({
  id: "prezydent:1",
  publisher: "Kancelaria Prezydenta RP",
  independenceGroup: "kprp",
  text: "Dr Karol Nawrocki – Prezydent Rzeczypospolitej Polskiej. Urząd ten objął 6 sierpnia 2025 roku.",
});
const DU = rec({
  id: "eli:1",
  publisher: "Dziennik Ustaw",
  independenceGroup: "dziennik-ustaw",
  publishedAt: "2025-11-21",
  text: "Prezydent Rzeczypospolitej Polskiej: K. Nawrocki",
});

function input(over: Partial<JustifyInput>): JustifyInput {
  return {
    claim,
    decision: { verdict: "FALSZYWE", ruleApplied: 8, decisiveRecordIds: ["prezydent:1", "eli:1"], archival: false },
    assessments: [
      asm("prezydent:1", { quote: "Dr Karol Nawrocki – Prezydent Rzeczypospolitej Polskiej" }),
      asm("eli:1", { quote: "Prezydent Rzeczypospolitej Polskiej: K. Nawrocki" }),
    ],
    records: new Map([
      [KPRP.id, KPRP],
      [DU.id, DU],
    ]),
    searchedPl: [],
    unavailablePl: [],
    verdictMode: "rules",
    ...over,
  };
}

describe("uzasadnienie FAŁSZYWE / POTWIERDZONE", () => {
  it("dwa niezależne źródła urzędowe: liczba, wydawcy i cytat ze źródła głównego", () => {
    const j = buildJustification(input({}));
    expect(j.reasonPl.startsWith("Przeczą temu 2 niezależne źródła urzędowe: Kancelaria Prezydenta RP i Dziennik Ustaw.")).toBe(true);
    expect(j.reasonPl).toContain("„Dr Karol Nawrocki – Prezydent Rzeczypospolitej Polskiej”");
  });

  it("jedno źródło urzędowe: rodzaj źródła, a wydawca raz — w cytacie", () => {
    const j = buildJustification(
      input({ assessments: [asm("prezydent:1", { quote: "Dr Karol Nawrocki" })], decision: { verdict: "FALSZYWE", ruleApplied: 8, decisiveRecordIds: ["prezydent:1"], archival: false } }),
    );
    expect(j.reasonPl.startsWith("Przeczy temu źródło urzędowe. Kancelaria Prezydenta RP (")).toBe(true);
  });

  it("zawetowany dowód nie liczy się do potwierdzeń", () => {
    const j = buildJustification(
      input({
        assessments: [
          asm("prezydent:1", { quote: "Dr Karol Nawrocki" }),
          asm("eli:1", { quote: "K. Nawrocki", verifier: "sprzeciw" }),
        ],
      }),
    );
    expect(j.reasonPl.startsWith("Przeczy temu źródło urzędowe")).toBe(true);
  });

  it("POTWIERDZONE z wtórnym i urzędowym: „w tym urzędowe”", () => {
    const pap = rec({ id: "pap:1", publisher: "PAP", level: 3, type: "analiza", independenceGroup: "pap" });
    const j = buildJustification(
      input({
        decision: { verdict: "POTWIERDZONE", ruleApplied: 7, decisiveRecordIds: ["prezydent:1"], archival: false },
        assessments: [asm("prezydent:1", { relation: "WSPIERA", quote: "Dr Karol Nawrocki" }), asm("pap:1", { relation: "WSPIERA", quote: "x" })],
        records: new Map([
          [KPRP.id, KPRP],
          [pap.id, pap],
        ]),
      }),
    );
    expect(j.reasonPl.startsWith("Potwierdzają to 2 niezależne wiarygodne źródła, w tym urzędowe: Kancelaria Prezydenta RP i PAP.")).toBe(true);
  });

  it("FAŁSZYWE z reguły 8b (OBALA/czas): źródło i cytat z inną datą", () => {
    const nato = rec({ id: "nato:1", publisher: "NATO", independenceGroup: "nato", publishedAt: "2024-03-11" });
    const j = buildJustification(
      input({
        claim: { ...claim, text: "Polska wstąpiła do NATO w 2004 roku.", temporal: { kind: "jednorazowe", date: "2004" } },
        decision: { verdict: "FALSZYWE", ruleApplied: 8, decisiveRecordIds: ["nato:1"], archival: false },
        assessments: [asm("nato:1", { relation: "OBALA", aspect: "czas", quote: "Poland 1999" })],
        records: new Map([[nato.id, nato]]),
      }),
    );
    expect(j.reasonPl.startsWith("Przeczy temu źródło urzędowe.")).toBe(true);
    expect(j.reasonPl).toContain("„Poland 1999”");
  });
});

describe("podsumowanie", () => {
  it("przy jasnym werdykcie pokazuje od razu cytat ze źródła", () => {
    const j = buildJustification(input({}));
    const s = buildSummaryPl({ verdict: "FALSZYWE", reasonPl: j.reasonPl }, 0);
    expect(s.startsWith("Ocena głównego twierdzenia: Fałszywe. Przeczą temu 2 niezależne źródła urzędowe")).toBe(true);
    expect(s).toContain("Dr Karol Nawrocki");
  });

  it("kropka wewnątrz cytatu nie kończy pierwszego zdania", () => {
    expect(firstSentencePl("Źródło: „Ala ma kota. Kot ma Alę.” Dalej. Reszta.")).toBe("Źródło: „Ala ma kota. Kot ma Alę.” Dalej.");
  });
});

describe("brak potwierdzenia po wyszukiwaniu na żywo", () => {
  const none = (searched: string[]) =>
    buildJustification(
      input({
        decision: { verdict: "BRAK_DOWODOW", ruleApplied: 2, decisiveRecordIds: [], archival: false },
        assessments: [asm("prezydent:1", { relation: "BEZ_ZWIAZKU", quote: "", quoteVerified: false, excluded: "bez_zwiazku" })],
        searchedPl: searched,
      }),
    );

  it("brak trafienia na żywo pozostawia pytanie otwarte, a raport wymienia użyte wyszukiwanie", () => {
    const j = none(["baza wiarygodnych źródeł", "wyszukiwanie na żywo w serwisach z katalogu źródeł"]);
    expect(j.reasonPl).toBe("Nie znaleźliśmy w wiarygodnych źródłach dowodu, który pozwalałby to rozstrzygnąć.");
    expect(j.triedPl).toContain("wyszukiwanie na żywo");
  });

  it("bez wyszukiwania na żywo — zwykły komunikat o braku dowodu", () => {
    const j = none(["baza wiarygodnych źródeł"]);
    expect(j.reasonPl).toBe("Nie znaleźliśmy w wiarygodnych źródłach dowodu, który pozwalałby to rozstrzygnąć.");
  });
});

describe("ocena fact-checkera dla twierdzenia przeciwnego", () => {
  it("„zaprzeczona” teza oceniona jako fałsz → tekst mówi o twierdzeniu przeciwnym, a nie „prawdziwe (ocena: Fałsz)”", () => {
    const fc: CorpusRecord = {
      id: "FC1", sourceId: "demagog", url: "https://demagog.org.pl/x", title: "Teza", publisher: "Stowarzyszenie Demagog",
      publishedAt: "2026-07-27", fetchedAt: "2026-11-01T00:00:00Z", lang: "pl", role: "stala_rola", type: "factcheck", level: 2,
      independenceGroup: "demagog", licence: "test", topics: [], origin: "corpus",
      claimReviewed: "Karol Nawrocki nie jest prezydentem.", text: "Karol Nawrocki nie jest prezydentem.",
      rating: { raw: "Fałsz", mapped: "FALSZYWE", binary: true },
    } as CorpusRecord;
    const j = buildJustification({
      claim: { id: "c1", text: "Karol Nawrocki jest prezydentem Polski.", type: "fakt", isMain: true, temporal: { kind: "stan" }, inputOverlap: 1 },
      decision: { verdict: "POTWIERDZONE", ruleApplied: 6, decisiveRecordIds: ["FC1"], archival: false },
      assessments: [
        { claimId: "c1", recordId: "FC1", relation: "WSPIERA", aspect: "sedno", quote: "Karol Nawrocki nie jest prezydentem.", quoteVerified: true, verifier: "zgoda", decisive: true, fixedRoleMatch: "zaprzeczona" } as never,
      ],
      records: new Map([["FC1", fc]]),
      searchedPl: [],
      unavailablePl: [],
      verdictMode: "rules",
    });
    expect(j.reasonPl).toMatch(/^Organizacja sprawdzająca fakty oceniła jako nieprawdziwe twierdzenie przeciwne \(ocena: „Fałsz”\), więc to twierdzenie jest prawdziwe\./);
  });
});
