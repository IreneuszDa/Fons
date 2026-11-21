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
    name: "B: CZESCIOWO z pierwotnego przy wspartym sednie → WPROWADZAJACE (9)",
    records: [primary("gus:1"), primary("gus:2")],
    assessments: [asm("gus:1", "WSPIERA"), asm("gus:2", "CZESCIOWO", "zakres")],
    expect: { verdict: "WPROWADZAJACE", rule: 9, missingContextIncludes: "tylko część" },
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
    name: "Stan: nowsze obalające jest tylko wtórne (nie urzędowe) → nie reguła 4, lecz 5",
    claim: stan(),
    records: [
      primary("gus:2022", { period: "2022", publishedAt: "2023-01-15" }),
      secondary("pap:1", "pap", { period: "2025", publishedAt: "2026-01-15" }),
      secondary("tvn:1", "tvn", { period: "2025", publishedAt: "2026-01-16" }),
    ],
    assessments: [asm("gus:2022", "WSPIERA"), asm("pap:1", "OBALA"), asm("tvn:1", "OBALA")],
    expect: { verdict: "BRAK_DOWODOW", rule: 5 },
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
    expect(plus).toContain("2 niezależne źródła urzędowe");
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
