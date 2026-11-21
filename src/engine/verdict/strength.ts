/**
 * Karta siły podstawy (PLAN §4 „Siła podstawy”) — jawna punktacja 0–100 liczona w kodzie.
 *
 * Idea: każda NIEZALEŻNA grupa wydawców w podstawie to osobny „głos”. Głos ma wagę zależną od rodzaju
 * źródła; głosy łączymy jak niezależne potwierdzenia: pewność = 1 − Π(1 − waga). Potem mnożymy przez
 * wiarygodność ODCZYTU cytatów (drugi model, jego niezależność) i przez kary (sprzeczne źródła poniżej
 * progu, materiał archiwalny). Każdy krok dopisuje czytelny czynnik do `factors`.
 *
 * Wagi głosów (najlepszy dowód w grupie):
 *   źródło urzędowe / pierwotne (poziom 1, treść)            0.90
 *   ocena fact-checkera IFCN/EFCSN lub bazy organizatora      0.85
 *   analiza instytucji (poziom 2, treść)                      0.60
 *   wiarygodne źródło wtórne (poziom 3)                       0.50
 *   cytat dopasowany niedosłownie (< 0.98)                    × 0.95
 *   dowód tylko na szczegół (nie sedno)                       × 0.90
 *
 * Odczyt cytatów (mnożnik):
 *   drugi model potwierdził wszystkie cytaty podstawy         1.00
 *   część cytatów bez drugiej kontroli                        0.90
 *   drugi model niepewny choć jednego cytatu                  0.65 (0.85, gdy kontrola dosłowna potwierdza)
 *   niezależność drugiego modelu: inny dostawca 0.99; ten sam dostawca 0.96 przy ≥ 2 niezależnych
 *   grupach, 0.90 przy jednej grupie (pojedynczego źródła nic nie kontroluje krzyżowo, a model
 *   z tej samej rodziny może powtórzyć ten sam błąd odczytu).
 *   Kontrola dosłowna w kodzie (literal.ts: nazwy i liczby twierdzenia vs cytat, bez modelu) jest
 *   niezależną kontrolą odczytu: gdy potwierdza dowód podstawy, pojedyncze źródło przy weryfikatorze
 *   tej samej rodziny liczymy jak przy ≥ 2 grupach (0.96), a cytaty bez drugiej kontroli 0.96 zamiast 0.90.
 *
 * Kary: każdy policzony, niezawetowany dowód POZA podstawą, który mówi przeciwnie niż werdykt
 * (POTWIERDZONE ↔ obala/częściowo; FAŁSZYWE ↔ wspiera ten sam aspekt) → × (1 − 0.5 · jego waga);
 * twierdzenie o stanie „teraz”, którego najnowszy dowód ma > 24 miesiące → × 0.85.
 *
 * Poziom: mocna ≥ 85, średnia ≥ 60, w przeciwnym razie słaba. Reguły bez werdyktu merytorycznego
 * (1, 2, 3, 5) → słaba i score = null.
 *
 * Kalibracja (zgoda drugiego modelu innego dostawcy, cytat dosłowny):
 *   jedno źródło urzędowe 89 (mocna) · dwa niezależne urzędowe 98 · urzędowe + wtórne 94
 *   jeden fact-check 84 (średnia) · dwa fact-checki 97 · dwa wtórne 74 (średnia) · trzy wtórne 87
 * Tryb jednego klucza: jedno źródło urzędowe 81 (średnia), a z potwierdzeniem kontroli dosłownej 86 (mocna);
 * dwa niezależne urzędowe 95 (mocna).
 *
 * Pozostałe pola karty (bez zmian znaczenia):
 *  - primarySources / independentPublishers liczone na podstawie + dowodach z nią zgodnych
 *    (ten sam aspekt i kierunek, także poniżej progu) — „liczba potwierdzeń wpływa tylko na siłę”;
 *  - archivalWarning: reguła 4 albo stan „teraz” z najnowszym dowodem starszym niż 24 miesiące;
 *  - verifierAgreement: „niepewne” / „zgoda” / „sprzeciw” (puste podstawy po wecie) / „brak”.
 */
import type {
  Claim,
  Strength,
  StrengthCard,
  StrengthFactor,
  Verdict,
  VerifierVote,
} from "../../shared/contracts";
import { freshnessDate, type Ev } from "./evidence";
import { literalCheck, literalFactorPl } from "./literal";
import { monthsBefore } from "./periods";
import { NOTE, plural } from "./texts";

export const ARCHIVAL_MONTHS = 24;

const NO_MERIT_RULES = new Set([1, 2, 3, 5]);

export const STRENGTH_THRESHOLDS = { mocna: 85, srednia: 60 } as const;

export const SOURCE_WEIGHT = {
  primary: 0.9,
  fixed: 0.85,
  analysis: 0.6,
  secondary: 0.5,
} as const;

export const READING = {
  allConfirmed: 1,
  partlyUnchecked: 0.9,
  unsure: 0.65,
  /** Drugi model niepewny, ale kod (kontrola dosłowna) potwierdził odczyt — dwie z trzech kontroli „za”, żadna „przeciw”. */
  unsureLiteral: 0.85,
  otherFamily: 0.99,
  sameFamilyMulti: 0.96,
  sameFamilySingle: 0.9,
} as const;

const FUZZY_QUOTE = 0.98;
const FUZZY_FACTOR = 0.95;
const DETAIL_FACTOR = 0.9;
const COUNTER_PENALTY = 0.5;
const ARCHIVAL_FACTOR = 0.85;
/** Odczyt potwierdzony przez kontrolę dosłowną (zamiast 0.90 przy jednym źródle / cytatach bez drugiej kontroli). */
const LITERAL_READING = 0.96;

export interface StrengthArgs {
  claim: Claim;
  now: Date;
  rule: number;
  /** Werdykt — wyznacza kierunek, względem którego liczymy dowody przeciwne. */
  verdict: Verdict;
  basis: Ev[];
  counted: Ev[];
  vetoedCount: number;
  singleKeyVerifier: boolean;
  archival: boolean;
  extraNotes: string[];
}

export function alignedEvidence(basis: Ev[], counted: Ev[]): Ev[] {
  const set = new Set<Ev>(basis);
  for (const e of counted) {
    if (e.a.verifier === "sprzeciw" || e.polarity === "none") continue;
    if (e.kind === "fixed_unqualified") continue;
    if (basis.some((b) => b.aspect === e.aspect && b.polarity === e.polarity)) set.add(e);
  }
  return [...set];
}

/** Waga pojedynczego dowodu jako głosu (0–1). */
export function evidenceWeight(e: Ev): number {
  let w: number;
  if (e.kind === "primary") w = SOURCE_WEIGHT.primary;
  else if (e.kind === "fixed") w = SOURCE_WEIGHT.fixed;
  else if (e.kind === "fixed_unqualified") return 0;
  else w = e.r.level === 2 ? SOURCE_WEIGHT.analysis : SOURCE_WEIGHT.secondary;
  // Fact-check: werdykt bierzemy z oceny, a nie z cytatu — dopasowanie cytatu nie ma tu znaczenia.
  if (e.kind !== "fixed" && quoteScore(e) < FUZZY_QUOTE) w *= FUZZY_FACTOR;
  if (e.aspect !== "sedno") w *= DETAIL_FACTOR;
  return w;
}

/** quoteMatchScore bywa w skali 0–1 (quotes.ts) albo 0–100 (starsze dane) — sprowadzamy do 0–1. */
function quoteScore(e: Ev): number {
  const s = e.a.quoteMatchScore;
  if (!Number.isFinite(s)) return 0;
  return s > 1 ? s / 100 : s;
}

interface Group {
  id: string;
  best: Ev;
  weight: number;
}

/** Najlepszy dowód w każdej grupie niezależności (ta sama grupa / przedruk = jeden głos). */
function groupsOf(evs: Ev[]): Group[] {
  const by = new Map<string, Group>();
  for (const e of evs) {
    const w = evidenceWeight(e);
    if (w <= 0) continue;
    const g = by.get(e.r.independenceGroup);
    if (!g || w > g.weight) by.set(e.r.independenceGroup, { id: e.r.independenceGroup, best: e, weight: w });
  }
  return [...by.values()].sort((a, b) => b.weight - a.weight);
}

function combine(weights: number[]): number {
  return 1 - weights.reduce((acc, w) => acc * (1 - w), 1);
}

function levelFor(score: number): Strength {
  if (score >= STRENGTH_THRESHOLDS.mocna) return "mocna";
  if (score >= STRENGTH_THRESHOLDS.srednia) return "srednia";
  return "slaba";
}

/** Kierunek werdyktu: dowody o przeciwnym kierunku obniżają siłę. */
function opposes(verdict: Verdict, e: Ev, basis: Ev[]): boolean {
  if (verdict === "POTWIERDZONE") return e.polarity === "refute" || e.polarity === "partial";
  if (verdict === "FALSZYWE") return e.polarity === "support" && basis.some((b) => b.aspect === e.aspect);
  return false;
}

function publishersList(groups: Group[], max = 3): string {
  const names = [...new Set(groups.map((g) => g.best.r.publisher))];
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} i ${names.length - max} inne` : shown;
}

function sourcesFactor(groups: Group[]): StrengthFactor[] {
  const out: StrengthFactor[] = [];
  const primary = groups.filter((g) => g.best.kind === "primary");
  const fixed = groups.filter((g) => g.best.kind === "fixed");
  const other = groups.filter((g) => g.best.kind === "secondary");
  if (primary.length >= 2) {
    out.push({ effect: "plus", textPl: `${primary.length} niezależne źródła urzędowe mówią to samo: ${publishersList(primary)}.` });
  } else if (primary.length === 1) {
    out.push({ effect: "plus", textPl: `Źródło urzędowe lub pierwotne: ${publishersList(primary)}.` });
  }
  if (fixed.length > 0) {
    const ratings = [...new Set(fixed.map((g) => g.best.r.rating?.raw).filter((x): x is string => !!x))];
    const rated = ratings.length > 0 ? ` (ocena: „${ratings.join("”, „")}”)` : "";
    out.push({
      effect: "plus",
      textPl: `${fixed.length === 1 ? "Ocena organizacji" : `Oceny ${fixed.length} organizacji`} sprawdzających fakty: ${publishersList(fixed)}${rated}.`,
    });
  }
  if (other.length > 0) {
    out.push({
      effect: "plus",
      textPl: `${other.length} ${plural(other.length, "niezależne źródło wtórne", "niezależne źródła wtórne", "niezależnych źródeł wtórnych")}: ${publishersList(other)}.`,
    });
  }
  if (groups.length === 1) {
    out.push({ effect: "minus", textPl: "Dowody pochodzą tylko od jednego niezależnego wydawcy." });
  }
  return out;
}

export function computeStrength(args: StrengthArgs): StrengthCard {
  const { basis, counted, rule } = args;
  const notes: string[] = [...args.extraNotes];
  const factors: StrengthFactor[] = [];
  const aligned = alignedEvidence(basis, counted);

  const primaryIds = new Set(aligned.filter((e) => e.kind === "primary").map((e) => e.r.id));
  const groupIds = new Set(aligned.map((e) => e.r.independenceGroup));

  // Najnowszy dowód podstawy (data publikacji jako tekst z bazy).
  let newestAt: string | null = null;
  let newestMs = -Infinity;
  for (const e of basis) {
    if (e.r.publishedAt && e.published && e.published.end > newestMs) {
      newestMs = e.published.end;
      newestAt = e.r.publishedAt;
    }
  }

  let archivalWarning = args.archival;
  let staleState = false;
  if (!archivalWarning && args.claim.temporal.kind === "stan" && basis.length > 0 && rule !== 1) {
    const fresh = basis.map(freshnessDate).filter((x): x is number => x !== undefined);
    if (fresh.length === 0) {
      notes.push(NOTE.noDates);
    } else if (Math.max(...fresh) < monthsBefore(args.now, ARCHIVAL_MONTHS)) {
      archivalWarning = true;
      staleState = true;
      notes.push(NOTE.archival);
    }
  }

  // Głos weryfikatora dla podstawy.
  const votes = basis.map((e) => e.a.verifier);
  let verifierAgreement: VerifierVote;
  if (votes.length === 0) {
    verifierAgreement = args.vetoedCount > 0 ? "sprzeciw" : "brak";
  } else if (votes.includes("niepewne")) {
    verifierAgreement = "niepewne";
  } else if (votes.every((v) => v === "zgoda")) {
    verifierAgreement = "zgoda";
  } else {
    verifierAgreement = "brak";
    if (votes.includes("zgoda")) notes.push(NOTE.verifierPartial);
  }
  if (args.vetoedCount > 0) notes.push(NOTE.vetoed(args.vetoedCount));
  if (args.singleKeyVerifier) notes.push(NOTE.singleKey);

  const base = {
    primarySources: primaryIds.size,
    independentPublishers: groupIds.size,
    newestEvidenceAt: newestAt,
    archivalWarning,
    verifierAgreement,
  };

  if (NO_MERIT_RULES.has(rule) || basis.length === 0) {
    return { level: "slaba", score: null, factors: [], ...base, notes: [...new Set(notes)] };
  }

  // 1) Głosy niezależnych grup.
  const groups = groupsOf(aligned);
  let score = combine(groups.map((g) => g.weight));
  factors.push(...sourcesFactor(groups));
  if (groups.some((g) => g.best.kind !== "fixed" && quoteScore(g.best) < FUZZY_QUOTE)) {
    factors.push({ effect: "minus", textPl: "Część cytatów pasuje do źródła z drobnymi różnicami w zapisie." });
  }
  if (groups.length > 0 && groups.every((g) => g.best.aspect !== "sedno")) {
    factors.push({ effect: "minus", textPl: "Źródła mówią o szczególe (np. dacie lub liczbie), a nie o całej informacji." });
  }

  // 2) Wiarygodność odczytu cytatów. Najpierw kontrola dosłowna (kod, bez modelu) — tylko dla jasnych werdyktów.
  const wanted = args.verdict === "POTWIERDZONE" ? "WSPIERA" : args.verdict === "FALSZYWE" ? "OBALA" : null;
  let literalText: string | null = null;
  if (wanted) {
    for (const g of groups) {
      if (g.best.kind === "fixed" || g.best.a.relation !== wanted) continue;
      const lit = literalCheck(args.claim.text, g.best.a.quote, wanted);
      literalText = literalFactorPl(lit);
      if (literalText) break;
    }
  }
  if (literalText) factors.push({ effect: "plus", textPl: literalText });

  if (votes.includes("niepewne")) {
    score *= literalText ? READING.unsureLiteral : READING.unsure;
    factors.push({
      effect: "minus",
      textPl: literalText
        ? "Drugi model nie był pewien odczytu cytatu (kontrola dosłowna w kodzie go jednak potwierdza)."
        : "Drugi model nie był pewien, czy cytat znaczy to, co ocenił pierwszy.",
    });
  } else if (votes.length > 0 && votes.every((v) => v === "zgoda")) {
    score *= READING.allConfirmed;
    factors.push({ effect: "plus", textPl: "Drugi model niezależnie potwierdził odczyt każdego cytatu." });
  } else {
    score *= literalText ? LITERAL_READING : READING.partlyUnchecked;
    factors.push({ effect: "minus", textPl: "Nie każdy cytat sprawdził drugi model." });
  }
  const verifierVoted = votes.some((v) => v === "zgoda" || v === "niepewne");
  if (args.singleKeyVerifier && verifierVoted) {
    const single = groups.length < 2;
    score *= single && !literalText ? READING.sameFamilySingle : READING.sameFamilyMulti;
    factors.push({
      effect: "minus",
      textPl: !single
        ? "Drugi model jest tego samego dostawcy co główny; niezależność zapewniają tu zgodne źródła od różnych wydawców."
        : literalText
          ? "Drugi model jest tego samego dostawcy co główny; niezależnie od modeli odczyt potwierdziła kontrola dosłowna w kodzie."
          : "Drugi model jest tego samego dostawcy co główny, a źródło jest jedno — brak niezależnej kontroli krzyżowej.",
    });
  } else if (verifierVoted) {
    score *= READING.otherFamily;
  }

  // 3) Dowody przeciwne (poza podstawą, niezawetowane) — także poniżej progu.
  const basisSet = new Set(basis);
  const counter = counted.filter(
    (e) => !basisSet.has(e) && e.a.verifier !== "sprzeciw" && e.kind !== "fixed_unqualified" && opposes(args.verdict, e, basis),
  );
  const counterGroups = groupsOf(counter);
  for (const g of counterGroups) score *= 1 - COUNTER_PENALTY * g.weight;
  if (counterGroups.length > 0) {
    factors.push({
      effect: "minus",
      textPl: `${counterGroups.length} ${plural(counterGroups.length, "źródło mówi", "źródła mówią", "źródeł mówi")} inaczej (za mało, by zmienić wynik): ${publishersList(counterGroups)}.`,
    });
  } else if (args.verdict === "POTWIERDZONE" || args.verdict === "FALSZYWE") {
    factors.push({ effect: "plus", textPl: "Żadne znalezione wiarygodne źródło nie mówi inaczej." });
  }

  // 4) Aktualność (tylko stan „teraz”; reguła 4 sama jest o nieaktualności).
  if (staleState) {
    score *= ARCHIVAL_FACTOR;
    factors.push({ effect: "minus", textPl: "Najnowszy dowód ma ponad 2 lata — sytuacja mogła się zmienić." });
  } else if (args.claim.temporal.kind === "stan" && newestAt && !args.archival) {
    factors.push({ effect: "plus", textPl: "Dowody są aktualne (z ostatnich 2 lat)." });
  }

  const points = Math.max(0, Math.min(100, Math.round(score * 100)));
  // Plusy przed minusami, w kolejności dodania.
  const ordered = [...factors.filter((f) => f.effect === "plus"), ...factors.filter((f) => f.effect === "minus")];
  // Notki, które czynniki już opisują, nie powtarzamy (kanały pokazują czynniki i notki obok siebie).
  const covered = new Set<string>([NOTE.singleKey, NOTE.archival, NOTE.verifierPartial]);
  const restNotes = [...new Set(notes)].filter((n) => !covered.has(n));
  return { level: levelFor(points), score: points, factors: ordered, ...base, notes: restNotes };
}
