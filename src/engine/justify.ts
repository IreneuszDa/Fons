/**
 * Step 8 — justification from Polish templates filled with report fields (default).
 * Optional smoothing by a small model behind a flag (off by default) with a validator:
 * no URLs, no digits absent from the template/quotes, no verdict word other than the computed one.
 * Any rejection falls back to the template.
 */
import {
  VERDICT_LABEL_PL,
  type Aspect,
  type Claim,
  type CorpusRecord,
  type EvidenceAssessment,
  type LlmProvider,
  type ModelUsage,
  type Verdict,
} from "../shared/contracts";
import { fence } from "./llm/fence";
import { SMOOTH_SYSTEM, SmoothOut } from "./prompts";
import { foldForMatch, formatDatePl } from "./text";
import { plural } from "./verdict/texts";

/** The part of the rules module's decision that the templates need. */
export interface DecisionLike {
  verdict: Verdict;
  ruleApplied: number;
  decisiveRecordIds: string[];
  missingContext?: string;
  conflicting?: { supporting: string[]; refuting: string[] };
  archival: boolean;
}

export interface JustifyInput {
  claim: Claim;
  decision: DecisionLike;
  assessments: EvidenceAssessment[];
  records: Map<string, CorpusRecord>;
  /** Polish names of the search branches that worked. */
  searchedPl: string[];
  /** Polish names of branches that failed. */
  unavailablePl: string[];
  verdictMode: "rules" | "model_proposed";
}

export interface Justification {
  reasonPl: string;
  triedPl?: string;
  missingContext?: string;
}

const ASPECT_PL: Record<Aspect, string> = {
  sedno: "sedno sprawy",
  czas: "czas (kiedy to było)",
  miejsce: "miejsce",
  liczba: "liczby",
  autorstwo: "autorstwo (kto to powiedział lub zrobił)",
  zakres: "zakres (kogo lub czego to dotyczy)",
};

function cite(r: CorpusRecord | undefined, quote: string): string {
  if (!r) return `„${quote}”`;
  return `${r.publisher} (${formatDatePl(r.publishedAt)}): „${quote}”`;
}

function usable(a: EvidenceAssessment): boolean {
  return a.quoteVerified && !a.excluded && a.relation !== "BEZ_ZWIAZKU";
}

function pick(input: JustifyInput, relation: EvidenceAssessment["relation"][]): EvidenceAssessment | undefined {
  const cands = input.assessments.filter((a) => usable(a) && relation.includes(a.relation));
  return (
    cands.find((a) => input.decision.decisiveRecordIds.includes(a.recordId)) ??
    cands.sort((x, y) => (input.records.get(x.recordId)?.level ?? 3) - (input.records.get(y.recordId)?.level ?? 3))[0]
  );
}

/**
 * Zdanie otwierające dla FAŁSZYWE / POTWIERDZONE: ile niezależnych źródeł (grup wydawców) mówi to samo
 * i jakiego są rodzaju — liczone z tych samych dowodów co karta siły (ten sam kierunek i aspekt co
 * dowód główny, cytat sprawdzony, bez weta). Wydawcy, daty i liczby pochodzą z bazy, nie z modelu.
 */
function corroboration(
  input: JustifyInput,
  top: EvidenceAssessment,
  verb: { one: string; many: string },
): string {
  const same = input.assessments.filter(
    (a) => usable(a) && a.relation === top.relation && a.aspect === top.aspect && a.verifier !== "sprzeciw",
  );
  const groups = new Map<string, CorpusRecord>();
  for (const a of same) {
    const r = input.records.get(a.recordId);
    if (!r || r.role !== "tresc") continue;
    const prev = groups.get(r.independenceGroup);
    if (!prev || r.level < prev.level) groups.set(r.independenceGroup, r);
  }
  const topRecord = input.records.get(top.recordId);
  const recs = [...groups.values()];
  const n = recs.length;
  const allOfficial = n > 0 && recs.every((r) => r.level === 1);
  const someOfficial = recs.some((r) => r.level === 1);
  const names = [...new Set(recs.map((r) => r.publisher))];
  const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} i ${names[names.length - 1]}`;
  let lead: string;
  if (n >= 2) {
    const kind = allOfficial
      ? plural(n, "niezależne źródło urzędowe", "niezależne źródła urzędowe", "niezależnych źródeł urzędowych")
      : `${plural(n, "niezależne wiarygodne źródło", "niezależne wiarygodne źródła", "niezależnych wiarygodnych źródeł")}${someOfficial ? ", w tym urzędowe" : ""}`;
    lead = `${verb.many} ${n} ${kind}: ${list}.`;
  } else {
    const kind = topRecord?.level === 1 ? "źródło urzędowe" : "wiarygodne źródło";
    // Wydawcę podaje zaraz potem cytat — nie powtarzamy go.
    lead = `${verb.one} ${kind}.`;
  }
  return lead;
}

function missingContextPl(input: JustifyInput): string | undefined {
  const mc = input.decision.missingContext?.trim();
  if (mc) return (ASPECT_PL as Record<string, string>)[mc] ? `nie zgadza się ${ASPECT_PL[mc as Aspect]}` : mc;
  const refuted = input.assessments.find((a) => usable(a) && a.relation === "OBALA" && a.aspect !== "sedno");
  if (refuted) return `nie zgadza się ${ASPECT_PL[refuted.aspect]}`;
  const partial = input.assessments.find((a) => usable(a) && (a.relation === "CZESCIOWO" || a.relation === "INNY_KONTEKST"));
  if (partial) return `źródło mówi o innym kontekście (${ASPECT_PL[partial.aspect]})`;
  return undefined;
}

export function buildTriedPl(input: JustifyInput): string {
  const total = input.assessments.length;
  const below = input.assessments.filter(
    (a) => !a.excluded && a.relation !== "BEZ_ZWIAZKU" && !input.decision.decisiveRecordIds.includes(a.recordId),
  ).length;
  const rejected = input.assessments.filter((a) =>
    ["quote_not_found", "quote_too_short", "detector_hit", "verifier_dissent"].includes(a.excluded ?? ""),
  ).length;
  const parts: string[] = [];
  if (input.searchedPl.length) parts.push(`Szukaliśmy w: ${input.searchedPl.join(", ")}.`);
  if (input.unavailablePl.length > 0) parts.push(`Nie udało się sprawdzić w: ${input.unavailablePl.join(", ")}.`);
  if (total === 0) {
    parts.push("Nie znaleźliśmy żadnego fragmentu źródła na ten temat.");
  } else {
    parts.push(`Przeczytaliśmy fragmenty źródeł: ${total}.`);
    if (below > 0) parts.push(`Na temat, ale bez rozstrzygnięcia: ${below}.`);
    if (rejected > 0) parts.push(`Odrzucone, bo cytat nie zgadzał się ze źródłem albo nie przeszedł kontroli: ${rejected}.`);
  }
  if (input.decision.ruleApplied === 3 && input.claim.temporal.date) {
    parts.push(`Zabrakło źródła nowszego niż data zdarzenia (${formatDatePl(input.claim.temporal.date)}).`);
  } else if (input.decision.conflicting) {
    parts.push("Zabrakło zgodności między źródłami.");
  } else {
    parts.push(
      "Zabrakło źródła urzędowego, oceny organizacji fact-checkingowej albo dwóch niezależnych źródeł, które wprost to potwierdzają lub obalają.",
    );
  }
  return parts.join(" ");
}

export function buildJustification(input: JustifyInput): Justification {
  const { claim, decision } = input;
  const v = decision.verdict;

  if (v === "NIE_PODLEGA") {
    const what = claim.type === "prognoza" ? "przewidywanie dotyczące przyszłości" : "opinia albo ocena";
    return { reasonPl: `To ${what}, a nie fakt, który można sprawdzić w źródłach. Dlatego nie oceniamy jego prawdziwości.` };
  }

  if (v === "POTWIERDZONE") {
    const a = pick(input, ["WSPIERA"]);
    const r = a ? input.records.get(a.recordId) : undefined;
    if (a && r?.role === "stala_rola") {
      return {
        reasonPl:
          a.fixedRoleMatch === "zaprzeczona"
            ? `Organizacja sprawdzająca fakty oceniła jako nieprawdziwe twierdzenie przeciwne (ocena: „${r.rating?.raw ?? "fałsz"}”), więc to twierdzenie jest prawdziwe. ${cite(r, a.quote)}`
            : `Organizacja sprawdzająca fakty oceniła to twierdzenie jako prawdziwe (ocena: „${r.rating?.raw ?? "prawda"}”). ${cite(r, a.quote)}`,
      };
    }
    if (!a) return { reasonPl: "Wiarygodne źródła potwierdzają to twierdzenie." };
    return { reasonPl: `${corroboration(input, a, { one: "Potwierdza to", many: "Potwierdzają to" })} ${cite(r, a.quote)}` };
  }

  if (v === "FALSZYWE") {
    const a = pick(input, ["OBALA"]);
    const r = a ? input.records.get(a.recordId) : undefined;
    if (a && r?.role === "stala_rola") {
      return {
        reasonPl:
          a.fixedRoleMatch === "zaprzeczona"
            ? `Organizacja sprawdzająca fakty oceniła jako prawdziwe twierdzenie przeciwne (ocena: „${r.rating?.raw ?? "prawda"}”), więc to twierdzenie jest nieprawdziwe. ${cite(r, a.quote)}`
            : `Organizacja sprawdzająca fakty oceniła to twierdzenie jako nieprawdziwe (ocena: „${r.rating?.raw ?? "fałsz"}”). ${cite(r, a.quote)}`,
      };
    }
    if (!a) return { reasonPl: "Wiarygodne źródła przeczą temu twierdzeniu." };
    return { reasonPl: `${corroboration(input, a, { one: "Przeczy temu", many: "Przeczą temu" })} ${cite(r, a.quote)}` };
  }

  if (v === "WPROWADZAJACE") {
    const missing = missingContextPl(input);
    if (decision.archival) {
      const old = pick(input, ["WSPIERA"]);
      const fresh = pick(input, ["OBALA"]);
      const ro = old ? input.records.get(old.recordId) : undefined;
      const rf = fresh ? input.records.get(fresh.recordId) : undefined;
      const parts = ["To twierdzenie było kiedyś prawdziwe, ale jest nieaktualne."];
      if (old) parts.push(`Starsze źródło: ${cite(ro, old.quote)}`);
      if (fresh) parts.push(`Nowsze dane: ${cite(rf, fresh.quote)}`);
      return { reasonPl: parts.join(" "), missingContext: missing ?? "dane są nieaktualne" };
    }
    const a = pick(input, ["CZESCIOWO", "INNY_KONTEKST", "OBALA", "WSPIERA"]);
    const r = a ? input.records.get(a.recordId) : undefined;
    const parts = ["Część twierdzenia się zgadza, ale brakuje ważnego kontekstu."];
    if (missing) parts.push(`Brakujący kontekst: ${/[.!?…]$/.test(missing.trim()) ? missing.trim() : `${missing.trim()}.`}`);
    if (a) parts.push(cite(r, a.quote));
    return { reasonPl: parts.join(" "), ...(missing ? { missingContext: missing } : {}) };
  }

  // BRAK_DOWODOW
  const tried = buildTriedPl(input);
  if (decision.conflicting && (decision.conflicting.supporting.length > 0 || decision.conflicting.refuting.length > 0)) {
    const side = (ids: string[]) =>
      ids
        .map((id) => input.records.get(id))
        .filter((r): r is CorpusRecord => !!r)
        .map((r) => `${r.publisher} (${formatDatePl(r.publishedAt)})`)
        .join(", ") || "brak";
    return {
      reasonPl:
        `Źródła są ze sobą sprzeczne, dlatego nie rozstrzygamy. Za: ${side(decision.conflicting.supporting)}. ` +
        `Przeciw: ${side(decision.conflicting.refuting)}. Nie wskazujemy, które ma rację — przeczytaj oba.`,
      triedPl: tried,
    };
  }
  if (decision.ruleApplied === 3) {
    return {
      reasonPl: "To zdarzenie jest nowsze niż dowody, które mamy w bazie. Starsze, podobne zdarzenia go nie obalają.",
      triedPl: tried,
    };
  }
  if (isUnconfirmedAfterLiveSearch(input)) {
    return {
      reasonPl:
        "Żadne wiarygodne źródło, które przeszukaliśmy — także na żywo w serwisach urzędowych i u fact-checkerów — tego nie potwierdza. " +
        "Gdyby tak ważna rzecz się wydarzyła, powinny o niej pisać źródła urzędowe. Traktuj tę informację jako niepotwierdzoną i nie przekazuj jej dalej, dopóki nie znajdziesz wiarygodnego źródła.",
      triedPl: tried,
    };
  }
  return {
    reasonPl: "Nie znaleźliśmy w wiarygodnych źródłach dowodu, który pozwalałby to rozstrzygnąć.",
    triedPl: tried,
  };
}

/**
 * Sygnał ostrzegawczy dla BRAK_DOWODÓW (werdykt bez zmian): fakt, wyszukiwanie na żywo zadziałało, a żaden
 * przeczytany fragment nie mówi o sprawie (wszystkie „bez związku” albo nic). Typowa sytuacja wymyślonego zdarzenia —
 * nikt mu wprost nie zaprzecza, ale też nikt wiarygodny go nie potwierdza.
 */
function isUnconfirmedAfterLiveSearch(input: JustifyInput): boolean {
  if (input.claim.type !== "fakt") return false;
  if (!input.searchedPl.some((s) => s.includes("na żywo"))) return false;
  return !input.assessments.some((a) => !a.excluded && a.relation !== "BEZ_ZWIAZKU" && a.quoteVerified);
}

/** Długość uzasadnienia, do której wstawiamy je do podsumowania w całości (z cytatem). */
const SUMMARY_FULL_REASON_MAX = 480;

/** Pierwsze zdanie — kropka w środku cytatu „…” nie kończy zdania. */
export function firstSentencePl(text: string): string {
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "„") inQuote = true;
    else if (ch === "”") inQuote = false;
    else if (!inQuote && (ch === "." || ch === "!" || ch === "?") && /\s/.test(text[i + 1] ?? "")) return text.slice(0, i + 1);
  }
  return text;
}

/** Liczebniki do zestawienia ocen („2 fałszywe, 5 potwierdzonych”). */
const TALLY_PL: Record<Verdict, [string, string, string]> = {
  FALSZYWE: ["fałszywe", "fałszywe", "fałszywych"],
  WPROWADZAJACE: ["wprowadzające w błąd", "wprowadzające w błąd", "wprowadzających w błąd"],
  POTWIERDZONE: ["potwierdzone", "potwierdzone", "potwierdzonych"],
  BRAK_DOWODOW: ["bez wystarczających dowodów", "bez wystarczających dowodów", "bez wystarczających dowodów"],
  NIE_PODLEGA: ["niepodlegające sprawdzeniu (opinia lub prognoza)", "niepodlegające sprawdzeniu (opinie lub prognozy)", "niepodlegających sprawdzeniu (opinie lub prognozy)"],
};
const TALLY_ORDER: Verdict[] = ["FALSZYWE", "WPROWADZAJACE", "POTWIERDZONE", "BRAK_DOWODOW", "NIE_PODLEGA"];

/** „Sprawdziliśmy 5 twierdzeń: 2 fałszywe, 1 potwierdzone, 2 bez wystarczających dowodów.” */
export function tallyPl(verdicts: Verdict[]): string {
  const n = verdicts.length;
  const items = TALLY_ORDER.map((v) => [v, verdicts.filter((x) => x === v).length] as const)
    .filter(([, k]) => k > 0)
    .map(([v, k]) => `${k} ${plural(k, ...TALLY_PL[v])}`);
  return `Sprawdziliśmy ${n} ${plural(n, "twierdzenie", "twierdzenia", "twierdzeń")}: ${items.join(", ")} — ocena każdego jest poniżej.`;
}

export interface SummaryOptions {
  /** Werdykty wszystkich twierdzeń (z głównym) — przy co najmniej 2 dodajemy zestawienie. */
  allVerdicts?: Verdict[];
  /** Długi tekst, z którego model wybrał tylko najważniejsze twierdzenia (limit wyczerpany). */
  selectedFromLong?: boolean;
}

export function buildSummaryPl(
  main: { verdict: Verdict; reasonPl: string } | undefined,
  otherClaims: number,
  opts: SummaryOptions = {},
): string {
  if (!main) return "Nie udało się wydać oceny.";
  const merit = main.verdict === "FALSZYWE" || main.verdict === "POTWIERDZONE";
  // Przy jasnym werdykcie od razu pokazujemy, co mówi źródło (z cytatem) — użytkownik nie musi przewijać.
  const head = merit && main.reasonPl.length <= SUMMARY_FULL_REASON_MAX ? main.reasonPl : firstSentencePl(main.reasonPl);
  const parts = [`Ocena głównego twierdzenia: ${VERDICT_LABEL_PL[main.verdict]}.`, head];
  if (opts.allVerdicts && opts.allVerdicts.length >= 2) parts.push(tallyPl(opts.allVerdicts));
  else if (otherClaims > 0) parts.push("W wiadomości są też inne twierdzenia — ich ocena jest poniżej.");
  if (opts.selectedFromLong) {
    parts.push("Tekst był długi, więc wybraliśmy z niego najważniejsze twierdzenia, które da się sprawdzić w źródłach — pozostałych nie oceniamy.");
  }
  return parts.join(" ");
}

// ───────────── Twierdzenia złożone (kilka podmiotów) ─────────────

const PART_REASON_FULL_MAX = 320;

function partName(text: string): string {
  return `„${text.trim().replace(/[.!?…]+$/, "")}”`;
}

function namesPl(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} i ${names[names.length - 1]}`;
}

/**
 * Uzasadnienie całości z uzasadnień części. Pierwsze zdanie samo mówi, co jest prawdą, a co nie
 * (trafia do podsumowania, gdy całość jest długa); dalej szczegóły każdej części z jej cytatem.
 */
export function buildCompoundReasonPl(verdict: Verdict, parts: { claim: Claim; verdict: Verdict; reasonPl: string }[]): string {
  const by = (v: Verdict) => parts.filter((p) => p.verdict === v).map((p) => partName(p.claim.text));
  const falseN = by("FALSZYWE");
  const trueN = by("POTWIERDZONE");
  const mislN = by("WPROWADZAJACE");
  const unclearN = by("BRAK_DOWODOW");
  let lead: string;
  if (verdict === "POTWIERDZONE") lead = `Twierdzenie dotyczy kilku podmiotów — sprawdziliśmy każdy osobno i źródła potwierdzają wszystkie części.`;
  else if (verdict === "FALSZYWE")
    lead =
      unclearN.length > 0
        ? `Twierdzenie dotyczy kilku podmiotów — sprawdziliśmy każdy osobno: ${namesPl(falseN)} to nieprawda (dla ${namesPl(unclearN)} brak wystarczających dowodów).`
        : `Twierdzenie dotyczy kilku podmiotów — sprawdziliśmy każdy osobno i źródła przeczą wszystkim częściom.`;
  else if (verdict === "WPROWADZAJACE")
    lead =
      falseN.length > 0
        ? `Twierdzenie jest prawdziwe tylko częściowo: ${namesPl(falseN)} to nieprawda${trueN.length > 0 ? `, a ${namesPl(trueN)} — prawda` : ""}.`
        : `Twierdzenie dotyczy kilku podmiotów, a ${namesPl(mislN)} wprowadza w błąd.`;
  else if (verdict === "BRAK_DOWODOW")
    lead = `Twierdzenie dotyczy kilku podmiotów, a nie dla każdego mamy wystarczające dowody: brakuje ich dla ${namesPl(unclearN.length > 0 ? unclearN : parts.map((p) => partName(p.claim.text)))}.`;
  else lead = `Twierdzenie dotyczy kilku podmiotów; żadnej części nie da się sprawdzić w źródłach (opinia lub prognoza).`;
  const details = parts.map((p) => {
    const r = p.reasonPl.length <= PART_REASON_FULL_MAX ? p.reasonPl : firstSentencePl(p.reasonPl);
    return `${partName(p.claim.text)} — ${VERDICT_LABEL_PL[p.verdict]}. ${r}`;
  });
  return [lead, ...details].join(" ");
}

// ───────────── Optional smoothing ─────────────

const VERDICT_STEMS: Record<Verdict, string[]> = {
  POTWIERDZONE: ["potwierdzon"],
  FALSZYWE: ["falszyw", "nieprawdziw"],
  WPROWADZAJACE: ["wprowadzajac", "wprowadza w blad"],
  BRAK_DOWODOW: ["brak wystarczajacych dowodow", "brak dowodow"],
  NIE_PODLEGA: ["nie podlega weryfikacji"],
};

export function validateSmoothed(candidate: string, ctx: { template: string; verdict: Verdict; quotes: string[] }): boolean {
  const c = candidate.trim();
  if (c.length === 0 || c.length > ctx.template.length * 2 + 200) return false;
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(pl|com|eu|org|net|gov|info|io)\b)/i.test(c)) return false;
  // Quotes from sources must survive verbatim.
  for (const q of ctx.template.match(/„[^”]*”/g) ?? []) if (!c.includes(q)) return false;
  const allowedDigits = `${ctx.template} ${ctx.quotes.join(" ")}`;
  for (const d of c.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    if (!allowedDigits.includes(d)) return false;
  }
  const fc = foldForMatch(c);
  const ft = foldForMatch(ctx.template);
  for (const [v, stems] of Object.entries(VERDICT_STEMS) as [Verdict, string[]][]) {
    if (v === ctx.verdict) continue;
    for (const s of stems) if (fc.includes(s) && !ft.includes(s)) return false;
  }
  return true;
}

export async function smoothJustification(
  llm: LlmProvider,
  template: string,
  verdict: Verdict,
  quotes: string[],
  signal?: AbortSignal,
): Promise<{ text: string; usage?: ModelUsage; smoothed: boolean }> {
  try {
    const res = await llm.complete({
      purpose: "smooth",
      system: SMOOTH_SYSTEM,
      user: fence("TEKST", template).text,
      schema: SmoothOut,
      schemaName: "smoothing",
      tier: "fast",
      signal,
    });
    const ok = validateSmoothed(res.data.text, { template, verdict, quotes });
    return { text: ok ? res.data.text.trim() : template, usage: res.usage, smoothed: ok };
  } catch {
    return { text: template, smoothed: false };
  }
}
