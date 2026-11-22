import { z } from "zod";
import type { Claim, CorpusRecord, EvidenceAssessment, LlmProvider } from "../shared/contracts";
import { answerEvidenceItem } from "./answer";
import { fence, UNTRUSTED_DATA_RULES } from "./llm/fence";
import { decideVerdict, detectInjection } from "./ports";
import { publicationAvailable } from "./publication-window";
import { foldForMatch } from "./text";
import { WARNING_PL } from "./messages";
import type { PublicationRun } from "./verify";

type Run = PublicationRun & {
  assessedRecords: Set<string>;
  verifierUsed: boolean;
  warn(kind: "single_key_verifier", text: string): void;
};
type Direction = "higher" | "lower" | "equal";
const directionWords = {
  higher: /\b(?:wyzsz\w*|wieksz\w*|wiecej)\b/u,
  lower: /\b(?:nizsz\w*|mniejsz\w*|mniej)\b/u,
  equal: /\b(?:(?:tak\w*|te|ta|ten) sam\w*|rown\w*|identyczn\w*)\b/u,
};

function directionOf(text: string): Direction | undefined {
  const s = foldForMatch(text);
  if (s.length > 300 || !/\b(?:swiadczen\w*|zasil\w*|staw\w*|kwot\w*|dodat\w*)\b/u.test(s) ||
      /\b(?:\d{4}|nie|ani|lub|albo|lacz\w*|suma|wszys\w*|warunk\w*|kryteri\w*|doch[oó]d\w*|dawn\w*|wczesni\w*|przysz\w*)\b/u.test(s)) return;
  const hits = (Object.keys(directionWords) as Direction[]).filter(k => directionWords[k].test(s));
  return hits.length === 1 ? hits[0] : undefined;
}

function programName(s: string) {
  return foldForMatch(s.replace(/(\d)\+/gu, "$1 plus")).trim();
}

// The source states one full, periodic amount and unit. A title, a programme number or an
// income threshold does not establish a rate. Other currencies and units require the same literal reading.
function monthlyRate(r: CorpusRecord) {
  const matches = [...r.text.matchAll(/\b(\d+(?:[ \u00a0]\d{3})*(?:[,.]\d{1,2})?)\s*(zł|PLN|EUR|euro) (?:co miesiąc|miesięcznie) na (dziecko|osobę)(?!\p{L})/giu)];
  if (matches.length !== 1) return;
  const m = matches[0]!;
  return { amount: Number(m[1]!.replace(/\s/gu, "").replace(",", ".")), currency: /^(?:zł|PLN)$/iu.test(m[2]!) ? "PLN" : "EUR", unit: m[3]!.toLowerCase() };
}

const Read = z.object({
  comparable: z.boolean(), leftMention: z.string(), rightMention: z.string(), leftGroup: z.string(), rightGroup: z.string(),
  leftAmount: z.number(), rightAmount: z.number(), currency: z.string(), reasonPl: z.string(),
});
const readingRules = "Sprawdź wyłącznie przedstawione cytaty i tytuły dokumentów. comparable=true wyłącznie dla porównania podstawowej pieniężnej stawki jednego świadczenia dla DWÓCH wskazanych grup uprawnionych, na dzień weryfikacji. " +
  "Oceń łącznie pola tej samej publikacji: adresaci są wskazani w osobnych wierszach instrukcji, a kwota standardowa w innym wierszu. Drugi niezależny dokument powinien potwierdzać stawkę, jednostkę i walutę tego samego programu w tym okresie; nie musi powtarzać obu grup. Wypowiedź o kwocie dla odbiorców nie jest zapewnieniem, że każdy spełnia warunki. comparable ocenia możliwość policzenia porównania, a nie to, czy twierdzenie użytkownika jest prawdziwe. Opisz krótko powód odczytu w reasonPl. " +
  "Odrzuć twierdzenia o identycznych warunkach, sumach wypłat, różnym okresie, świadczeniach specjalnych, innym kraju lub innym programie, a także dodatkowe zastrzeżenia nieobjęte źródłami. " +
  "leftMention/rightMention są dosłownymi frazami z TEZY określającymi obie grupy. leftGroup/rightGroup to identyfikatory G z ZAKRESU, leftAmount/rightAmount to stawki jednostkowe odczytane ze źródeł. " +
  "Zachowaj kolejność grup w tekście i zwróć kod ISO waluty. Nie oceniaj prawdziwości tezy; stosunek odczytanych wartości porówna kod." + UNTRUSTED_DATA_RULES;

function groupMatches(mention: string, claim: string, scope: CorpusRecord, other: CorpusRecord): boolean {
  if (mention.length < 4 || !foldForMatch(claim).includes(foldForMatch(mention))) return false;
  // Only the beneficiary named before the qualifying clause. Its place of residence is not its identity.
  const head = (r: CorpusRecord) => foldForMatch(r.text.split(/[,;:]/u)[0]!).split(" ")
    .filter(w => w.length >= 4 && !/^(?:obywatel|uprawn|rodzin|pobier|status)/u.test(w))
    .map(w => w.slice(0, 5));
  const unique = head(scope).filter(w => !head(other).includes(w));
  return foldForMatch(mention).split(" ").some(w => unique.includes(w.slice(0, 5)));
}

/** Resolve only a common, documented base rate. Missing scope, different rates or disagreement
 * between the two readers falls through to normal verification of the original message. */
export async function benefitComparisonReport(run: Run, input: string, main: LlmProvider, verifier: LlmProvider, now: Date, signal?: AbortSignal) {
  const direction = directionOf(input);
  if (!direction || !main.available || !verifier.available) return;
  const query = " " + programName(input) + " ";
  let records: CorpusRecord[];
  try {
    const ids = run.deps.db.prepare(`SELECT id FROM records WHERE level = 1 AND role = 'tresc'
      AND (topics_json LIKE '%"stawka-programu"%' OR topics_json LIKE '%"adresaci-programu"%')`).all() as { id: string }[];
    records = run.deps.store.getMany(ids.map(r => r.id)).filter(r => r.origin === "corpus" && r.type === "pierwotne" &&
      publicationAvailable(r, now) && !detectInjection(r.title + " " + r.text, "evidence", r.id).length);
  } catch { return; }
  const aliases = new Set(records.flatMap(r => r.topics.filter(t => t.startsWith("program:") && query.includes(" " + programName(t.slice("program:".length)) + " "))));
  if (aliases.size !== 1) return;
  const group = records.filter(r => r.topics.some(t => aliases.has(t)));
  const rates = group.filter(r => r.topics.includes("stawka-programu"));
  const scopes = group.filter(r => r.topics.includes("adresaci-programu"));
  const guide = rates.find(r => scopes.some(s => s.url === r.url));
  if (!guide?.period || !guide.period.match(/^\d{4}-\d{2}-\d{2}$/u)) return;
  const day = now.toISOString().slice(0, 10);
  const age = +now - Date.parse(guide.period);
  if (!Number.isFinite(age) || age < 0 || age > 366 * 86400000) return;
  const corroboration = rates.find(r => r.url !== guide.url && r.independenceGroup !== guide.independenceGroup && r.publishedAt && r.publishedAt <= day);
  const groups = scopes.filter(r => r.url === guide.url && r.period === guide.period);
  if (!corroboration || groups.length < 2 || groups.length > 20) return;
  const rate = monthlyRate(guide);
  if (!rate || rates.some(r => { const v = monthlyRate(r); return !v || v.amount !== rate.amount || v.unit !== rate.unit || v.currency !== rate.currency; })) return;
  const eligible = groups.map((r,i) => ({ ref: "G" + (i + 1), document: "P1", url: r.url, quote: r.text }));
  const sources = [guide, corroboration].map((r, i) => ({ document: "P" + (i + 1), title: r.title, publisher: r.publisher,
    url: r.url, publishedAt: r.publishedAt, editionUpdated: r.period, quote: r.text }));
  const prompt = [fence("TEZA", input).text, fence("DATA", day).text, fence("STAWKI", JSON.stringify(sources)).text,
    fence("ZAKRES", JSON.stringify(eligible)).text].join("\n");
  run.recordLookup("stawki_swiadczen", "completed", [...groups, guide, corroboration].map(r => r.id));
  run.stage("assessing");
  const reads = await Promise.allSettled([main, verifier].map((provider,i) => provider.complete({
    purpose: i ? "verify_evidence" : "assess", tier: i ? "fast" : "main", schema: Read,
    schemaName: "benefit_rate_comparison", system: readingRules, user: prompt, signal,
  })));
  for (const read of reads) if (read.status === "fulfilled") run.models.push(read.value.usage);
  if (reads[0]?.status !== "fulfilled" || reads[1]?.status !== "fulfilled") return;
  const [first, second] = [reads[0].value.data, reads[1].value.data];
  if (!first || !second || first.leftGroup !== second.leftGroup || first.rightGroup !== second.rightGroup || first.leftGroup === first.rightGroup) return;
  const left = groups[eligible.findIndex(r => r.ref === first.leftGroup)];
  const right = groups[eligible.findIndex(r => r.ref === first.rightGroup)];
  if (!left || !right || ![first,second].every(r => r.comparable && r.leftAmount === rate.amount && r.rightAmount === rate.amount &&
    r.currency === rate.currency && groupMatches(r.leftMention, input, left, right) && groupMatches(r.rightMention, input, right, left))) return;
  const mode = /^czy\s/iu.test(input) ? "question_yesno" : "claim";
  const text = input.replace(/^czy\s+/iu, "").replace(/\?$/u, ".");
  const claim: Claim = { id: "c1", text, type: "fakt", isMain: true, inputOverlap: 1, assertedAspect: "liczba", temporal: { kind: "stan" } };
  const relation = direction === "equal" ? "WSPIERA" : "OBALA";
  const evidence = [guide,corroboration];
  const assessments: EvidenceAssessment[] = evidence.map(r => ({ claimId: claim.id, recordId: r.id, relation, aspect: "sedno", quote: r.text,
    quoteVerified: true, quoteMatchScore: 1, verifier: "zgoda", decisive: true }));
  const result = decideVerdict({ claim, records: new Map(evidence.map(r => [r.id,r])), assessments, now, singleKeyVerifier: run.deps.singleKey });
  if (result.verdict !== (direction === "equal" ? "POTWIERDZONE" : "FALSZYWE")) return;
  run.stage("checking_quotes");
  run.inputMode = mode;
  run.claims = [claim];
  run.verifierUsed = true;
  if (run.deps.singleKey) run.warn("single_key_verifier", WARNING_PL.singleKey);
  [...groups, ...evidence].forEach(r => run.assessedRecords.add(r.id));
  const reasonPl = `Dla uprawnionych z obu grup podstawowa stawka wynosi ${rate.amount.toLocaleString("pl-PL")} ${rate.currency === "PLN" ? "zł" : "EUR"} miesięcznie na ${rate.unit}. Instrukcja programu wskazuje obie grupy i warunki uprawnienia. Drugi dokument potwierdza wysokość świadczenia.`;
  return run.report({ status: "OK", verdictMode: "rules", mainVerdict: result.verdict, summaryPl: reasonPl, verdicts: [{
    claimId: claim.id, verdict: result.verdict, ruleApplied: result.ruleApplied, strength: result.strength, reasonPl,
    evidence: [...evidence.map(r => ({ ...answerEvidenceItem(r, r.text, relation), usedForVerdict: true })),
      ...[left,right].map(r => ({ ...answerEvidenceItem(r, r.text, "CZESCIOWO"), group: "kontekst" as const, aspect: "zakres" as const, usedForVerdict: true }))],
  }], transparencyPl: "Dwa odczyty sprawdziły zakres, okres i jednostkę świadczenia. Kod porównał kwoty w dosłownych fragmentach obu publikacji." });
}
