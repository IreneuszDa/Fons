/** Markdown rendering of an evaluation summary (pure). Polish, because it goes into docs and to the jury. */
import { INPUT_MODES, NO_RESULT, THRESHOLDS, VERDICTS, type EvalSummary, type InputMode, type Rate } from "./metrics";
import { provenanceLabel } from "./provenance";

const MODE_LABEL: Record<InputMode, string> = {
  claim: "twierdzenie",
  question_yesno: "pytanie tak/nie",
  question_open: "pytanie otwarte",
};
const ANSWER_REASON: Record<string, string> = {
  status: "status inny niż OK",
  no_answer: "brak odpowiedzi",
  missing_fragment: "brak oczekiwanego fragmentu",
  quote_unverified: "cytat niezgodny z rekordem",
};

export interface RunMeta {
  startedAt: string;
  finishedAt: string;
  suite: string;
  split: string;
  runs: number;
  limit?: number;
  judge: boolean;
  provider: string;
  verifier: string;
  singleKey: boolean;
  verdictMode: string;
  corpusSnapshot: string;
  corpusRecords: number;
  pipelineVersion: string;
  /** Repo-relative path of the eval database (older result files may hold an absolute path). */
  dbPath: string;
  /** Commit that produced the run ("no-git" before the first commit); absent in results written before it was recorded. */
  gitSha?: string;
  /** Uncommitted changes in the working tree at run time (null = unknown). */
  gitDirty?: boolean | null;
  /** Run with liveSearch=true (`--live`); absent/false = offline eval. */
  live?: boolean;
  /** Fingerprint of the case files used (hash + ids per file); absent in older results. */
  caseSet?: CaseSetFingerprint;
}

import type { CaseSetFingerprint } from "./casehash";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "—");
const usd = (x: number) => `${x.toFixed(4)} USD`;
const rateCell = (r: Rate) => (r.n === 0 ? "— (0 przypadków)" : `${pct(r.rate)} (${r.ok}/${r.n})`);
/** Markdown table cell: no pipes or newlines. */
const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\s+/g, " ");
const mark = (ok: boolean, n = 1) => (n === 0 ? "—" : ok ? "spełniony" : "NIESPEŁNIONY");

export function renderMarkdown(s: EvalSummary, meta: RunMeta): string {
  const L: string[] = [];
  L.push(`# Wyniki ewaluacji Fons`, "");
  L.push(`- Uruchomienie: ${meta.startedAt} → ${meta.finishedAt}`);
  L.push(`- Zestaw: **${meta.suite}**, podział: **${meta.split}**, przebiegi na przypadek: ${meta.runs}${meta.limit !== undefined ? `, limit: ${meta.limit}` : ""}; wyszukiwanie na żywo: ${meta.live ? "**tak (--live)**" : "nie (offline)"}`);
  L.push(`- Model główny: ${meta.provider}; weryfikator: ${meta.verifier}${meta.singleKey ? " (tryb jednego klucza)" : ""}; tryb werdyktu: ${meta.verdictMode}`);
  L.push(`- Migawka korpusu: ${meta.corpusSnapshot} (${meta.corpusRecords} rekordów); wersja potoku: ${meta.pipelineVersion}`);
  L.push(`- Commit: ${provenanceLabel(meta)}`);
  L.push(`- Przypadki policzone: ${s.cases}`, "");

  L.push(`## Podsumowanie względem progów`, "");
  L.push(`| Miara | Wynik | Próg | Status |`, `|---|---|---|---|`);
  L.push(`| Macro-F1 (klasy obecne w zestawie) | ${r3(s.f1.macroF1)} | ≥ ${THRESHOLDS.macroF1} | ${mark(s.f1.macroF1 >= THRESHOLDS.macroF1, s.f1.total)} |`);
  L.push(`| Pokrycie cytatami | ${rateCell(s.citationCoverage)} | ≥ ${pct(THRESHOLDS.citationCoverage)} | ${mark(s.citationCoverage.rate >= THRESHOLDS.citationCoverage, s.citationCoverage.n)} |`);
  L.push(`| Poprawność cytatów — proxy (cytat jest podciągiem rekordu) | ${rateCell(s.citationCorrectness)} | ≥ ${pct(THRESHOLDS.citationCorrectness)} | ${mark(s.citationCorrectness.rate >= THRESHOLDS.citationCorrectness, s.citationCorrectness.n)} |`);
  if (s.judge) L.push(`| Poprawność cytatów — **ocena LLM (sędzia), nie pomiar deterministyczny** | ${rateCell(s.judge)} (częściowo: ${s.judge.partial}, błędy: ${s.judge.errors}) | ≥ ${pct(THRESHOLDS.citationCorrectness)} | ${mark(s.judge.rate >= THRESHOLDS.citationCorrectness, s.judge.n)} |`);
  L.push(`| Poprawne wstrzymanie (scenariusz D) | ${rateCell(s.abstention.scenarioD)} | ≥ ${pct(THRESHOLDS.abstention)} | ${mark(s.abstention.scenarioD.rate >= THRESHOLDS.abstention, s.abstention.scenarioD.n)} |`);
  L.push(`| Odporność na wstrzyknięcia (najgorszy z N) | ${rateCell(s.injection.resistance)} | ≥ ${pct(THRESHOLDS.injectionResistance)} | ${mark(s.injection.resistance.rate >= THRESHOLDS.injectionResistance, s.injection.resistance.n)} |`);
  L.push(`| Mediana czasu (tekst/URL) | ${sec(s.latency.p50Ms)} (p95 ${sec(s.latency.p95Ms)}, n=${s.latency.n}) | ≤ 30 s | ${mark(s.latency.p50Ms <= THRESHOLDS.latencyP50Ms, s.latency.n)} |`);
  L.push(`| Działanie end-to-end (raport zamiast wyjątku) | ${rateCell(s.endToEnd)} | 100% | ${mark(s.endToEnd.rate >= THRESHOLDS.endToEnd, s.endToEnd.n)} |`);
  L.push(`| Usterki J (status ≠ OK, brak werdyktu) | ${rateCell(s.faults)} | 100% | ${mark(s.faults.rate >= 1, s.faults.n)} |`);
  L.push(`| Trafność odpowiedzi na pytania otwarte (osobno od macro-F1) | ${rateCell(s.answers)} (przebiegi: ${rateCell(s.answers.runs)}) | raportowana | — |`);
  L.push(`| Koszt 100 testów | ${usd(s.cost.per100Usd)} (łącznie ${usd(s.cost.totalUsd)} za ${s.cost.runs} przebiegów) | raportowany | — |`, "");

  L.push(`## Macierz pomyłek (wiersze: oczekiwane, kolumny: otrzymane)`, "");
  const cols = [...VERDICTS, NO_RESULT];
  L.push(`| oczekiwane \\ otrzymane | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const e of VERDICTS) L.push(`| ${e} | ${cols.map((c) => s.confusion[e][c]).join(" | ")} |`);
  L.push("", `| Klasa | Liczność | Precyzja | Czułość | F1 |`, `|---|---|---|---|---|`);
  for (const c of s.f1.perClass) L.push(`| ${c.label} | ${c.support} | ${r3(c.precision)} | ${r3(c.recall)} | ${r3(c.f1)} |`);
  L.push("", `Trafność ogólna: ${pct(s.f1.accuracy)} (${s.f1.total} par). Macro-F1 liczone po klasach: ${s.f1.supportedClasses.join(", ") || "—"}.`, "");

  L.push(`## Trafność wg scenariusza (najgorszy z N)`, "");
  L.push(`| Scenariusz | Trafność |`, `|---|---|`);
  for (const [k, v] of Object.entries(s.scenarios)) L.push(`| ${k} | ${rateCell(v)} |`);
  if (Object.keys(s.tags).length) {
    L.push("", `| Etykieta | Trafność |`, `|---|---|`);
    for (const [k, v] of Object.entries(s.tags)) L.push(`| ${k} | ${rateCell(v)} |`);
  }
  L.push("");

  L.push(`## Trafność wg trybu wejścia`, "");
  L.push(`Pytania tak/nie liczą się do macro-F1 według werdyktu; pytania otwarte — tylko do trafności odpowiedzi (odpowiedź jest ∧ zawiera każdy oczekiwany fragment ∧ cytat zgadza się z rekordem).`, "");
  L.push(`| Tryb (oczekiwany) | Trafność przypadków | Tryb rozpoznany poprawnie (przebiegi) |`, `|---|---|---|`);
  for (const m of INPUT_MODES) L.push(`| ${MODE_LABEL[m]} | ${rateCell(s.inputModes[m].accuracy)} | ${rateCell(s.inputModes[m].modeDetected)} |`);
  if (s.answers.failures.length) {
    L.push("", `| Pytanie otwarte | Przebieg | Powód porażki |`, `|---|---|---|`);
    for (const f of s.answers.failures) L.push(`| ${f.caseId} | ${f.run} | ${ANSWER_REASON[f.reason] ?? f.reason}${f.missing ? `: ${f.missing.join(", ")}` : ""} |`);
  }
  L.push("");

  if (s.demo.length) {
    L.push(`## Demo (przypadki pokazowe, w kolejności scenariusza)`, "");
    L.push(`| # | Przypadek | Wejście | Tryb | Oczekiwane | Otrzymane | Wynik | Czas | Koszt |`, `|---|---|---|---|---|---|---|---|---|`);
    s.demo.forEach((d, i) =>
      L.push(`| ${i + 1} | ${d.caseId} | ${cell(d.input)} | ${MODE_LABEL[d.expectedMode]} | ${cell(d.expected)} | ${cell(d.got)} | ${d.ok ? "OK" : "BŁĄD"} | ${sec(d.latencyMs)} | ${usd(d.costUsd)} |`),
    );
    L.push("", `Demo: ${s.demo.filter((d) => d.ok).length}/${s.demo.length} poprawnie.`, "");
  }

  L.push(`## Wstrzymanie`, "");
  L.push(`- Scenariusz D: ${rateCell(s.abstention.scenarioD)}`);
  L.push(`- Wszystkie przypadki z oczekiwanym BRAK_DOWODOW (D, C, H): ${rateCell(s.abstention.allExpectedAbstain)}`);
  L.push(`- Nadmierne wstrzymanie (oczekiwany werdykt rozstrzygający, otrzymano BRAK_DOWODOW): ${rateCell(s.abstention.overAbstention)}`, "");

  L.push(`## Bezpieczeństwo`, "");
  L.push(`- Odporność: ${rateCell(s.injection.resistance)}; wykrywalność (zdarzenie bezpieczeństwa w każdym przebiegu): ${rateCell(s.injection.detection)}`);
  for (const [g, v] of Object.entries(s.injection.byGoal)) L.push(`  - cel „${g}”: ${rateCell(v)}`);
  if (s.injection.skipped.length) L.push(`- Pominięte (brak wyniku bliźniaka): ${s.injection.skipped.join(", ")}`);
  if (s.falsePositives) {
    L.push(`- Fałszywe alarmy detektora — korpus: ${rateCell(s.falsePositives.corpus)}; teksty łagodne (eval/fixtures/benign): ${rateCell(s.falsePositives.benign)}`);
    for (const f of s.falsePositives.benign.flagged) L.push(`  - łagodny oflagowany: ${f.id} (${f.patterns.join(", ")})`);
    for (const f of s.falsePositives.corpus.flagged.slice(0, 20)) L.push(`  - rekord korpusu oflagowany: ${f.id} (${f.patterns.join(", ")})`);
  }
  if (s.injection.failures.length) {
    L.push("", `| Przypadek | Przebieg | Powód porażki |`, `|---|---|---|`);
    for (const f of s.injection.failures) L.push(`| ${f.caseId} | ${f.run} | ${f.reasons.join("; ")} |`);
  }
  L.push("");

  L.push(`## Sprawdzenia pomocnicze (nie wpływają na F1)`, "");
  L.push(`- C — blok „źródła sprzeczne” przy twierdzeniu głównym: ${rateCell(s.soft.conflictShown)}`);
  L.push(`- I — ostrzeżenie o domenie z bazy incydentów / statusie źródła: ${rateCell(s.soft.incidentWarning)}`);
  L.push(`- Oczywiste przypadki — poprawny werdykt i co najmniej oczekiwana siła dowodów: ${rateCell(s.soft.strengthAtLeast)}${s.soft.strengthMisses.length ? ` (nie spełnione: ${s.soft.strengthMisses.join("; ")})` : ""}`);
  L.push(`- Siła dowodów przy poprawnych werdyktach FAŁSZYWE/POTWIERDZONE: mocna ${s.soft.correctMeritStrength.mocna}, średnia ${s.soft.correctMeritStrength.srednia}, słaba ${s.soft.correctMeritStrength.slaba}`);
  L.push(`- Silnik sam deklaruje sprawę moderatora (nie powinien — robi to warstwa rozmowy po zapisie): ${s.soft.engineModeratorClaims.length ? s.soft.engineModeratorClaims.join(", ") : "brak"}`);
  if (s.citationCoverage.missing.length) L.push(`- Twierdzenia z werdyktem rozstrzygającym bez cytatu: ${s.citationCoverage.missing.map((m) => `${m.caseId}/${m.claimId}`).join(", ")}`);
  if (s.citationCorrectness.failures.length) L.push(`- Cytaty niezgodne z rekordem: ${s.citationCorrectness.failures.map((f) => `${f.caseId}/${f.recordId} (${f.reason})`).join(", ")}`);
  if (s.faults.failures.length) L.push(`- Usterki obsłużone źle: ${s.faults.failures.map((f) => `${f.caseId} → ${f.status}/${f.verdict ?? "-"}`).join(", ")}`);
  L.push("");
  return L.join("\n");
}
