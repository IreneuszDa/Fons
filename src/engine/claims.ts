/**
 * Step 3 — claim extraction + input mode (fast tier, structured output).
 *
 *  - inputMode: claim | question_yesno | question_open (model proposal, sanity-checked in code).
 *  - claim / question_yesno: atomic claims (a yes/no question becomes ONE declarative claim and goes
 *    through the normal verdict pipeline) — <= 3 for a short message, <= 6 for a long text (article,
 *    transcript), ranked by importance and check-worthiness. Claims whose n-gram overlap with the input is
 *    below the threshold are dropped (prevents claim substitution by injected content); when the model
 *    rewrote or translated a claim, the verbatim `sourceText` (stricter threshold) is checked instead and
 *    becomes the claim text — never a translation the code cannot compare with the input (red team RT-04).
 *  - parts: a claim that gives the same fact for 2–4 subjects („Polska i Litwa wstąpiły do NATO w 1999”)
 *    is checked part by part (one sub-claim per subject, each within the parent's words); the verdicts are
 *    aggregated by code (verdict/compound.ts). At most MAX_CHECK_UNITS units per request.
 *  - question_open: no claims; search queries for the open-answer step (answer.ts).
 *
 * Each claim carries search variants used as RetrievalQuery.extraQueries — English translation first
 * (the vector branch embeds only the first few texts), then Polish keyword queries, base forms (lemmas)
 * and entity names — plus `mustHave` terms (entities, years, numbers) for the lexical rerank.
 */
import type { Claim, LlmProvider, ModelUsage } from "../shared/contracts";
import { fence } from "./llm/fence";
import { CLAIMS_SYSTEM, ClaimsOut, PAGE_LABEL, type InputMode } from "./prompts";
import { foldForMatch, isoDateOrUndefined, ngramContainment, splitSentences, truncateWords } from "./text";

export const CLAIM_OVERLAP_THRESHOLD = 0.55;
/** Stricter: the verbatim fragment must really be in the input (it replaces a rewritten claim). */
export const SOURCE_OVERLAP_THRESHOLD = 0.85;
/** A part must stay within the parent claim's words (only the subject changes). */
export const PART_OVERLAP_THRESHOLD = 0.7;
export const MAX_CLAIMS = 3;
/** Long text (article, transcript): more claims, ranked by the model by importance. */
export const MAX_CLAIMS_LONG = 6;
export const LONG_INPUT_CHARS = 1500;
export const MAX_PARTS = 4;
/** Claims + parts checked per request (each one = retrieval + one assessment call). */
export const MAX_CHECK_UNITS = 8;
export const MAX_EXTRA_QUERIES = 7;

export interface ExtractedClaim {
  claim: Claim;
  extraQueries: string[];
  /** Entity names, years and numbers that a relevant record should mention (rerank boost). */
  mustHave: string[];
  /** Sub-claims, one per subject (empty = the claim is checked as a whole). */
  parts: ExtractedClaim[];
}

export function isLongInput(input: string): boolean {
  return input.trim().length >= LONG_INPUT_CHARS;
}

export function claimLimitFor(input: string): number {
  return isLongInput(input) ? MAX_CLAIMS_LONG : MAX_CLAIMS;
}

export interface OpenQuestion {
  /** The question as typed (after normalisation), shown back to the user. */
  questionPl: string;
  /** Retrieval queries (Polish keyword queries, English translation, entities). */
  queries: string[];
  mustHave: string[];
  /** The question asks about the current state (archival warning for old evidence). */
  aboutPresent: boolean;
}

export interface ClaimsResult {
  inputMode: InputMode;
  claims: ExtractedClaim[];
  /** Only for inputMode "question_open". */
  question?: OpenQuestion;
  /** Claims proposed by the model but dropped for low overlap with the input. */
  rejected: { text: string; overlap: number }[];
  /** How many claims the model was allowed to return (3 short / 6 long). */
  claimLimit: number;
  usage: ModelUsage;
}

export function buildClaimsPrompt(input: string, limit = claimLimitFor(input)): string {
  const long = isLongInput(input)
    ? ` Tekst jest długi: wybierz najwyżej ${limit} najważniejszych sprawdzalnych twierdzeń, od najważniejszego.`
    : "";
  return `Rozpoznaj rodzaj tekstu i wyodrębnij twierdzenia z tekstu poniżej. LIMIT: najwyżej ${limit} twierdzeń.${long}\n${fence("WEJSCIE", input).text}`;
}

export async function extractClaims(llm: LlmProvider, input: string, signal?: AbortSignal, subtitleFocus?: string): Promise<ClaimsResult> {
  const subtitleInstruction = subtitleFocus === undefined ? "" :
    " Materiał zawiera napisy lub opis filmu. Podaj w text dokładny, samodzielny, ciągły cytat w oryginalnym języku. Zachowaj sprostowania i kontekst. TEMAT służy wyłącznie do wyboru cytatu.";
  const res = await llm.complete({
    purpose: "claims",
    system: CLAIMS_SYSTEM + subtitleInstruction,
    user: buildClaimsPrompt(input) + (subtitleFocus ? "\n" + fence("TEMAT", subtitleFocus.slice(0, 1000)).text : ""),
    schema: ClaimsOut,
    schemaName: "claims",
    tier: "fast",
    signal,
  });
  return { ...postProcessClaims(res.data, input), usage: res.usage };
}

const INTERROGATIVE =
  /^(kto|kogo|komu|kim|co|czego|czym|ile|ilu|kiedy|gdzie|skąd|dokąd|jak|jaki|jaka|jakie|jakich|jakim|jakiego|jakiej|który|która|które|którzy|którego|której|których|dlaczego|czemu|po co|w jakim|w którym|w której|od kiedy|do kiedy|na czym|o czym|z kim|who|what|when|where|which|how|why)(?!\p{L})/iu;
const YES_NO = /^(czy|is|are|does|do|did|was|were|has|have|can)(?!\p{L})/iu;

function lastSentence(input: string): string {
  const t = input.trim();
  const parts = t.split(/(?<=[.!?…])\s+/);
  return (parts[parts.length - 1] ?? t).trim();
}

/** Code-side sanity check of the model's input mode (never trusts a mode the text does not support). */
export function resolveInputMode(proposed: InputMode, input: string, claimCount: number): InputMode {
  // A link (page content) is always checked as claims, even when the user's note is a question.
  if (input.includes(PAGE_LABEL)) return "claim";
  const t = input.trim();
  const last = lastSentence(t);
  const isQuestion = /\?\s*$/.test(t) || INTERROGATIVE.test(last) || YES_NO.test(last);
  const yesNoShape = YES_NO.test(last) || /^(czy|is|are)(?!\p{L})/iu.test(t);
  if (proposed === "question_open") {
    if (!isQuestion) return "claim";
    if (yesNoShape && claimCount > 0) return "question_yesno";
    return "question_open";
  }
  if (proposed === "question_yesno") return isQuestion || claimCount > 0 ? "question_yesno" : "claim";
  // proposed claim
  if (yesNoShape && /\?\s*$/.test(t) && claimCount > 0 && claimCount <= 1) return "question_yesno";
  return "claim";
}

const YEAR_OR_NUMBER = /\b\d{1,4}(?:[.,]\d+)?\b/g;

/** Entities + years/numbers that appear in the claim (deduplicated, folded duplicates removed). */
export function mustHaveTerms(text: string, entities: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const v = t.trim();
    const k = foldForMatch(v);
    if (!k || k.length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push(truncateWords(v, 80));
  };
  // ISO dates from the model ("1999-03-12") are reduced to the year — records rarely spell them that way.
  for (const e of entities) push(/^\d{4}-\d{2}(-\d{2})?$/.test(e.trim()) ? e.trim().slice(0, 4) : e);
  for (const m of text.match(YEAR_OR_NUMBER) ?? []) push(m);
  return out.slice(0, 8);
}

function cleanQueries(qs: string[], max = MAX_EXTRA_QUERIES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of qs) {
    const v = truncateWords(q.trim(), 200);
    const k = foldForMatch(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Does the (folded) text mention the entity (any alternative of „polska | angielska”, word prefixes)? */
function mentions(text: string, entity: string): boolean {
  const words = new Set(foldForMatch(text).split(" "));
  return entity.split("|").some((alt) => {
    const ws = foldForMatch(alt).split(" ").filter((w) => w.length >= 2);
    if (ws.length === 0) return false;
    return ws.every((w) => {
      const stem = /^\d/.test(w) ? w : w.slice(0, Math.max(3, Math.min(w.length - 1, 5)));
      for (const x of words) if (/^\d/.test(w) ? x === w : x.startsWith(stem)) return true;
      return false;
    });
  });
}

/** Numbers of a part must be the parent's numbers (a part never brings a new date or figure). */
function numbersWithin(part: string, parent: string): boolean {
  const pn = new Set(parent.match(YEAR_OR_NUMBER) ?? []);
  return (part.match(YEAR_OR_NUMBER) ?? []).every((n) => pn.has(n));
}

/** Validated parts of a claim (each within the parent's words, distinct, 2–MAX_PARTS of them), or []. */
export function validParts(parentText: string, parts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>([foldForMatch(parentText)]);
  for (const raw of parts) {
    const t = truncateWords(raw.trim(), 400);
    const k = foldForMatch(t);
    if (!k || seen.has(k)) continue;
    if (ngramContainment(t, parentText) < PART_OVERLAP_THRESHOLD || !numbersWithin(t, parentText)) return [];
    seen.add(k);
    out.push(t);
  }
  return out.length >= 2 ? out.slice(0, MAX_PARTS) : [];
}

const NAMED_ATTRIBUTION = /^(?:[Cc]zy\s+)?((?:[\p{Lu}][\p{L}’'-]+\s+){1,3}[\p{Lu}][\p{L}’'-]+)\s+(?:powiedzia[łl]a?|stwierdzi[łl]a?|napisa[łl]a?|oświadczy[łl]a?|oznajmi[łl]a?)(?:\s*:\s*|(?:\s*,\s*|\s+)(?:[żz]e|i[żz])\s+)/u;

/** An explicit attribution is part of the claim even if the model extracts only the quoted statement. */
function restoreAttribution(text: string, sourceText: string, input: string): { text: string; speaker: string } | undefined {
  const source = sourceText.trim();
  const fragment = source && input.includes(source) && NAMED_ATTRIBUTION.test(source) ? source : input.trim();
  if (fragment.length > 400 || splitSentences(fragment).length !== 1) return;
  const match = NAMED_ATTRIBUTION.exec(fragment);
  if (!match || mentions(text, match[1]!) || ngramContainment(text, fragment.slice(match[0].length)) < SOURCE_OVERLAP_THRESHOLD) return;
  return { text: fragment.replace(/^[Cc]zy\s+/u, "").replace(/\?\s*$/u, "."), speaker: match[1]! };
}

export function postProcessClaims(out: ClaimsOut, input: string, limit = claimLimitFor(input)): Omit<ClaimsResult, "usage"> {
  const kept: { raw: ClaimsOut["claims"][number]; text: string; overlap: number }[] = [];
  const rejected: { text: string; overlap: number }[] = [];
  const seen = new Set<string>();
  for (const raw of out.claims) {
    let text = raw.text.trim();
    if (!text) continue;
    let overlap = Math.round(ngramContainment(text, input) * 1000) / 1000;
    if (overlap < CLAIM_OVERLAP_THRESHOLD) {
      // Rewritten or translated claim: fall back to the verbatim fragment it came from (in the input's language).
      const src = (raw.sourceText ?? "").trim();
      const srcOverlap = src ? Math.round(ngramContainment(src, input) * 1000) / 1000 : 0;
      if (srcOverlap >= SOURCE_OVERLAP_THRESHOLD) {
        text = truncateWords(src, 400);
        overlap = srcOverlap;
      } else {
        rejected.push({ text: truncateWords(text, 200), overlap });
        continue;
      }
    }
    const attribution = restoreAttribution(text, raw.sourceText ?? "", input);
    if (attribution) {
      text = attribution.text;
      overlap = Math.round(ngramContainment(text, input) * 1000) / 1000;
    }
    const key = foldForMatch(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const preserved = attribution
      ? { ...raw, type: "fakt" as const, assertedAspect: "autorstwo" as const, entities: [attribution.speaker, ...raw.entities], parts: [] }
      : raw;
    kept.push({ raw: preserved, text, overlap });
    if (kept.length >= limit) break;
  }

  const inputMode = resolveInputMode(out.inputMode ?? "claim", input, kept.length);

  if (inputMode === "question_open") {
    const q = out.question ?? { searchPl: [], searchEn: "", entities: [], aboutPresent: false };
    const questionPl = truncateWords(input.trim(), 400);
    return {
      inputMode,
      claims: [],
      question: {
        questionPl,
        queries: cleanQueries([q.searchEn, ...q.searchPl.slice(0, 3), q.entities.join(" ")]),
        mustHave: mustHaveTerms(questionPl, q.entities),
        aboutPresent: q.aboutPresent,
      },
      rejected,
      claimLimit: limit,
    };
  }

  let mainIdx = kept.findIndex((k) => k.raw.isMain);
  if (mainIdx < 0) mainIdx = 0;
  const claims = kept.map(({ raw, text, overlap }, i): ExtractedClaim => {
    const date = isoDateOrUndefined(raw.date);
    const kind = raw.temporalKind;
    const lemmas = (raw.lemmasPl ?? []).map((l) => l.trim()).filter(Boolean);
    const entities = (raw.entities ?? []).map((l) => l.trim()).filter(Boolean);
    const extraQueries = cleanQueries([
      raw.keywordEn,
      ...raw.keywordsPl.slice(0, 3),
      lemmas.join(" "),
      entities.join(" "),
    ]);
    // Rule 3 compares the EVENT date asserted by the claim with the evidence — a date the claim's own words do not
    // state (the page's dateline or publication date, copied by the model) is dropped (demo DEMO09).
    const assertedDate = date && claimStatesDate(date, [text, raw.sourceText ?? ""]) ? date : undefined;
    const focus = raw.assertedAspect ?? undefined;
    const claim: Claim = {
      id: `c${i + 1}`,
      text: truncateWords(text, 400),
      type: raw.type,
      isMain: i === mainIdx,
      temporal: assertedDate ? { kind, date: assertedDate } : { kind },
      inputOverlap: overlap,
      ...(focus && raw.type === "fakt" ? { assertedAspect: focus } : {}),
    };
    const parts =
      raw.type === "fakt"
        ? validParts(claim.text, raw.parts ?? []).map(
            (p, k): ExtractedClaim => ({
              claim: { ...claim, id: `${claim.id}p${k + 1}`, text: p, isMain: false, inputOverlap: Math.round(ngramContainment(p, input) * 1000) / 1000 },
              extraQueries: cleanQueries([p, ...extraQueries]),
              mustHave: mustHaveTerms(p, entities.filter((en) => mentions(p, en))),
              parts: [],
            }),
          )
        : [];
    return { claim, extraQueries, mustHave: mustHaveTerms(text, entities), parts };
  });
  return { inputMode, claims: withinUnitBudget(claims), rejected, claimLimit: limit };
}

const MONTH_WORD =
  /(?<!\p{L})(?:stycz(?:eń|en|nia|niu)|lut(?:y|ego|ym)|mar(?:zec|ca|cu)|kwie(?:cień|cien|tnia|tniu)|maj(?:a|u)?|czerw(?:iec|ca|cu)|lip(?:iec|ca|cu)|sierp(?:ień|ien|nia|niu)|wrze(?:sień|sien|śnia|snia|śniu|sniu)|październik(?:a|u)?|pazdziernik(?:a|u)?|listopad(?:a|zie)?|grud(?:zień|zien|nia|niu)|january|february|march|april|june|july|august|september|october|november|december)(?!\p{L})/iu;

/**
 * Does the claim itself state the event date: its year as a number, or a month / day expression (the model then
 * only inferred the year)? Relative dates („wczoraj”) are already resolved to explicit ones in the input.
 */
export function claimStatesDate(date: string, texts: string[]): boolean {
  const year = /^(\d{4})/.exec(date)?.[1];
  const joined = texts.join("\n");
  if (year && new RegExp(`(?<!\\d)${year}(?!\\d)`).test(joined)) return true;
  return MONTH_WORD.test(joined) || /(?<!\d)\d{1,2}[./]\d{1,2}(?!\d)/.test(joined);
}

/** Keeps parts only while claims + parts fit MAX_CHECK_UNITS (the main claim first, then in order). */
export function withinUnitBudget(claims: ExtractedClaim[]): ExtractedClaim[] {
  let budget = MAX_CHECK_UNITS - claims.length;
  const order = [...claims].sort((a, b) => Number(b.claim.isMain) - Number(a.claim.isMain));
  const allowed = new Set<string>();
  for (const c of order) {
    const extra = c.parts.length - 1;
    if (c.parts.length > 0 && extra <= budget) {
      budget -= extra;
      allowed.add(c.claim.id);
    }
  }
  return claims.map((c) => (allowed.has(c.claim.id) ? c : { ...c, parts: [] }));
}

/** What gets checked: each claim, or its parts instead of it (main claim's units first). */
export function checkUnits(claims: ExtractedClaim[]): ExtractedClaim[] {
  const order = [...claims].sort((a, b) => Number(b.claim.isMain) - Number(a.claim.isMain));
  return order.flatMap((c) => (c.parts.length > 0 ? c.parts : [c]));
}

// ───────────── Zapytanie o funkcję bez nazwiska („kto naprawdę jest prezydentem?”) ─────────────

/** Słowa nazw instytucji i państw pisane wielką literą — to nie są osoby. Porównanie po złożonym prefiksie. */
const INSTITUTION_PREFIXES = [
  "rad", "minist", "prezes", "prezyd", "premier", "marszal", "sejm", "senat", "uni", "europ", "rzeczpospolit", "polsk", "narodow",
  "komisj", "parlament", "trybunal", "sad", "bank", "nato", "organizacj", "zgromadz", "stan", "zjednoczon", "federacj", "rosyj",
  "republik", "krolest", "kancelar", "urzad", "agencj", "wojsk", "sil", "zbrojn", "panstw", "fundusz", "narod", "rzad", "biur",
  "instytut", "glown", "najwyzsz", "konstytucyj", "obrony", "spraw", "zagraniczn", "wewnetrzn", "ukrain", "rosj", "niemc", "litw",
  "lotw", "eston", "finland", "szwecj", "bialoru", "chin", "ameryk", "afryk", "azj", "east", "west", "north", "south", "united",
];
const NAME_WORD = /^\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?$/u;

function isInstitutionWord(w: string): boolean {
  const f = foldForMatch(w);
  return INSTITUTION_PREFIXES.some((p) => f.startsWith(p));
}

const PUBLIC_OFFICE = /\b(?:prezydent\w*|premier\w*|ministr\w*|minister\w*|marszalk\w*|posel|posl\w*|senator\w*|ambasador\w*|wojewod\w*|komisarz\w*|przewodniczac\w*|prezes\w* rady ministrow|sekretarz\w* generaln\w*|president|ambassador|commissioner|secretary general)\b/;
const HOLDS_OFFICE = /\b(?:jest|byl|byla|zostal|zostala|zostanie|to|mianowan\w*|powolan\w*|pelni\w*|objal|objela|obejm\w*|piastuje|is|was|became|serves as|appointed)\b/;

/**
 * Twierdzenie o osobie („Prezydentem Polski jest Donald Tusk”) daje w bazie dziesiątki rekordów z jej nazwiskiem,
 * a strona, która mówi, kto NAPRAWDĘ pełni tę funkcję, nie trafia nawet do puli. Zwraca zapytanie bez nazwisk
 * osób (ciągi ≥ 2 słów z wielkiej litery, które nie są nazwą instytucji ani państwa) — silnik dokłada 1–2 najlepsze
 * rekordy pierwotne z tego zapytania do fragmentów (verify.ts). null, gdy nie ma nazwiska albo po usunięciu
 * zostaje mniej niż 2 słowa treści.
 */
export function roleQueryFor(text: string): { query: string; names: string[] } | null {
  if (NAMED_ATTRIBUTION.test(text)) return null;
  const tokens = text.split(/(\s+)/);
  const names: string[] = [];
  const keep: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const word = (t: string | undefined) => (t ?? "").replace(/[.,;:!?…„”"«»()]+/g, "");
    let j = i;
    const run: string[] = [];
    while (j < tokens.length && NAME_WORD.test(word(tokens[j])) && !isInstitutionWord(word(tokens[j]))) {
      run.push(word(tokens[j]));
      j += 2; // słowo + odstęp
    }
    if (run.length >= 2) {
      names.push(run.join(" "));
      i = j;
      continue;
    }
    keep.push(tokens[i]!);
    i++;
  }
  if (names.length === 0) return null;
  const query = keep.join("").replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?…])/g, "$1").trim();
  const folded = foldForMatch(query);
  if (!PUBLIC_OFFICE.test(folded) || !HOLDS_OFFICE.test(folded)) return null;
  const content = folded.split(" ").filter((w) => w.length >= 3 && !["jest", "byl", "byla", "sa", "nie", "jako", "the", "was"].includes(w));
  return content.length >= 2 ? { query, names } : null;
}

