import type { Claim, CorpusRecord, EvidenceAssessment, VerdictReport } from "../shared/contracts";
import { CLUB_ROLL_CALLS, clubHistoryId, rollCallUrl } from "../corpus/ingest/sejm-club-history";
import { answerEvidenceItem } from "./answer";
import { buildSummaryPl } from "./justify";
import { MEMBERSHIP_FRESH_READ_MS } from "./membership";
import { decideVerdict, detectInjection } from "./ports";
import { primarySubjectIds } from "./retrieval/subject";
import { foldForMatch, formatDatePl } from "./text";
import type { PublicationRun } from "./verify";

type ClubRun = PublicationRun & { assessedRecords: Set<string> };
type Observation = { record: CorpusRecord; club: string; day: string; quote: string };

function official(r: CorpusRecord, now: number): boolean {
  return r.sourceId === "sejm-eli" && r.level === 1 && r.type === "pierwotne" && r.role === "tresc" && r.origin === "corpus" &&
    r.topics.includes("generated-from-data") && Date.parse(r.fetchedAt) <= now && !detectInjection(r.text, "evidence", r.id).length;
}

function currentObservation(r: CorpusRecord, name: string, now: number) {
  if (!official(r, now) || !r.topics.includes("mandat-aktywny") ||
      now - Date.parse(r.fetchedAt) >= MEMBERSHIP_FRESH_READ_MS) return;
  const url = /^https:\/\/api\.sejm\.gov\.pl\/sejm\/term(\d+)\/MP\/(\d+)$/u.exec(r.url);
  const title = /^Poseł\/posłanka (.+?) - (.+?) \(Sejm [XVI]+ kadencji\)$/u.exec(r.title);
  if (!url || !title || foldForMatch(title[1]!) !== foldForMatch(name) || !r.text.startsWith(title[1]! + " - poseł/posłanka na Sejm RP ")) return;
  const quote = r.text.split(";")[0]!;
  if (title[2] === "niezrzeszony" ? !quote.includes("poseł niezrzeszony") : !quote.endsWith(`(${title[2]})`)) return;
  return { record: r, name: title[1]!, club: title[2]!, day: r.fetchedAt.slice(0, 10), quote, term: Number(url[1]), mp: Number(url[2]) };
}

function pastObservations(current: NonNullable<ReturnType<typeof currentObservation>>, run: ClubRun, now: number): Observation[] {
  return CLUB_ROLL_CALLS.filter(v => v.term === current.term).flatMap(ref => {
    const url = rollCallUrl(ref);
    const r = run.deps.store.get(clubHistoryId(url, current.mp));
    if (!r || !official(r, now) || r.url !== url || !r.topics.includes("imienne-glosowanie") ||
        !r.period || !/^\d{4}-\d{2}-\d{2}$/u.test(r.period) || r.period >= current.day) return [];
    const club = / widnieje klub lub koło: (.+)\.$/u.exec(r.text)?.[1];
    if (!club || !r.text.includes(`(MP ${current.mp})`) || !r.text.startsWith("W imiennym wykazie głosowania Sejmu z " + r.period + " ")) return [];
    return [{ record: r, club, day: r.period, quote: r.text }];
  });
}

const clubKey = (name: string) => foldForMatch(name).replaceAll(" ", "");

// Only accept an official acronym or a registered club name. A party or electoral list is a different question.
function resolveClub(run: ClubRun, term: number, name: string, group: string, now: number): string | undefined {
  const key = clubKey(name);
  const clubIds = new Set<string>();
  const records = run.deps.db.prepare("SELECT id FROM records WHERE source_id='sejm-eli' AND url LIKE ?")
    .all(`https://api.sejm.gov.pl/sejm/term${term}/clubs/%`) as { id: string }[];
  for (const r of run.deps.store.getMany(records.map(row => row.id))) {
    if (!official(r, now) || !r.topics.includes("klub-poselski")) continue;
    const m = /^Klub lub koło poselskie ([^:]+): (.+) \(Sejm [XVI]+ kadencji\)$/u.exec(r.title);
    if (!m || !r.url.endsWith("/clubs/" + encodeURIComponent(m[1]!))) continue;
    const groupName = foldForMatch(m[2]!).split(" ");
    if (!groupName.includes(group === "koła" ? "kolo" : "klub")) continue;
    const names = [m[1]!, m[2]!, m[2]!.replace(/^(?:Klub (?:Parlamentarny|Poselski)|(?:Poselskie|Parlamentarne) Koło|Koło (?:Poselskie|Parlamentarne))\s+/iu, "")];
    if (names.some(n => clubKey(n) === key)) clubIds.add(m[1]!);
  }
  return clubIds.size === 1 ? [...clubIds][0] : undefined;
}

export function sejmClubReport(run: ClubRun, text: string): VerdictReport | undefined {
  const input = text.trim().normalize("NFC");
  if (input.length > 170) return;
  const statement = input.replace(/^Czy\s+/iu, "").replace(/[?.]$/u, "").trim();
  const m = /^([\p{L}][\p{L} -]+?)\s+(?:(?:obecnie|aktualnie)\s+)?(nie\s+)?(?:należy do|jest (?:członkiem|członkinią))\s+(klubu|koła)\s+([\p{L}\d][\p{L}\d _-]*)$/iu.exec(statement);
  if (!m || typeof run.deps.db?.prepare !== "function") return;
  const now = run.deps.now();
  const reads = run.deps.store.getMany(primarySubjectIds(run.deps.db, m[1]!)).flatMap(r => currentObservation(r, m[1]!, +now) ?? []);
  if (reads.length !== 1) return;
  const current = reads[0]!;
  const history = pastObservations(current, run, +now);
  const club = resolveClub(run, current.term, m[4]!, m[3]!.toLocaleLowerCase("pl"), +now);
  if (!club) return;
  const supports = (o: Observation) => (o.club === club) !== !!m[2];
  const old = history.filter(o => supports(o) && !supports(current)).sort((a, b) => b.day.localeCompare(a.day))[0];
  const rows = old ? [old, current] : [current];
  const claim: Claim = { id: "c1", text: statement + ".", type: "fakt", temporal: { kind: "stan" }, assertedAspect: "sedno", isMain: true, inputOverlap: 1 };
  const assessments: EvidenceAssessment[] = rows.map(o => ({ claimId: claim.id, recordId: o.record.id, aspect: "sedno", period: o.day,
    relation: supports(o) ? "WSPIERA" : "OBALA", quote: o.quote, quoteVerified: true, quoteMatchScore: 1, verifier: "brak", decisive: true }));
  const records = new Map(rows.map(o => [o.record.id, o.record]));
  const d = decideVerdict({ claim, assessments, records, now, singleKeyVerifier: false });
  if (d.decisiveRecordIds.length !== rows.length) return;
  const fact = (old ? `W głosowaniu z ${formatDatePl(old.day)} Sejm podał przy tej osobie „${old.club}”. ` : "") +
    `W wykazie posłów odczytanym ${formatDatePl(current.day)} przy nazwisku ${current.name} widnieje „${current.club}”.`;
  const evidence = assessments.map(a => ({ ...answerEvidenceItem(records.get(a.recordId)!, a.quote, a.relation), usedForVerdict: true }));
  const verdict = { claimId: claim.id, verdict: d.verdict, ruleApplied: d.ruleApplied, strength: d.strength, reasonPl: fact, registerFactPl: fact, evidence };
  run.stage("searching"); run.claims = [claim]; run.inputMode = /^czy\s/iu.test(input) || input.endsWith("?") ? "question_yesno" : "claim";
  run.recordLookup("sejm_club_register", "completed", d.decisiveRecordIds);
  d.decisiveRecordIds.forEach(id => run.assessedRecords.add(id));
  return run.report({ status: "OK", verdictMode: "rules", mainVerdict: d.verdict, verdicts: [verdict], summaryPl: buildSummaryPl(verdict, 0),
    transparencyPl: "Kod odczytał klub z rejestru aktywnych posłów. Wpisy w głosowaniach dotyczą wyłącznie dnia wskazanego przez Sejm." });
}
