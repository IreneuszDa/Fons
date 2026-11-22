import { describe, expect, it } from "vitest";
import type {
  Aspect,
  Claim,
  CorpusRecord,
  EvidenceAssessment,
  FixedRating,
  Relation,
  Strength,
  Verdict,
} from "../../shared/contracts";
import { decideVerdict, type VerdictDecision } from "./index";
import type { ClaimWithFocus } from "./types";

// ───────────────────────── fixtures ─────────────────────────

const NOW = new Date("2026-11-21T12:00:00Z");

function rec(id: string, over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id,
    sourceId: id.split(":")[0] ?? "src",
    url: `https://example.org/${encodeURIComponent(id)}`,
    title: `Tytuł ${id}`,
    publisher: `Wydawca ${id}`,
    publishedAt: "2026-06-01",
    fetchedAt: "2026-11-01T00:00:00Z",
    lang: "pl",
    text: "Fragment źródła.",
    role: "tresc",
    type: "pierwotne",
    level: 1,
    independenceGroup: `grp-${id}`,
    licence: "CC BY 4.0",
    topics: [],
    origin: "corpus",
    ...over,
  };
}

const primary = (id: string, over: Partial<CorpusRecord> = {}) => rec(id, { level: 1, type: "pierwotne", ...over });
const secondary = (id: string, group: string, over: Partial<CorpusRecord> = {}) =>
  rec(id, { level: 3, type: "analiza", independenceGroup: group, ...over });
const factcheck = (id: string, rating: FixedRating, over: Partial<CorpusRecord> = {}) =>
  rec(id, {
    level: 2,
    type: "factcheck",
    role: "stala_rola",
    claimReviewed: "Teza sprawdzana",
    rating,
    ...over,
  });

const R_FALSZ: FixedRating = { raw: "Fałsz", mapped: "FALSZYWE", binary: true };
const R_PRAWDA: FixedRating = { raw: "Prawda", mapped: "POTWIERDZONE", binary: true };
const R_MANIP: FixedRating = { raw: "Manipulacja", mapped: "WPROWADZAJACE", binary: false };
const R_UNKNOWN: FixedRating = { raw: "Coś dziwnego", mapped: null, binary: false };

function asm(
  recordId: string,
  relation: Relation,
  aspect: Aspect = "sedno",
  over: Partial<EvidenceAssessment> = {},
): EvidenceAssessment {
  return {
    claimId: "c1",
    recordId,
    relation,
    aspect,
    quote: "cytat",
    quoteVerified: true,
    quoteMatchScore: 100,
    verifier: "zgoda",
    decisive: false,
    ...over,
  };
}

/** Ocena rekordu o stałej roli (relacja czytelnika dla nich nie ma znaczenia). */
const fixedAsm = (recordId: string, match: EvidenceAssessment["fixedRoleMatch"], over: Partial<EvidenceAssessment> = {}) =>
  asm(recordId, "WSPIERA", "sedno", { fixedRoleMatch: match, ...over });

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "c1",
    text: "Polska jest członkiem Unii Europejskiej.",
    type: "fakt",
    isMain: true,
    temporal: { kind: "brak" },
    inputOverlap: 0.9,
    ...over,
  };
}

const stan = (text = "Stopa bezrobocia w Polsce wynosi 5 procent.") => claim({ text, temporal: { kind: "stan" } });

// ───────────────────────── reguła 8b: twierdzenie = jedna wartość (A03) ─────────────────────────

const NATO_LONG =
  "Czechia, Hungary and Poland were invited to begin accession talks at the Alliance's Madrid Summit in 1997 and on 12 March 1999 they became the first former members of the Warsaw Pact to join NATO.";
const NATO_LIST = "Poland 1999";
const natoRecs = () => [
  primary("nato:1", { independenceGroup: "nato", publishedAt: "2024-03-11" }),
  primary("nato:2", { independenceGroup: "nato", publishedAt: "2024-03-11" }),
];
const NATO_2004 = "Polska wstąpiła do NATO w 2004 roku.";

/**
 * Przypadki reguły 8b (PLAN §4: „twierdzenie sprowadza się do obalonego aspektu”) kontra reguła 9.
 * A03 i B06 to prawdziwe odczyty czytelnika z ewaluacji 2026-11-21: oba CZESCIOWO/czas z innym rokiem,
 * a wzorce się różnią (A03 FAŁSZYWE, B06 WPROWADZAJĄCE) — dlatego CZESCIOWO nigdy nie daje 8b.
 */
function reductionCases(): Case[] {
  const nato = (over: Partial<ClaimWithFocus> = {}): ClaimWithFocus => ({
    ...claim({ text: NATO_2004, temporal: { kind: "jednorazowe", date: "2004" } }),
    ...over,
  });
  const refCzas = (id: string, quote: string) => asm(id, "OBALA", "czas", { quote });
  const partialCzas = (id: string, quote: string) => asm(id, "CZESCIOWO", "czas", { quote });
  const withSedno = () => [...natoRecs(), primary("nato:3", { independenceGroup: "nato-b" })];
  return [
    // ── FAŁSZYWE: twierdzenie = jedna wartość, obalona
    {
      name: "8b: czas trwania wyrażony przymiotnikiem dotyczy dokładnie tego organu",
      claim: { ...claim({ text: "Kadencja Sejmu trwa 5 lat." }), assertedAspect: "liczba" },
      records: [primary("sejm-eli:art")],
      assessments: [asm("sejm-eli:art", "OBALA", "czas", { quote: "Art. 98. 1. Sejm i Senat są wybierane na czteroletnie kadencje." })],
      expect: { verdict: "FALSZYWE", rule: 8, decisive: ["sejm-eli:art"] },
    },
    {
      name: "8b: sam numer artykułu i czas trwania dla innego organu nie obalają liczby",
      claim: { ...claim({ text: "Kadencja Sejmu trwa 5 lat." }), assertedAspect: "liczba" },
      records: [primary("sejm-eli:art")],
      assessments: [asm("sejm-eli:art", "OBALA", "czas", { quote: "Art. 98. 1. Zarząd jest wybierany na czteroletnią kadencję." })],
      expect: { verdict: "BRAK_DOWODOW", rule: 2, decisive: [] },
    },
    {
      name: "8b A03: „Polska wstąpiła do NATO w 2004”, OBALA/czas („Poland 1999”) → FALSZYWE (8)",
      claim: nato(),
      records: natoRecs(),
      assessments: [refCzas("nato:1", NATO_LONG), refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "FALSZYWE", rule: 8, decisive: ["nato:1", "nato:2"] },
    },
    {
      name: "8b A03 bez daty z ekstrakcji (temporal brak) — rok w tekście wystarcza → FALSZYWE (8)",
      claim: nato({ temporal: { kind: "brak" } }),
      records: natoRecs(),
      assessments: [refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "FALSZYWE", rule: 8 },
    },
    {
      name: "8b: data względna ustalona przez ekstrakcję („wczoraj”), obalona tylko data → FALSZYWE (8)",
      claim: claim({ text: "Ustawa o asystencji weszła w życie wczoraj.", temporal: { kind: "jednorazowe", date: "2026-05-20" } }),
      records: [primary("eli:1", { publishedAt: "2026-06-01" })],
      assessments: [asm("eli:1", "OBALA", "czas", { quote: "Ustawa wchodzi w życie z dniem 1 stycznia 2026 r." })],
      expect: { verdict: "FALSZYWE", rule: 8 },
    },
    {
      name: "8b z polem assertedAspect=czas: WSPIERA sedno (tło) + OBALA/czas → FALSZYWE (8)",
      claim: nato({ assertedAspect: "czas" }),
      records: withSedno(),
      assessments: [asm("nato:3", "WSPIERA", "sedno"), refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "FALSZYWE", rule: 8, decisive: ["nato:2"] },
    },
    {
      name: "8b z polem assertedAspect=autorstwo: OBALA/autorstwo → FALSZYWE (8)",
      claim: claim({ text: "Ustawę o obronie Ojczyzny podpisał Jakub Siuda.", assertedAspect: "autorstwo" } as Partial<ClaimWithFocus>),
      records: [primary("prezydent:1")],
      assessments: [asm("prezydent:1", "OBALA", "autorstwo")],
      expect: { verdict: "FALSZYWE", rule: 8 },
    },
    {
      name: "8b z polem assertedAspect=czas, twierdzenie z wieloma szczegółami — pole wygrywa z przybliżeniem → FALSZYWE (8)",
      claim: claim({
        text: "Na szczycie NATO w Madrycie w 1999 roku Polskę zaproszono do rozmów akcesyjnych.",
        temporal: { kind: "jednorazowe", date: "1999" },
        assertedAspect: "czas",
      } as Partial<ClaimWithFocus>),
      records: natoRecs(),
      assessments: [refCzas("nato:1", NATO_LONG)],
      expect: { verdict: "FALSZYWE", rule: 8 },
    },
    // ── WPROWADZAJĄCE: sedno prawdziwe / szczegół błędny / prawdziwy materiał
    {
      name: "9 A03 (odczyt z ewaluacji): oba cytaty CZESCIOWO/czas z rokiem 1999 → WPROWADZAJACE — naprawa po stronie czytelnika",
      claim: nato(),
      records: natoRecs(),
      assessments: [partialCzas("nato:1", NATO_LONG), partialCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "czas (data)" },
    },
    {
      name: "9 B06 (odczyt z ewaluacji): „pełnoskalowa inwazja w 2014”, CZESCIOWO/czas z rokiem 2022 → WPROWADZAJACE",
      claim: claim({ text: "Rosja rozpoczęła pełnoskalową inwazję na Ukrainę w 2014 roku.", temporal: { kind: "jednorazowe", date: "2014" } }),
      records: [primary("nato:4", { independenceGroup: "nato" }), primary("gov:1", { independenceGroup: "gov" })],
      assessments: [
        partialCzas("nato:4", "Following Russia’s full-scale invasion of Ukraine in February 2022, Allies have reinforced their deterrence."),
        partialCzas("gov:1", "agresji Federacji Rosyjskiej na Ukrainę rozpoczętej w dniu 24 lutego 2022 r."),
      ],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9: OBALA/czas + CZESCIOWO/czas (część czytelników widzi prawdziwy materiał) → WPROWADZAJACE",
      claim: nato(),
      records: natoRecs(),
      assessments: [refCzas("nato:2", NATO_LIST), partialCzas("nato:1", NATO_LONG)],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9: bez pola WSPIERA sedno + OBALA/czas → sedno prawdziwe, szczegół błędny → WPROWADZAJACE",
      claim: nato(),
      records: withSedno(),
      assessments: [asm("nato:3", "WSPIERA", "sedno"), refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "Główna treść się zgadza" },
    },
    {
      name: "9: sedno + kilka szczegółów (3 nazwy: NATO, Madryt, Polska), obalony tylko rok, bez pola → WPROWADZAJACE",
      claim: claim({
        text: "Na szczycie NATO w Madrycie w 1999 roku Polskę zaproszono do rozmów akcesyjnych.",
        temporal: { kind: "jednorazowe", date: "1999" },
      }),
      records: natoRecs(),
      assessments: [refCzas("nato:1", NATO_LONG)],
      expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "czas (data)" },
    },
    {
      name: "9: dodatkowe stwierdzenie po przecinku, obalony tylko rok → WPROWADZAJACE",
      claim: nato({ text: "Polska wstąpiła do NATO w 2004 roku, razem z Litwą i Łotwą." }),
      records: natoRecs(),
      assessments: [refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9: dwie wartości (rok i liczba państw), obalony tylko rok → WPROWADZAJACE",
      claim: claim({ text: "W 2004 roku do NATO wstąpiło 7 państw.", temporal: { kind: "jednorazowe", date: "2004" } }),
      records: natoRecs(),
      assessments: [refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9: INNY_KONTEKST/czas z innym rokiem (prawdziwy materiał, inna sytuacja) → WPROWADZAJACE",
      claim: nato(),
      records: natoRecs(),
      assessments: [asm("nato:2", "INNY_KONTEKST", "czas", { quote: NATO_LIST })],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9 z polem assertedAspect=sedno: obalona tylko data → nie 8b → WPROWADZAJACE",
      claim: claim({
        text: "Ustawa weszła w życie 1 stycznia 2025.",
        temporal: { kind: "jednorazowe", date: "2025-01-01" },
        assertedAspect: "sedno",
      } as Partial<ClaimWithFocus>),
      records: [primary("eli:1", { publishedAt: "2025-02-01" })],
      assessments: [asm("eli:1", "OBALA", "czas")],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9 z polem assertedAspect=czas, CZESCIOWO/czas → nadal WPROWADZAJACE (CZESCIOWO nigdy nie daje 8b)",
      claim: nato({ assertedAspect: "czas" }),
      records: natoRecs(),
      assessments: [partialCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9 z polem assertedAspect=liczba, ale obalony czas → WPROWADZAJACE",
      claim: nato({ assertedAspect: "liczba" }),
      records: natoRecs(),
      assessments: [refCzas("nato:2", NATO_LIST)],
      expect: { verdict: "WPROWADZAJACE", rule: 9 },
    },
    {
      name: "9 bez pola: OBALA/autorstwo → WPROWADZAJACE (8b bez pola tylko dla czasu i liczby)",
      claim: claim({ text: "Ustawę o obronie Ojczyzny podpisał Jakub Siuda." }),
      records: [primary("prezydent:1")],
      assessments: [asm("prezydent:1", "OBALA", "autorstwo")],
      expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "autor" },
    },
    {
      name: "5: OBALA/czas, ale inne źródło urzędowe WSPIERA czas → sprzeczność, nie 8b → BRAK (5)",
      claim: nato(),
      records: [...natoRecs(), primary("x:1", { independenceGroup: "x" })],
      assessments: [refCzas("nato:2", NATO_LIST), asm("x:1", "WSPIERA", "czas", { quote: "W 2004 roku" })],
      expect: { verdict: "BRAK_DOWODOW", rule: 5 },
    },
    {
      name: "8b liczba (bez zmian): wyliczenie kilku liczb („350 mld, o 200 mld więcej”), OBALA/liczba → FALSZYWE (8)",
      claim: claim({ text: "USA dały Ukrainie 350 miliardów dolarów, o 200 miliardów więcej niż Europa." }),
      records: [primary("kiel:1")],
      assessments: [asm("kiel:1", "OBALA", "liczba", { quote: "US aid to Ukraine totalled 115 billion euro." })],
      expect: { verdict: "FALSZYWE", rule: 8 },
    },
  ];
}

describe("jedno twierdzenie o dokładnej liczebności", () => {
  const matches = "Komitet składa się z 24 delegatów.";
  it.each([
    ["Komitet liczy 24 delegatów.", matches, "WSPIERA", "liczba", "zgoda", "POTWIERDZONE"],
    ["Komitet nie liczy 24 delegatów.", matches, "OBALA", "liczba", "zgoda", "FALSZYWE"],
    ["Komitet nie liczy 36 delegatów.", matches, "WSPIERA", "liczba", "zgoda", "POTWIERDZONE"],
    ["Komitet liczy 36 delegatów.", matches, "OBALA", "liczba", "zgoda", "FALSZYWE"],
    ["Komitet nie liczy 24 delegatów.", matches, "WSPIERA", "sedno", "zgoda", "BRAK_DOWODOW"],
    ["Komitet liczy 24 obserwatorów.", matches, "WSPIERA", "sedno", "zgoda", "BRAK_DOWODOW"],
    ["Komitet liczy 24 delegatów.", "Zarząd liczy 24 delegatów.", "WSPIERA", "liczba", "zgoda", "BRAK_DOWODOW"],
    ["Komitet liczy 24 delegatów.", "Art. 24. Komitet składa się z 36 delegatów.", "WSPIERA", "liczba", "zgoda", "BRAK_DOWODOW"],
    ["Komitet liczy 24 delegatów.", "Komitet nie liczy 24 delegatów.", "WSPIERA", "liczba", "zgoda", "BRAK_DOWODOW"],
    ["Komitet liczy 24 delegatów.", matches, "WSPIERA", "liczba", "niepewne", "BRAK_DOWODOW"],
  ] as const)("%s / %s / %s / %s / %s → %s", (text, quote, relation, aspect, verifier, verdict) => {
    const r = primary("statut:1", { text: quote });
    const result = decideVerdict({ claim: claim({ text }), records: new Map([[r.id, r]]),
      assessments: [asm(r.id, relation, aspect, { quote, verifier })], now: NOW, singleKeyVerifier: true });
    expect(result.verdict).toBe(verdict);
    expect(result.decisiveRecordIds).toEqual(verdict === "BRAK_DOWODOW" ? [] : [r.id]);
  });
});

// ───────────────────────── table ─────────────────────────

interface Case {
  name: string;
  claim?: Claim;
  records: CorpusRecord[];
  assessments: EvidenceAssessment[];
  singleKey?: boolean;
  expect: {
    verdict: Verdict;
    rule: number;
    archival?: boolean;
    decisive?: string[];
    conflicting?: { supporting: string[]; refuting: string[] } | null;
    strength?: Strength;
    missingContextIncludes?: string;
    archivalWarning?: boolean;
    verifierAgreement?: string;
    belowThreshold?: string[];
    primarySources?: number;
    independentPublishers?: number;
  };
}

const cases: Case[] = [
  // ── A: prosty fakt ze źródła pierwotnego
  {
    name: "A: prosty fakt potwierdzony przez źródło pierwotne (weryfikator innego dostawcy) → POTWIERDZONE (7) mocna",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["eli:1"], strength: "mocna", conflicting: null, primarySources: 1 },
  },
  {
    name: "A: jedno źródło pierwotne + weryfikator tego samego dostawcy → POTWIERDZONE (7) srednia",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA")],
    singleKey: true,
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "srednia" },
  },
  {
    name: "A: pierwotne + niezależne wtórne (poniżej progu, ale zgodne) → POTWIERDZONE mocna",
    records: [primary("eli:1"), secondary("pap:1", "pap")],
    assessments: [asm("eli:1", "WSPIERA"), asm("pap:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["eli:1"], strength: "mocna", independentPublishers: 2 },
  },
  {
    name: "A: źródło pierwotne obala sedno → FALSZYWE (8)",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "OBALA")],
    expect: { verdict: "FALSZYWE", rule: 8, decisive: ["eli:1"] },
  },
  // ── B: prawdziwy materiał, zły czas / miejsce
  {
    name: "B: sedno potwierdzone, czas obalony → WPROWADZAJACE (9), nie sprzeczność",
    claim: claim({ text: "Wczoraj w Krakowie była powódź.", temporal: { kind: "jednorazowe", date: "2026-05-20" } }),
    records: [primary("imgw:1", { publishedAt: "2026-06-01" }), primary("imgw:2", { publishedAt: "2026-06-02" })],
    assessments: [asm("imgw:1", "WSPIERA", "sedno"), asm("imgw:2", "OBALA", "czas")],
    expect: {
      verdict: "WPROWADZAJACE",
      rule: 9,
      conflicting: null,
      missingContextIncludes: "czas (data)",
      decisive: ["imgw:1", "imgw:2"],
    },
  },
  {
    name: "B: materiał z innego kontekstu (INNY_KONTEKST) → WPROWADZAJACE (9)",
    records: [primary("gov:1")],
    assessments: [asm("gov:1", "INNY_KONTEKST", "miejsce")],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "innej sytuacji" },
  },
  {
    name: "B: dwa niezależne wtórne wspierają sedno, pierwotne obala miejsce → WPROWADZAJACE (9)",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn"), primary("gov:1")],
    assessments: [asm("pap:1", "WSPIERA"), asm("tvn:1", "WSPIERA"), asm("gov:1", "OBALA", "miejsce")],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "miejsce" },
  },
  {
    name: "Sieć obserwatoriów: pełny wykaz i dwie zgodne monografie poszczególnych stacji",
    claim: claim({ text: "Sieć otworzyła stacje w Toruniu, Pile i Opolu." }),
    records: [primary("wykaz"), primary("pila"), primary("opole")],
    assessments: [asm("wykaz", "WSPIERA", "sedno", { quote: "Otwarto stacje w Toruniu, Pile i Opolu." }),
      asm("pila", "CZESCIOWO", "zakres", { quote: "W Pile powstała stacja badawcza.", partialMeaning: "coverage" }),
      asm("opole", "CZESCIOWO", "zakres", { quote: "Otworzyliśmy stację w Opolu." })],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["wykaz"] },
  },
  {
    name: "Źródło o jednej z trzech stacji nie rozstrzyga, czy otwarto komplet",
    records: [primary("pila")],
    assessments: [asm("pila", "CZESCIOWO", "zakres", { quote: "W Pile powstała stacja badawcza.", partialMeaning: "coverage" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Wykazane pominięcie odwołanych otwarć zmienia ocenę zakresu",
    records: [primary("protokol")],
    assessments: [asm("protokol", "CZESCIOWO", "zakres", { quote: "Otwarto wyłącznie stację w Pile. Pozostałe otwarcia odwołano.", partialMeaning: "correction" })],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "błąd w szczególe" },
  },
  {
    name: "Niepotwierdzona przez weryfikatora interpretacja nie wystarcza do przypisania błędu",
    records: [primary("pila")],
    assessments: [asm("pila", "CZESCIOWO", "zakres", { quote: "W Pile powstała stacja badawcza.", partialMeaning: "correction", verifier: "niepewne" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Historyczny stan sieci nie zostaje obalony przez późniejszą liczbę stacji",
    claim: claim({ text: "Sieć ma trzy stacje.", temporal: { kind: "stan", asOf: "2018-03-08" } }),
    records: [primary("2018", { period: "2018" }), primary("2026", { period: "2026" })],
    assessments: [asm("2018", "WSPIERA"), asm("2026", "OBALA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["2018"] },
  },
  // ── C: sprzeczne wiarygodne źródła
  {
    name: "C: dwa pierwotne sprzeczne co do sedna, ten sam okres → BRAK (5) + conflicting",
    records: [primary("gus:1", { period: "2025" }), primary("eurostat:1", { period: "2025" })],
    assessments: [asm("gus:1", "WSPIERA"), asm("eurostat:1", "OBALA")],
    expect: {
      verdict: "BRAK_DOWODOW",
      rule: 5,
      conflicting: { supporting: ["gus:1"], refuting: ["eurostat:1"] },
      strength: "slaba",
    },
  },
  {
    name: "C: fact-check kontra źródło pierwotne z tego samego okresu → BRAK (5), nie reguła 6",
    records: [factcheck("demagog:1", R_FALSZ, { publishedAt: "2025-03-01" }), primary("gus:1", { publishedAt: "2025-02-01" })],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("gus:1", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5, conflicting: { supporting: ["gus:1"], refuting: ["demagog:1"] } },
  },
  {
    name: "C: nieznane okresy liczą się jako nakładające → BRAK (5)",
    records: [primary("a:1", { publishedAt: null }), primary("b:1", { publishedAt: null })],
    assessments: [asm("a:1", "WSPIERA"), asm("b:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5 },
  },
  {
    name: "C: dwa fact-checki o przeciwnych ocenach → BRAK (5)",
    records: [factcheck("demagog:1", R_FALSZ), factcheck("afp:1", R_PRAWDA, { independenceGroup: "afp" })],
    assessments: [fixedAsm("demagog:1", "ta_sama"), fixedAsm("afp:1", "ta_sama")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5, conflicting: { supporting: ["afp:1"], refuting: ["demagog:1"] } },
  },
  {
    name: "Dwie niezależne relacje o tym samym okresie uzasadniają wstrzymanie i wskazanie obu cytatów",
    records: [secondary("a:1", "a", { period: "2024" }), secondary("b:1", "b", { period: "2024" })],
    assessments: [asm("a:1", "WSPIERA", "liczba"), asm("b:1", "OBALA", "liczba")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5, conflicting: { supporting: ["a:1"], refuting: ["b:1"] } },
  },
  {
    name: "Sprzeczne fragmenty z jednej publikacji nie stanowią dwóch źródeł",
    records: [primary("a:1", { url: "https://example.org/pierwsza" }), primary("a:2", { url: "https://example.org/pierwsza#inna-sekcja" })],
    assessments: [asm("a:1", "WSPIERA"), asm("a:2", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, conflicting: null },
  },
  {
    name: "Jedna publikacja znaleziona w dwóch indeksach występuje raz po swojej stronie sporu",
    records: [primary("a:1"), primary("b:1"), primary("live:1", { url: "https://example.org/b%3A1", origin: "live_snapshot",
      independenceGroup: "grp-b:1" })],
    assessments: [asm("a:1", "WSPIERA"), asm("b:1", "OBALA"), asm("live:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5, conflicting: { supporting: ["a:1"], refuting: ["b:1"] } },
  },
  {
    name: "Niezgodne relacje o tym samym okresie wymagają potwierdzenia znaczenia obu cytatów",
    records: [secondary("a:1", "a", { period: "2024" }), secondary("b:1", "b", { period: "2024" })],
    assessments: [asm("a:1", "WSPIERA"), asm("b:1", "OBALA", "sedno", { verifier: "niepewne" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, conflicting: null },
  },
  {
    name: "Niepewne odczytanie pomiaru urzędu nie przesądza wyniku, gdy niezależne źródło dokumentuje przeciwny szacunek",
    records: [primary("a:1", { period: "2024" }), secondary("b:1", "b", { period: "2024" })],
    assessments: [asm("a:1", "OBALA", "liczba", { verifier: "niepewne" }), asm("b:1", "WSPIERA", "liczba")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, conflicting: null },
  },
  {
    name: "Obecna ocena pomija udokumentowaną wcześniejszą wersję pomiaru",
    records: [primary("a:1", { period: "2024", publishedAt: "2025-04-01", supersededAt: "2026-04-01" }),
      primary("a:2", { period: "2024", publishedAt: "2026-04-01" }), primary("b:1", { period: "2024", publishedAt: "2025-03-01" })],
    assessments: [asm("a:1", "WSPIERA"), asm("a:2", "OBALA"), asm("b:1", "OBALA")],
    expect: { verdict: "FALSZYWE", rule: 8, conflicting: null, decisive: ["a:2", "b:1"] },
  },
  {
    name: "Dawny stan publikacji dopuszcza pierwotne dane i odrzuca rewizję opublikowaną po wskazanej dacie",
    claim: claim({ temporal: { kind: "brak", publishedBy: "2025-04-30" } }),
    records: [primary("a:1", { period: "2024", publishedAt: "2025-04-01", supersededAt: "2026-04-01" }),
      primary("a:2", { period: "2024", publishedAt: "2026-04-01" }), primary("b:1", { period: "2024", publishedAt: "2025-03-01" })],
    assessments: [asm("a:1", "WSPIERA"), asm("a:2", "OBALA"), asm("b:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5, conflicting: { supporting: ["a:1"], refuting: ["b:1"] } },
  },
  // ── D: nic
  {
    name: "D: brak jakichkolwiek ocen → BRAK (2)",
    records: [],
    assessments: [],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, decisive: [], strength: "slaba", verifierAgreement: "brak" },
  },
  {
    name: "D: same BEZ_ZWIAZKU → BRAK (2), nic poniżej progu",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "BEZ_ZWIAZKU")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: [] },
  },
  // ── I: rekordy o stałej roli
  {
    name: "I: fact-check IFCN, ta_sama, Fałsz → FALSZYWE (6)",
    records: [factcheck("demagog:1", R_FALSZ)],
    assessments: [fixedAsm("demagog:1", "ta_sama")],
    expect: { verdict: "FALSZYWE", rule: 6, decisive: ["demagog:1"], strength: "srednia" },
  },
  {
    name: "I: fact-check ta_sama, Manipulacja → WPROWADZAJACE (6) z kontekstem",
    records: [factcheck("demagog:1", R_MANIP)],
    assessments: [fixedAsm("demagog:1", "ta_sama")],
    expect: { verdict: "WPROWADZAJACE", rule: 6, missingContextIncludes: "Manipulacja" },
  },
  {
    name: "I: fact-check ta_sama, Prawda → POTWIERDZONE (6)",
    records: [factcheck("demagog:1", R_PRAWDA)],
    assessments: [fixedAsm("demagog:1", "ta_sama")],
    expect: { verdict: "POTWIERDZONE", rule: 6 },
  },
  {
    name: "I: baza organizatora (poziom 3, origin organizer) → FALSZYWE (6)",
    records: [factcheck("org:1", R_FALSZ, { level: 3, origin: "organizer" })],
    assessments: [fixedAsm("org:1", "ta_sama")],
    expect: { verdict: "FALSZYWE", rule: 6 },
  },
  {
    name: "I: rekord o stałej roli spoza IFCN/EFCSN i spoza bazy organizatora → nie rozstrzyga → BRAK (2)",
    records: [factcheck("blog:1", R_FALSZ, { level: 3, origin: "corpus" })],
    assessments: [fixedAsm("blog:1", "ta_sama")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: ["blog:1"] },
  },
  {
    name: "I: fact-check ma pierwszeństwo przed dwoma zgodnymi wtórnymi → FALSZYWE (6)",
    records: [factcheck("demagog:1", R_FALSZ), secondary("pap:1", "pap"), secondary("tvn:1", "tvn")],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("pap:1", "WSPIERA"), asm("tvn:1", "WSPIERA")],
    expect: { verdict: "FALSZYWE", rule: 6, decisive: ["demagog:1"] },
  },
  {
    name: "I: fact-check Prawda, ale pierwotne obala datę → nie POTWIERDZONE, WPROWADZAJACE (9)",
    records: [factcheck("demagog:1", R_PRAWDA), primary("gov:1")],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("gov:1", "OBALA", "czas")],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "czas" },
  },
  {
    name: "I: dwa niezależne fact-checki: Fałsz i Manipulacja (nie przeciwne) → WPROWADZAJACE (6), mocna",
    records: [factcheck("demagog:1", R_FALSZ), factcheck("afp:1", R_MANIP, { independenceGroup: "afp" })],
    assessments: [fixedAsm("demagog:1", "ta_sama"), fixedAsm("afp:1", "ta_sama")],
    expect: { verdict: "WPROWADZAJACE", rule: 6, strength: "mocna", independentPublishers: 2 },
  },
  // ── negacja
  {
    name: "Negacja: zaprzeczona + ocena binarna Fałsz → POTWIERDZONE (6)",
    records: [factcheck("demagog:1", R_FALSZ)],
    assessments: [fixedAsm("demagog:1", "zaprzeczona")],
    expect: { verdict: "POTWIERDZONE", rule: 6 },
  },
  {
    name: "Negacja: zaprzeczona + ocena binarna Prawda → FALSZYWE (6)",
    records: [factcheck("demagog:1", R_PRAWDA)],
    assessments: [fixedAsm("demagog:1", "zaprzeczona")],
    expect: { verdict: "FALSZYWE", rule: 6 },
  },
  {
    name: "Negacja: zaprzeczona + ocena niebinarna (Manipulacja) → nie rozstrzyga → BRAK (2)",
    records: [factcheck("demagog:1", R_MANIP)],
    assessments: [fixedAsm("demagog:1", "zaprzeczona")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: ["demagog:1"] },
  },
  {
    name: "Negacja: zaprzeczona + flaga binary, ale ocena WPROWADZAJACE → nie zgadujemy → BRAK (2)",
    records: [factcheck("demagog:1", { raw: "Dziwna", mapped: "WPROWADZAJACE", binary: true })],
    assessments: [fixedAsm("demagog:1", "zaprzeczona")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Stała rola: dopasowanie „inna” → nie rozstrzyga → BRAK (2)",
    records: [factcheck("demagog:1", R_FALSZ)],
    assessments: [fixedAsm("demagog:1", "inna")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Stała rola: dopasowanie „niepewne” → nie rozstrzyga → BRAK (2)",
    records: [factcheck("demagog:1", R_FALSZ)],
    assessments: [fixedAsm("demagog:1", "niepewne")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Stała rola: ocena nieznana tabeli (mapped null) → nie rozstrzyga → BRAK (2)",
    records: [factcheck("demagog:1", R_UNKNOWN)],
    assessments: [fixedAsm("demagog:1", "ta_sama")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: ["demagog:1"] },
  },
  {
    name: "Stała rola: brak pola rating → nie rozstrzyga → BRAK (2)",
    records: [rec("demagog:1", { role: "stala_rola", level: 2, type: "factcheck" })],
    assessments: [fixedAsm("demagog:1", "ta_sama")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  // ── stany i nieaktualność
  {
    name: "Zweryfikowany dawny stan i zmieniona wartość w późniejszym rejestrze",
    claim: stan(),
    records: [primary("archiwum"), primary("rejestr", { period: "2026" })],
    assessments: [asm("archiwum", "INNY_KONTEKST", "sedno", { period: "2015-2020", historicalSupport: true }), asm("rejestr", "OBALA")],
    expect: { verdict: "WPROWADZAJACE", rule: 4, archival: true },
  },
  {
    name: "Sam dawny stan nie rozstrzyga o stanie aktualnym",
    claim: stan(),
    records: [primary("archiwum")],
    assessments: [asm("archiwum", "INNY_KONTEKST", "sedno", { period: "2020", historicalSupport: true })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Nieaktualne: stan, starsze pierwotne wspiera liczbę, nowsze urzędowe obala → WPROWADZAJACE (4) archival",
    claim: stan(),
    records: [
      primary("gus:2022", { period: "2022", publishedAt: "2023-01-15" }),
      primary("gus:2025", { period: "2025", publishedAt: "2026-01-15" }),
    ],
    assessments: [asm("gus:2022", "WSPIERA", "liczba"), asm("gus:2025", "OBALA", "liczba")],
    expect: {
      verdict: "WPROWADZAJACE",
      rule: 4,
      archival: true,
      archivalWarning: true,
      missingContextIncludes: "nieaktualna",
      decisive: ["gus:2022", "gus:2025"],
    },
  },
  {
    name: "Stary fact-check (Prawda) kontra nowsze pierwotne obalające, stan → reguła 4, nie 6",
    claim: stan(),
    records: [
      factcheck("demagog:1", R_PRAWDA, { publishedAt: "2021-05-01" }),
      primary("gus:2025", { period: "2025", publishedAt: "2026-01-15" }),
    ],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("gus:2025", "OBALA")],
    expect: { verdict: "WPROWADZAJACE", rule: 4, archival: true },
  },
  {
    name: "Stary fact-check kontra nowsze pierwotne, twierdzenie NIE o stanie → reguła 5, nie 6",
    records: [
      factcheck("demagog:1", R_FALSZ, { publishedAt: "2021-05-01" }),
      primary("gus:2025", { period: "2025", publishedAt: "2026-01-15" }),
    ],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("gus:2025", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5 },
  },
  {
    name: "Stan: starszy fact-check (Fałsz) zastąpiony nowszymi danymi urzędowymi, które wspierają → POTWIERDZONE (7)",
    claim: stan(),
    records: [
      factcheck("demagog:1", R_FALSZ, { publishedAt: "2021-05-01" }),
      primary("gus:2025", { period: "2025", publishedAt: "2026-01-15" }),
    ],
    assessments: [fixedAsm("demagog:1", "ta_sama"), asm("gus:2025", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["gus:2025"] },
  },
  {
    name: "Stan: starsze wspiera, nowsze urzędowe obala, ale najnowsze znów wspiera → sprzeczność, nie reguła 4",
    claim: stan(),
    records: [
      primary("gus:2022", { period: "2022", publishedAt: "2023-01-15" }),
      primary("gus:2025", { period: "2025", publishedAt: "2026-01-15" }),
      primary("nbp:2025", { period: "2025", publishedAt: "2026-02-01" }),
    ],
    assessments: [
      asm("gus:2022", "WSPIERA", "liczba"),
      asm("gus:2025", "OBALA", "liczba"),
      asm("nbp:2025", "WSPIERA", "liczba"),
    ],
    expect: { verdict: "BRAK_DOWODOW", rule: 5 },
  },
  {
    name: "Stan: rozbieżne pomiary z różnych lat nie dokumentują sporu o tę samą wartość",
    claim: stan(),
    records: [
      primary("gus:2022", { period: "2022", publishedAt: "2023-01-15" }),
      secondary("pap:1", "pap", { period: "2025", publishedAt: "2026-01-15" }),
      secondary("tvn:1", "tvn", { period: "2025", publishedAt: "2026-01-16" }),
    ],
    assessments: [asm("gus:2022", "WSPIERA"), asm("pap:1", "OBALA"), asm("tvn:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, conflicting: null },
  },
  {
    name: "Stan: aktualny, ale jedyny dowód ma ponad 2 lata → POTWIERDZONE z ostrzeżeniem archiwalnym",
    claim: stan("Polska ma 16 województw."),
    records: [primary("eli:1", { publishedAt: "2023-03-01" })],
    assessments: [asm("eli:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, archival: false, archivalWarning: true },
  },
  // ── reguła 3: jednorazowe zdarzenie nowsze niż dowody
  {
    name: "Sama wcześniejsza zapowiedź z dokładną datą nie potwierdza, że protest się odbył",
    claim: claim({ text: "20 listopada 2026 w Gdańsku odbył się protest.", temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [primary("gov:1", { publishedAt: "2026-11-12" })],
    assessments: [asm("gov:1", "WSPIERA", "sedno", { quote: "Organizatorzy zapowiedzieli protest w Gdańsku na 20 listopada 2026 r." })],
    expect: { verdict: "BRAK_DOWODOW", rule: 3, strength: "slaba" },
  },
  {
    name: "Sprostowanie po wydarzeniu rozstrzyga mimo wcześniejszej zapowiedzi",
    claim: claim({ text: "20 listopada 2026 w Gdańsku odbył się protest.", temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [primary("plan", { publishedAt: "2026-11-12" }), primary("raport", { publishedAt: "2026-11-21" })],
    assessments: [asm("plan", "WSPIERA", "sedno", { quote: "Protest zaplanowano na 20 listopada 2026 r." }),
      asm("raport", "OBALA", "sedno", { quote: "Organizatorzy odwołali protest w Gdańsku, zgromadzenie się nie odbyło." })],
    expect: { verdict: "FALSZYWE", rule: 8, decisive: ["raport"] },
  },
  {
    name: "Wcześniejsza zapowiedź nie zapewnia niezależnego potwierdzenia późniejszej relacji wtórnej",
    claim: claim({ text: "20 listopada 2026 w Gdańsku odbył się protest.", temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [secondary("plan", "a", { publishedAt: "2026-11-12" }), secondary("raport", "b", { publishedAt: "2026-11-21" })],
    assessments: [asm("plan", "WSPIERA", "sedno", {quote: "Na 20 listopada 2026 planujemy protest."}),
      asm("raport", "WSPIERA", "sedno", {quote: "W Gdańsku 20 listopada 2026 odbył się protest."})],
    expect: { verdict: "BRAK_DOWODOW", rule: 3, strength: "slaba" },
  },
  {
    name: "Jednorazowe zdarzenie nowsze niż najnowszy dowód → BRAK (3)",
    claim: claim({ text: "20 listopada 2026 w Gdańsku odbył się protest.", temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [primary("gov:1", { publishedAt: "2025-11-20" })],
    assessments: [asm("gov:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 3, strength: "slaba" },
  },
  {
    name: "Jednorazowe zdarzenie, dowód bez daty publikacji pobrany przed zdarzeniem → BRAK (3)",
    claim: claim({ temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [primary("gov:1", { publishedAt: null, fetchedAt: "2026-10-01T00:00:00Z" })],
    assessments: [asm("gov:1", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 3 },
  },
  {
    name: "Reguła 3 nie działa, gdy cytat dowodu mówi wprost o czasie zdarzenia lub późniejszym (decyzja do daty po zdarzeniu) → FALSZYWE (8)",
    claim: claim({ text: "Od listopada 2026 roku zniesiono kontrole na granicy.", temporal: { kind: "jednorazowe", date: "2026-11" } }),
    records: [primary("gov:1", { publishedAt: "2026-10-01" })],
    assessments: [asm("gov:1", "OBALA", "sedno", { quote: "Kontrole na granicy przedłużono od 2 października 2026 r. do 30 marca 2027 r." })],
    expect: { verdict: "FALSZYWE", rule: 8 },
  },
  {
    name: "Reguła 3 działa dalej, gdy cytat podaje tylko daty sprzed zdarzenia albo sam rok zdarzenia → BRAK (3)",
    claim: claim({ text: "20 listopada 2026 w Gdańsku odbył się protest.", temporal: { kind: "jednorazowe", date: "2026-11-20" } }),
    records: [primary("gov:1", { publishedAt: "2026-10-01" }), primary("gov:2", { publishedAt: "2026-09-01" })],
    assessments: [
      asm("gov:1", "OBALA", "sedno", { quote: "Protest zaplanowany na 1 października 2026 r. odwołano." }),
      asm("gov:2", "OBALA", "sedno", { quote: "W 2026 roku w Gdańsku nie zgłoszono zgromadzeń." }),
    ],
    expect: { verdict: "BRAK_DOWODOW", rule: 3 },
  },
  {
    name: "Jednorazowe zdarzenie starsze niż dowód → zwykłe reguły (POTWIERDZONE 7)",
    claim: claim({ temporal: { kind: "jednorazowe", date: "2026-05-01" } }),
    records: [primary("gov:1", { publishedAt: "2026-05-02" })],
    assessments: [asm("gov:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7 },
  },
  {
    name: "Stan (nie jednorazowe) z nowszą datą nie trafia do reguły 3",
    claim: claim({ temporal: { kind: "stan", date: "2026-11-20" } }),
    records: [primary("gov:1", { publishedAt: "2026-06-01" })],
    assessments: [asm("gov:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7 },
  },
  // ── reguła 1
  {
    name: "Opinia → NIE_PODLEGA (1) nawet przy dowodach",
    claim: claim({ type: "opinia", text: "Rząd jest najgorszy w historii." }),
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "OBALA")],
    expect: { verdict: "NIE_PODLEGA", rule: 1, decisive: [], strength: "slaba" },
  },
  {
    name: "Prognoza → NIE_PODLEGA (1)",
    claim: claim({ type: "prognoza", text: "W 2030 roku inflacja spadnie do zera." }),
    records: [],
    assessments: [],
    expect: { verdict: "NIE_PODLEGA", rule: 1 },
  },
  // ── progi dla źródeł wtórnych
  {
    name: "Jedno źródło wtórne → poniżej progu → BRAK (2)",
    records: [secondary("pap:1", "pap")],
    assessments: [asm("pap:1", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: ["pap:1"] },
  },
  {
    name: "Dwa wtórne z tej samej grupy (syndykacja) → nie rozstrzyga → BRAK (2)",
    records: [secondary("pap:1", "pap"), secondary("pap:2", "pap")],
    assessments: [asm("pap:1", "WSPIERA"), asm("pap:2", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Dwa wtórne z różnych grup → rozstrzyga → POTWIERDZONE (7) srednia",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn")],
    assessments: [asm("pap:1", "WSPIERA"), asm("tvn:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["pap:1", "tvn:1"], strength: "srednia", independentPublishers: 2 },
  },
  {
    name: "Trzy wtórne z trzech grup → POTWIERDZONE mocna",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn"), secondary("rmf:1", "rmf")],
    assessments: [asm("pap:1", "WSPIERA"), asm("tvn:1", "WSPIERA"), asm("rmf:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "mocna" },
  },
  {
    name: "Dwa wtórne z różnych grup, ale sprzeczne (wspiera vs obala) → żaden nie rozstrzyga → BRAK (2)",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn")],
    assessments: [asm("pap:1", "WSPIERA"), asm("tvn:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Dwa wtórne z różnych grup, ale różne aspekty → nie rozstrzyga → BRAK (2)",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn")],
    assessments: [asm("pap:1", "WSPIERA", "sedno"), asm("tvn:1", "WSPIERA", "czas")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Analiza poziomu 2 (treść) jest źródłem wtórnym, sama nie rozstrzyga → BRAK (2)",
    records: [rec("eeas:1", { level: 2, type: "analiza" })],
    assessments: [asm("eeas:1", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  // ── wykluczenia
  {
    name: "Wykluczona ocena (excluded) źródła pierwotnego się nie liczy → BRAK (2)",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { excluded: "detector_hit" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, belowThreshold: [] },
  },
  {
    name: "Niezweryfikowany cytat (quoteVerified=false) się nie liczy → BRAK (2)",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { quoteVerified: false })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Wykluczony obalający dowód nie psuje potwierdzenia → POTWIERDZONE (7)",
    records: [primary("eli:1"), primary("eli:2")],
    assessments: [asm("eli:1", "WSPIERA"), asm("eli:2", "OBALA", "sedno", { quoteVerified: false })],
    expect: { verdict: "POTWIERDZONE", rule: 7, decisive: ["eli:1"] },
  },
  {
    name: "Rekord nieobecny w mapie się nie liczy → BRAK (2)",
    records: [],
    assessments: [asm("ghost:1", "WSPIERA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Oceny innego twierdzenia są pomijane → BRAK (2)",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { claimId: "c2" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  // ── weryfikator
  {
    name: "Weryfikator: sprzeciw odbiera rozstrzygalność → BRAK (2), zgoda weryfikatora = sprzeciw",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { verifier: "sprzeciw" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2, verifierAgreement: "sprzeciw", belowThreshold: ["eli:1"] },
  },
  {
    name: "Weryfikator: sprzeciw na jednym z dwóch wtórnych → drugi zostaje sam → BRAK (2)",
    records: [secondary("pap:1", "pap"), secondary("tvn:1", "tvn")],
    assessments: [asm("pap:1", "WSPIERA"), asm("tvn:1", "WSPIERA", "sedno", { verifier: "sprzeciw" })],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
  {
    name: "Weryfikator: sprzeciw na obalającym → potwierdzenie zostaje → POTWIERDZONE (7)",
    records: [primary("eli:1"), primary("eli:2")],
    assessments: [asm("eli:1", "WSPIERA"), asm("eli:2", "OBALA", "sedno", { verifier: "sprzeciw" })],
    expect: { verdict: "POTWIERDZONE", rule: 7 },
  },
  {
    name: "Weryfikator: niepewne tylko obniża siłę (srednia → slaba), werdykt bez zmian",
    records: [primary("eli:1")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { verifier: "niepewne" })],
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "slaba", verifierAgreement: "niepewne" },
  },
  {
    name: "Weryfikator: niepewne przy mocnej podstawie → srednia",
    records: [primary("eli:1"), secondary("pap:1", "pap")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { verifier: "niepewne" }), asm("pap:1", "WSPIERA")],
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "srednia" },
  },
  // ── tryb jednego klucza
  {
    name: "Jeden klucz: pierwotne + niezależne wtórne → mocna (kontrolę krzyżową dają różni wydawcy)",
    records: [primary("eli:1"), secondary("pap:1", "pap")],
    assessments: [asm("eli:1", "WSPIERA"), asm("pap:1", "WSPIERA")],
    singleKey: true,
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "mocna" },
  },
  {
    name: "Jeden klucz: dwa niezależne źródła urzędowe obalają sedno → FALSZYWE (8) mocna",
    records: [primary("prezydent:1", { independenceGroup: "kprp" }), primary("eli:1", { independenceGroup: "dziennik-ustaw" })],
    assessments: [asm("prezydent:1", "OBALA"), asm("eli:1", "OBALA")],
    singleKey: true,
    expect: { verdict: "FALSZYWE", rule: 8, strength: "mocna", primarySources: 2, independentPublishers: 2 },
  },
  {
    name: "Jeden klucz + niepewne: mocna → srednia → slaba",
    records: [primary("eli:1"), secondary("pap:1", "pap")],
    assessments: [asm("eli:1", "WSPIERA", "sedno", { verifier: "niepewne" }), asm("pap:1", "WSPIERA")],
    singleKey: true,
    expect: { verdict: "POTWIERDZONE", rule: 7, strength: "slaba" },
  },
  // ── reguła 8b i 9: obalony aspekt bez dowodu na sedno
  {
    name: "8b: twierdzenie z datą, obalona tylko data, brak dowodu na sedno → FALSZYWE (8)",
    claim: claim({ text: "Ustawa weszła w życie 1 stycznia 2025.", temporal: { kind: "jednorazowe", date: "2025-01-01" } }),
    records: [primary("eli:1", { publishedAt: "2025-02-01" })],
    assessments: [asm("eli:1", "OBALA", "czas")],
    expect: { verdict: "FALSZYWE", rule: 8 },
  },
  {
    name: "Ograniczenie reguły 3: dowód opublikowany PRZED datą zdarzenia (np. zapowiedź) → BRAK (3)",
    claim: claim({ text: "Ustawa weszła w życie 1 stycznia 2025.", temporal: { kind: "jednorazowe", date: "2025-01-01" } }),
    records: [primary("eli:1", { publishedAt: "2024-12-01" })],
    assessments: [asm("eli:1", "OBALA", "czas")],
    expect: { verdict: "BRAK_DOWODOW", rule: 3 },
  },
  {
    name: "8b: twierdzenie z liczbą, obalona tylko liczba → FALSZYWE (8)",
    claim: claim({ text: "W 2024 roku inflacja w Polsce wyniosła 15 procent." }),
    records: [primary("gus:1")],
    assessments: [asm("gus:1", "OBALA", "liczba")],
    expect: { verdict: "FALSZYWE", rule: 8 },
  },
  {
    name: "9: obalone miejsce bez dowodu na sedno → WPROWADZAJACE (9) z nazwanym aspektem",
    records: [primary("gov:1")],
    assessments: [asm("gov:1", "OBALA", "miejsce")],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "miejsce" },
  },
  {
    name: "9: obalona liczba, ale tekst bez cyfr → nie 8b → WPROWADZAJACE (9)",
    claim: claim({ text: "Większość Polaków pracuje za granicą." }),
    records: [primary("gus:1")],
    assessments: [asm("gus:1", "OBALA", "liczba")],
    expect: { verdict: "WPROWADZAJACE", rule: 9 },
  },
  ...reductionCases(),
  {
    name: "Dowody wspierają tylko szczegół (czas), nie sedno → BRAK (2)",
    records: [primary("gov:1")],
    assessments: [asm("gov:1", "WSPIERA", "czas")],
    expect: { verdict: "BRAK_DOWODOW", rule: 2 },
  },
];

// ───────────────────────── runner ─────────────────────────

function run(c: Case): VerdictDecision {
  return decideVerdict({
    claim: c.claim ?? claim(),
    assessments: c.assessments,
    records: new Map(c.records.map((r) => [r.id, r])),
    now: NOW,
    singleKeyVerifier: c.singleKey ?? false,
  });
}

describe("aktualność oceny wydawcy o obecnych zamiarach", () => {
  const reviewed = "Biblioteka zamierza zlikwidować czytelnię.";
  const old = factcheck("redakcja:ocena", R_FALSZ, { publishedAt: "2020-05-10", claimReviewed: reviewed });
  const original = fixedAsm(old.id, "ta_sama", { quote: reviewed });
  const assess = (c: Claim, records = [old], assessments = [original], now = NOW) =>
    decideVerdict({ claim: c, records: new Map(records.map(r => [r.id, r])), assessments, now, singleKeyVerifier: false });

  it("zachowuje starą ocenę w kontekście i wstrzymuje się od oceny zamiaru", () => {
    const result = assess(stan(reviewed));
    expect(result.verdict).toBe("BRAK_DOWODOW");
    expect(result.decisiveRecordIds).toEqual([]);
    expect(result.priorEventRecordIds).toEqual([old.id]);
    expect(result.strength.notes.join(" ")).toContain("obecnego zamiaru");
  });

  it("liczy wiek oceny od publikacji względem dnia pytania", () => {
    const text = "Czytelnia jest zamknięta.";
    const rating = { ...old, claimReviewed: text };
    const evaluated = fixedAsm(rating.id, "ta_sama", { quote: text });
    expect(assess(stan(text), [rating], [evaluated], new Date("2022-05-10T16:00:00Z")).verdict).toBe("FALSZYWE");
    expect(assess(stan(text), [rating], [evaluated], new Date("2022-05-11T00:00:00Z")).verdict).toBe("BRAK_DOWODOW");
    expect(assess(stan(text), [{ ...rating, publishedAt: null, fetchedAt: NOW.toISOString() }], [evaluated]).verdict).toBe("BRAK_DOWODOW");
  });

  it("zachowuje ocenę planu z badanego okresu oraz ocenę uchwalonej decyzji", () => {
    const historical = claim({ text: reviewed, temporal: { kind: "stan", asOf: "2020-05-10" } });
    expect(assess(historical).verdict).toBe("FALSZYWE");
    expect(assess(claim({ text: reviewed, temporal: { kind: "stan", date: "2020-05-10" } })).verdict).toBe("FALSZYWE");
    const decision = "Biblioteka przyjęła plan rozbudowy czytelni.";
    const record = { ...old, claimReviewed: decision };
    expect(assess(claim({ text: decision }), [record], [fixedAsm(record.id, "ta_sama", { quote: decision })]).verdict).toBe("FALSZYWE");
  });

  it.each([
    "Celem biblioteki jest likwidacja czytelni.",
    "Biblioteka dąży do likwidacji czytelni.",
    "Czytelnia jest zamknięta.",
  ])("sprawdza datę recenzji każdego jawnego stanu: %s", text => {
    const item = { ...old, claimReviewed: text };
    const match = fixedAsm(item.id, "ta_sama", { quote: text });
    const oldReviewOnly = assess(stan(text), [item], [match]);
    expect(oldReviewOnly.verdict).toBe("BRAK_DOWODOW");
    expect(oldReviewOnly.priorEventRecordIds).toEqual([item.id]);
    const current = primary("biblioteka:ogloszenie", { publishedAt: "2026-11-20", text });
    const corroborated = assess(stan(text), [item, current], [match, asm(current.id, "WSPIERA", "sedno", { quote: text })]);
    expect(corroborated.verdict).toBe("POTWIERDZONE");
    expect(corroborated.decisiveRecordIds).toEqual([current.id]);
  });

  it("bieżący komunikat rozstrzyga pomimo przeciwnej dawnej oceny", () => {
    const current = primary("biblioteka:komunikat", { publishedAt: "2026-11-20", text: reviewed });
    const result = assess(stan(reviewed), [old, current], [original, asm(current.id, "WSPIERA", "sedno", { quote: reviewed })]);
    expect(result.verdict).toBe("POTWIERDZONE");
    expect(result.decisiveRecordIds).toEqual([current.id]);
    expect(result.strength.independentPublishers).toBe(1);
  });

  it("wiekowej oceny pozytywnej też nie stosuje do obecnego zamiaru w pytaniu angielskim", () => {
    const text = "The railway operator intends to close the station.";
    const record = factcheck("independent:review", R_PRAWDA, { publishedAt: "2020-01-01", claimReviewed: text });
    expect(assess(claim({ text }), [record], [fixedAsm(record.id, "ta_sama", { quote: text })]).verdict).toBe("BRAK_DOWODOW");
  });

  it.each(["Biblioteka zamierza zamknąć czytelnię.", "Celem biblioteki jest zamknięcie czytelni.",
    "Biblioteka dąży do zamknięcia czytelni.", "The library's goal is to close the reading room."])(
    "oddziela przeszłe dementi od aktualnej deklaracji dla %s", text => {
      const archive = primary("urzad:archiwum", { publishedAt: "2022-05-06", fetchedAt: NOW.toISOString() });
      const previous = "Ówczesne doniesienia o likwidacji czytelni były fałszywe.";
      const reading = asm(archive.id, "OBALA", "sedno", { quote: previous });
      for (const publishedAt of ["2022-05-06", null, "2026-11-19"]) {
        const result = assess(stan(text), [{ ...archive, publishedAt, text: previous }], [reading]);
        expect(result.verdict).toBe("BRAK_DOWODOW");
        expect(result.priorEventRecordIds).toEqual([archive.id]);
      }
      const datedReport = "W 2022 roku zarząd zdementował te doniesienia.";
      expect(assess(stan(text), [{ ...archive, publishedAt: "2026-11-19", text: datedReport }],
        [{ ...reading, quote: datedReport }]).verdict).toBe("BRAK_DOWODOW");
      const announces = text;
      const current = primary("urzad:decyzja", { publishedAt: "2026-11-19", text: announces });
      const result = assess(stan(text), [archive, current], [reading, asm(current.id, "WSPIERA", "sedno", { quote: announces })]);
      expect(result.verdict).toBe("POTWIERDZONE");
      expect(result.decisiveRecordIds).toEqual([current.id]);
    });

  it.each([
    ["Biblioteka planuje otworzyć czytelnię.", "Biblioteka planuje zamknąć czytelnię.", "OBALA", "BRAK_DOWODOW"],
    ["Biblioteka planuje otworzyć czytelnię.", "Biblioteka planuje otworzyć świetlicę.", "WSPIERA", "BRAK_DOWODOW"],
    ["Biblioteka planuje otworzyć czytelnię.", "Szkoła planuje otworzyć czytelnię.", "WSPIERA", "BRAK_DOWODOW"],
    ["Biblioteka planuje dołączyć do projektu.", "Biblioteka nie planuje dołączyć do projektu.", "OBALA", "FALSZYWE"],
    ["Biblioteka planuje dołączyć do projektu.", "Biblioteka nie planuje dołączyć do projektu.", "WSPIERA", "BRAK_DOWODOW"],
    ["Biblioteka zamierza otworzyć czytelnię.", "Biblioteka chce otworzyć czytelnię.", "WSPIERA", "BRAK_DOWODOW"],
    ["Biblioteka chce zmiany.", "Biblioteka chce zmiany.", "WSPIERA", "BRAK_DOWODOW"],
    ["Motywacją zarządu jest oszczędność.", "Koszty ogrzewania spadły.", "WSPIERA", "BRAK_DOWODOW"],
    ["Czy celem spółki jest zamknięcie zakładu?", "Celem spółki jest utrzymanie zakładu.", "OBALA", "BRAK_DOWODOW"],
    ["The council plans to repair the bridge.", "The council does not plan to repair the bridge.", "OBALA", "FALSZYWE"],
    ["The council plans to repair the bridge.", "The council plans to paint the bridge.", "WSPIERA", "BRAK_DOWODOW"],
    ["Biblioteka planuje otworzyć czytelnię.", "Czy biblioteka planuje otworzyć czytelnię?", "WSPIERA", "BRAK_DOWODOW"],
  ] as const)("ten sam podmiot i przedmiot nie wystarczają bez danej czynności i zgodnej polaryzacji: %s / %s", (text, quote, relation, verdict) => {
    const source = primary("urzad:komunikat", { text: quote, publishedAt: "2026-11-18" });
    const result = assess(stan(text), [source], [asm(source.id, relation, "sedno", { quote })]);
    expect(result.verdict).toBe(verdict);
    expect(result.decisiveRecordIds).toEqual(verdict === "BRAK_DOWODOW" ? [] : [source.id]);
  });

  it("jedna świeża relacja wtórna z dawną relacją innego wydawcy nie wystarcza do oceny zamiaru", () => {
    const text = "Zarząd planuje remont.";
    const a = secondary("redakcja-a:1", "a", { publishedAt: "2022-01-01", text });
    const b = secondary("redakcja-b:1", "b", { publishedAt: "2026-11-15", text });
    const result = assess(stan(text), [a, b], [asm(a.id, "WSPIERA", "sedno", { quote: text }), asm(b.id, "WSPIERA", "sedno", { quote: text })]);
    expect(result.verdict).toBe("BRAK_DOWODOW");
  });
});

describe("decideVerdict — tabela przypadków (PLAN §4)", () => {
  it("ma co najmniej 35 przypadków", () => {
    expect(cases.length).toBeGreaterThanOrEqual(35);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const d = run(c);
    const e = c.expect;
    expect(d.verdict).toBe(e.verdict);
    expect(d.ruleApplied).toBe(e.rule);
    expect(d.ruleApplied).toBeGreaterThanOrEqual(1);
    expect(d.ruleApplied).toBeLessThanOrEqual(9);
    expect(d.archival).toBe(e.archival ?? false);
    if (e.decisive) expect([...d.decisiveRecordIds].sort()).toEqual([...e.decisive].sort());
    if (e.conflicting === null) expect(d.conflicting).toBeUndefined();
    else if (e.conflicting) {
      expect([...d.conflicting!.supporting].sort()).toEqual([...e.conflicting.supporting].sort());
      expect([...d.conflicting!.refuting].sort()).toEqual([...e.conflicting.refuting].sort());
    }
    if (e.verdict === "BRAK_DOWODOW" && e.rule === 5) expect(d.conflicting).toBeDefined();
    if (e.strength) expect(d.strength.level).toBe(e.strength);
    if (e.missingContextIncludes) expect(d.missingContext ?? "").toContain(e.missingContextIncludes);
    if (e.rule === 9 || e.rule === 4) expect(d.missingContext).toBeTruthy();
    if (e.archivalWarning !== undefined) expect(d.strength.archivalWarning).toBe(e.archivalWarning);
    if (e.verifierAgreement) expect(d.strength.verifierAgreement).toBe(e.verifierAgreement);
    if (e.belowThreshold) expect(d.belowThresholdRecordIds ?? []).toEqual(e.belowThreshold);
    if (e.primarySources !== undefined) expect(d.strength.primarySources).toBe(e.primarySources);
    if (e.independentPublishers !== undefined) expect(d.strength.independentPublishers).toBe(e.independentPublishers);
  });
});

describe("decideVerdict — reguła 8b: notka z porównaniem wartości", () => {
  it("A03: notka mówi, że twierdzenie sprowadza się do daty, i podaje lata obu stron", () => {
    const d = decideVerdict({
      claim: { ...claim({ text: NATO_2004, temporal: { kind: "jednorazowe", date: "2004" } }) },
      assessments: [
        asm("nato:1", "OBALA", "czas", { quote: NATO_LONG }),
        asm("nato:2", "OBALA", "czas", { quote: NATO_LIST }),
      ],
      records: new Map(natoRecs().map((r) => [r.id, r])),
      now: NOW,
      singleKeyVerifier: true,
    });
    expect(d.verdict).toBe("FALSZYWE");
    const notes = d.strength.notes.join(" ");
    expect(notes).toContain("sprowadza się do jednego szczegółu (czas (data))");
    expect(notes).toContain("„1999”");
    expect(notes).toContain("„2004”");
    expect(d.strength.score).not.toBeNull();
  });
});

describe("decideVerdict — karta siły i niezmienniki", () => {
  it("jeden klucz zawsze jest jawny: czynnik przy werdykcie merytorycznym, notka przy braku werdyktu", () => {
    const d = run({ name: "", records: [primary("eli:1")], assessments: [asm("eli:1", "WSPIERA")], singleKey: true, expect: { verdict: "POTWIERDZONE", rule: 7 } });
    const minus = (d.strength.factors ?? []).filter((f) => f.effect === "minus").map((f) => f.textPl).join(" ");
    expect(minus).toContain("tego samego dostawcy");
    const none = run({ name: "", records: [secondary("pap:1", "pap")], assessments: [asm("pap:1", "WSPIERA")], singleKey: true, expect: { verdict: "BRAK_DOWODOW", rule: 2 } });
    expect(none.strength.notes.join(" ")).toContain("tej samej rodziny");
  });

  it("newestEvidenceAt to najnowsza data publikacji z bazy", () => {
    const d = run({
      name: "",
      records: [primary("a:1", { publishedAt: "2025-01-01" }), primary("b:1", { publishedAt: "2026-03-04" })],
      assessments: [asm("a:1", "WSPIERA"), asm("b:1", "WSPIERA")],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(d.strength.newestEvidenceAt).toBe("2026-03-04");
  });

  it("niezależni wydawcy: ta sama grupa liczy się raz", () => {
    const d = run({
      name: "",
      records: [primary("a:1", { independenceGroup: "gov" }), primary("b:1", { independenceGroup: "gov" })],
      assessments: [asm("a:1", "WSPIERA"), asm("b:1", "WSPIERA")],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(d.strength.independentPublishers).toBe(1);
    expect(d.strength.primarySources).toBe(2);
    const one = run({ name: "", records: [primary("a:1", { independenceGroup: "gov" })], assessments: [asm("a:1", "WSPIERA")], expect: { verdict: "POTWIERDZONE", rule: 7 } });
    expect(d.strength.score).toBe(one.strength.score);
  });

  it("BRAK z regułą 2 opisuje materiał poniżej progu w notkach", () => {
    const d = run({ name: "", records: [secondary("pap:1", "pap")], assessments: [asm("pap:1", "WSPIERA")], expect: { verdict: "BRAK_DOWODOW", rule: 2 } });
    expect(d.strength.notes.some((n) => n.includes("poniżej progu"))).toBe(true);
  });

  it("ignoruje pole decisive podane na wejściu (liczy je kod)", () => {
    const d = run({
      name: "",
      records: [secondary("pap:1", "pap")],
      assessments: [asm("pap:1", "WSPIERA", "sedno", { decisive: true })],
      expect: { verdict: "BRAK_DOWODOW", rule: 2 },
    });
    expect(d.verdict).toBe("BRAK_DOWODOW");
  });

  it("jest deterministyczna i nie modyfikuje wejścia", () => {
    const c = cases.find((x) => x.name.startsWith("Nieaktualne"))!;
    const snapshot = JSON.stringify(c.assessments);
    const a = run(c);
    const b = run(c);
    expect(a).toEqual(b);
    expect(JSON.stringify(c.assessments)).toBe(snapshot);
  });

  it("każda reguła 1–9 jest osiągalna w tabeli", () => {
    const rules = new Set(cases.map((c) => c.expect.rule));
    for (let i = 1; i <= 9; i++) expect(rules.has(i)).toBe(true);
  });
});

describe("decideVerdict — punktacja siły (score + czynniki)", () => {
  const stanClaim = claim({ text: "Jakub Siuda to prezydent polski.", temporal: { kind: "stan" } });
  const kprp = (over: Partial<CorpusRecord> = {}) =>
    primary("prezydent:1", { independenceGroup: "kprp", publisher: "Kancelaria Prezydenta RP", publishedAt: "2025-08-06", ...over });
  const du = (over: Partial<CorpusRecord> = {}) =>
    primary("eli:1", { independenceGroup: "dziennik-ustaw", publisher: "Dziennik Ustaw", publishedAt: "2025-11-21", ...over });

  it("oczywisty fałsz z dwóch niezależnych źródeł urzędowych: mocna, ≥ 90 pkt, czynniki nazywają wydawców", () => {
    const d = run({
      name: "",
      claim: stanClaim,
      records: [kprp(), du()],
      assessments: [asm("prezydent:1", "OBALA"), asm("eli:1", "OBALA")],
      singleKey: true,
      expect: { verdict: "FALSZYWE", rule: 8 },
    });
    expect(d.strength.level).toBe("mocna");
    expect(d.strength.score).toBeGreaterThanOrEqual(90);
    const plus = (d.strength.factors ?? []).filter((f) => f.effect === "plus").map((f) => f.textPl).join(" ");
    expect(plus).toContain("2 niezależne źródła pierwotne");
    expect(plus).toContain("Kancelaria Prezydenta RP");
    expect(plus).toContain("Żadne znalezione wiarygodne źródło nie mówi inaczej");
    expect(plus).toContain("aktualne");
    expect(d.strength.notes.join(" ")).not.toContain("ograniczona do średniej");
  });

  it("brak werdyktu merytorycznego → score null, słaba", () => {
    const d = run({ name: "", records: [secondary("pap:1", "pap")], assessments: [asm("pap:1", "WSPIERA")], expect: { verdict: "BRAK_DOWODOW", rule: 2 } });
    expect(d.strength.score).toBeNull();
    expect(d.strength.level).toBe("slaba");
  });

  it("kolejne niezależne, zgodne źródło nigdy nie obniża punktacji", () => {
    const one = run({ name: "", records: [primary("a:1")], assessments: [asm("a:1", "WSPIERA")], expect: { verdict: "POTWIERDZONE", rule: 7 } });
    const two = run({
      name: "",
      records: [primary("a:1"), secondary("pap:1", "pap")],
      assessments: [asm("a:1", "WSPIERA"), asm("pap:1", "WSPIERA")],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    const three = run({
      name: "",
      records: [primary("a:1"), secondary("pap:1", "pap"), primary("b:1")],
      assessments: [asm("a:1", "WSPIERA"), asm("pap:1", "WSPIERA"), asm("b:1", "WSPIERA")],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(two.strength.score!).toBeGreaterThan(one.strength.score!);
    expect(three.strength.score!).toBeGreaterThan(two.strength.score!);
  });

  it("źródło poniżej progu mówiące inaczej obniża punktację i jest nazwane w czynnikach", () => {
    const clean = run({ name: "", records: [primary("a:1")], assessments: [asm("a:1", "WSPIERA")], expect: { verdict: "POTWIERDZONE", rule: 7 } });
    const contested = run({
      name: "",
      records: [primary("a:1"), secondary("blog:1", "blog", { publisher: "Portal X" })],
      assessments: [asm("a:1", "WSPIERA"), asm("blog:1", "OBALA")],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(contested.strength.score!).toBeLessThan(clean.strength.score!);
    const minus = (contested.strength.factors ?? []).filter((f) => f.effect === "minus").map((f) => f.textPl).join(" ");
    expect(minus).toContain("Portal X");
  });

  it("cytat dopasowany niedosłownie i dowód tylko na szczegół obniżają punktację", () => {
    const exact = run({ name: "", records: [primary("a:1")], assessments: [asm("a:1", "WSPIERA")], expect: { verdict: "POTWIERDZONE", rule: 7 } });
    const fuzzy = run({
      name: "",
      records: [primary("a:1")],
      assessments: [asm("a:1", "WSPIERA", "sedno", { quoteMatchScore: 0.92 })],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(fuzzy.strength.score!).toBeLessThan(exact.strength.score!);
  });

  it("stan „teraz” z dowodem starszym niż 2 lata: ostrzeżenie archiwalne i niższa punktacja", () => {
    const fresh = run({ name: "", claim: stanClaim, records: [kprp(), du()], assessments: [asm("prezydent:1", "OBALA"), asm("eli:1", "OBALA")], expect: { verdict: "FALSZYWE", rule: 8 } });
    const old = run({
      name: "",
      claim: stanClaim,
      records: [kprp({ publishedAt: "2020-01-01" }), du({ publishedAt: "2020-02-01" })],
      assessments: [asm("prezydent:1", "OBALA"), asm("eli:1", "OBALA")],
      expect: { verdict: "FALSZYWE", rule: 8 },
    });
    expect(old.strength.archivalWarning).toBe(true);
    expect(old.strength.score!).toBeLessThan(fresh.strength.score!);
  });

  it("jedno źródło + jeden klucz: kontrola dosłowna (inna liczba w cytacie) podnosi do mocnej", () => {
    const kadencja = claim({ text: "Kadencja Sejmu trwa 5 lat.", temporal: { kind: "stan" } });
    const withLiteral = run({
      name: "",
      claim: kadencja,
      records: [primary("konst:1", { publisher: "Dziennik Ustaw" })],
      assessments: [asm("konst:1", "OBALA", "sedno", { quote: "Kadencja Sejmu i Senatu trwa 4 lata." })],
      singleKey: true,
      expect: { verdict: "FALSZYWE", rule: 8 },
    });
    expect(withLiteral.strength.level).toBe("mocna");
    expect((withLiteral.strength.factors ?? []).some((f) => f.effect === "plus" && f.textPl.includes("porównał liczby"))).toBe(true);
    const without = run({
      name: "",
      claim: kadencja,
      records: [primary("konst:1")],
      assessments: [asm("konst:1", "OBALA", "sedno", { quote: "Posłowie są przedstawicielami Narodu." })],
      singleKey: true,
      expect: { verdict: "FALSZYWE", rule: 8 },
    });
    expect(without.strength.level).toBe("srednia");
  });

  it("niepewny drugi model obniża siłę o poziom przy jednym źródle", () => {
    const d = run({
      name: "",
      records: [primary("a:1")],
      assessments: [asm("a:1", "WSPIERA", "sedno", { verifier: "niepewne" })],
      expect: { verdict: "POTWIERDZONE", rule: 7 },
    });
    expect(d.strength.level).toBe("slaba");
    expect((d.strength.factors ?? []).some((f) => f.effect === "minus" && f.textPl.includes("nie był pewien"))).toBe(true);
  });
});
