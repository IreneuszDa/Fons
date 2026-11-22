import type { Claim, EvidenceAssessment, VerdictReport } from "../shared/contracts";
import { incumbentRow, NATO_SECRETARIES_URL, previousRow } from "../corpus/ingest/nato-office-list";
import { answerEvidenceItem, buildAnswer } from "./answer";
import { buildSummaryPl } from "./justify";
import { MEMBERSHIP_FRESH_READ_MS } from "./membership";
import { decideVerdict, detectInjection } from "./ports";
import { foldForMatch, formatDatePl } from "./text";
import type { PublicationRun } from "./verify";

interface OfficeQuestion { statement: string; name?: string; negated: boolean; mode: "claim" | "question_yesno" | "question_open" }

export function currentNatoOfficeQuestion(text: string): OfficeQuestion | undefined {
  const input = text.normalize("NFC").trim();
  if (input.length > 190) return;
  const statement = input.replace(/^Czy(?: to prawda, że)?\s+/iu, "").replace(/[?.]$/u, "").trim();
  const normalized = statement.replace(/\b(?:obecnie|teraz|aktualnie)\b\s*/giu, "").replace(/\s+/gu, " ").trim();
  if (/^kto (?:jest sekretarzem generalnym NATO|pełni funkcję sekretarza generalnego NATO)$/iu.test(normalized)) {
    return { statement, negated: false, mode: "question_open" };
  }
  const before = /^(.+?) (nie )?(?:jest sekretarzem generalnym NATO|pełni funkcję sekretarza generalnego NATO)$/iu.exec(normalized);
  const after = /^(?:sekretarzem generalnym NATO (nie )?jest|funkcję sekretarza generalnego NATO (nie )?pełni) (.+)$/iu.exec(normalized);
  const name = before?.[1] ?? after?.[3];
  // A name must fill the whole subject position, without dates, qualifications, or a subordinate clause.
  if (!name || !/^[\p{Lu}][\p{L}’'.-]+(?: (?:[\p{Lu}][\p{L}’'.-]+|de|van|von|of|der|den|the)){1,8}$/u.test(name)) return;
  return { statement, name, negated: !!(before?.[2] || after?.[1] || after?.[2]),
    mode: /^czy\s/iu.test(input) || input.endsWith("?") ? "question_yesno" : "claim" };
}

export function natoOfficeReport(run: PublicationRun & { assessedRecords: Set<string> }, text: string): VerdictReport | undefined {
  const q = currentNatoOfficeQuestion(text);
  if (!q) return;
  const now = run.deps.now();
  const records = (run.deps.store.catalogPage?.(NATO_SECRETARIES_URL) ?? []).filter(r => r.sourceId === "nato" &&
    r.url === NATO_SECRETARIES_URL && r.role === "tresc" && r.type === "pierwotne" && r.level === 1 && r.origin === "corpus" &&
    r.topics.includes("sekretarz-generalny-nato") && Date.parse(r.fetchedAt) <= +now && +now - Date.parse(r.fetchedAt) < MEMBERSHIP_FRESH_READ_MS &&
    !detectInjection(r.text, "evidence", r.id).length);
  const active = records.flatMap(record => {
    if (!record.topics.includes("urzedujacy") || record.period !== record.fetchedAt.slice(0, 10)) return [];
    const row = incumbentRow(record.title, record.text.split("\n")[1] ?? "");
    return row && row.quote === record.text && row.since <= record.period ? [{ ...row, record }] : [];
  });
  if (active.length !== 1) return;
  const incumbent = active[0]!;
  const currentFact = `Sekretarzem generalnym NATO jest ${incumbent.name}. Sprawuje tę funkcję od ${formatDatePl(incumbent.since)} r.`;
  const register = (ids: string[]) => {
    run.stage("searching"); run.inputMode = q.mode;
    run.recordLookup("nato_secretaries_general", "completed", ids);
    ids.forEach(id => run.assessedRecords.add(id));
  };
  if (!q.name) {
    register([incumbent.record.id]);
    return run.report({ status: "OK", verdicts: [], mainVerdict: null, summaryPl: currentFact,
      answer: buildAnswer(text, incumbent.record, incumbent.quote, currentFact) });
  }
  const wanted = foldForMatch(q.name);
  const same = wanted === foldForMatch(incumbent.name);
  const previous = records.flatMap(record => {
    if (record.fetchedAt !== incumbent.record.fetchedAt || !record.topics.includes("kadencja") || record.title !== record.text) return [];
    const row = previousRow(record.text);
    return row && row.period === record.period && row.end <= incumbent.since.slice(0, 4) ? [{ ...row, record }] : [];
  });
  const earlier = previous.filter(p => foldForMatch(p.name) === wanted);
  // Avoid interpreting an abbreviation or an incomplete multi-part name as a different person.
  if (earlier.length > 1 || (!same && !earlier.length && [incumbent, ...previous].some(p =>
    foldForMatch(p.name).split(" ").some(part => wanted.split(" ").includes(part))))) return;
  const old = !same && !q.negated ? earlier[0] : undefined;
  const rows = [...(old ? [{ record: old.record, supports: true }] : []), { record: incumbent.record, supports: same !== q.negated }];
  const claim: Claim = { id: "c1", text: q.statement + ".", type: "fakt", temporal: { kind: "stan" }, assertedAspect: "sedno", isMain: true, inputOverlap: 1 };
  const assessments: EvidenceAssessment[] = rows.map(({ record, supports }) => ({ claimId: claim.id, recordId: record.id,
    aspect: "sedno", period: record.period, relation: supports ? "WSPIERA" : "OBALA", quote: record.text, quoteVerified: true,
    quoteMatchScore: 1, verifier: "brak", decisive: true }));
  const byId = new Map(rows.map(({ record }) => [record.id, record]));
  const decision = decideVerdict({ claim, assessments, records: byId, now, singleKeyVerifier: false });
  if (decision.decisiveRecordIds.length !== rows.length) return;
  register(decision.decisiveRecordIds); run.claims = [claim];
  const fact = (old ? `NATO podaje lata ${old.start}–${old.end} przy nazwisku ${old.name}. ` : "") + currentFact;
  const evidence = assessments.map(a => ({ ...answerEvidenceItem(byId.get(a.recordId)!, a.quote, a.relation), usedForVerdict: true }));
  const verdict = { claimId: claim.id, verdict: decision.verdict, ruleApplied: decision.ruleApplied, strength: decision.strength, reasonPl: fact, registerFactPl: fact, evidence };
  return run.report({ status: "OK", verdictMode: "rules", mainVerdict: verdict.verdict, verdicts: [verdict], summaryPl: buildSummaryPl(verdict, 0),
    transparencyPl: `W oficjalnym wykazie odczytanym ${formatDatePl(incumbent.record.fetchedAt)} r. NATO wyróżnia osobę urzędującą i podaje osobno poprzednie kadencje.` });
}
