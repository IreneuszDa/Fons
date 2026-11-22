import type { Claim, ClaimVerdict, CorpusRecord, CorpusStore, EvidenceAssessment, VerdictReport } from "../shared/contracts";
import { EU_COUNTRIES_URL } from "../corpus/ingest/eu-membership";
import { NATO_MEMBERS_URL, NATO_PL } from "../corpus/ingest/nato-data";
import { MONTHS_GENITIVE_PL } from "../security/dates";
import { answerEvidenceItem } from "./answer";
import { buildSummaryPl } from "./justify";
import { decideVerdict, detectInjection } from "./ports";
import { countryIdentity } from "./retrieval/subject";
import { aggregateCompound } from "./verdict/compound";
import type { PublicationRun } from "./verify";

const events = {
  euro: { object: /^(?:euro|do strefy euro)$/iu,
    field: /^Strefa euro: w strefie euro od /u, label: "wprowadzenia euro" },
  schengen: { object: /^do (?:strefy |obszaru )?Schengen$/iu,
    field: /^Strefa Schengen: w strefie Schengen od /u, label: "przystąpienia do strefy Schengen" },
  eu: { object: /^do (?:UE|Unii Europejskiej)$/iu,
    field: /^(?:W UE|Państwo członkowskie UE): od /u, label: "przystąpienia do UE" },
  nato: { object: /^do NATO$/iu, label: "przystąpienia do NATO" },
};

type Event = keyof typeof events;
type Subject = { country: string; event: Event };
type Target = { year: number; simultaneous: boolean } | { sameYear: boolean };

interface Comparison {
  subjects: Subject[];
  target: Target;
  inputMode: "question_yesno" | "claim";
  claim: Claim;
}

function eventFor(object: string, verb: string): Event | undefined {
  if (/^(?:wprowadz|przyj)/iu.test(verb) !== /^euro$/iu.test(object)) return;
  return (Object.keys(events) as Event[]).find(key => events[key].object.test(object));
}

export function accessionComparison(text: string): Comparison | undefined {
  const input = text.trim().normalize("NFC");
  if (input.length > 300) return;
  const statement = input.replace(/^Czy\s+/iu, "").replace(/[.?]$/u, "").trim();
  const verb = "(?:wprowadzi(?:ły|ła|ł)|przyję(?:ły|ła)|przyjął|przystąpi(?:ły|ła|ł)|dołączy(?:ły|ła|ł)|wesz(?:ły|ła)|wszedł|wstąpi(?:ły|ła|ł))";
  const when = "(?:tym samym roku|różnych latach|(?:19|20)\\d{2}(?: r\\.?| roku)?)";
  const normalized = statement.replace(new RegExp(` w (${when}) (${verb} .+)$`, "iu"), " $2 w $1");
  const m = new RegExp(`^(.+?) (${verb}) (.+?) w (${when})$`, "iu").exec(normalized);
  if (!m) return;
  const countries = m[1]!.split(/\s*,\s*|\s+(?:i|oraz)\s+/iu).map(countryIdentity);
  if (countries.some(c => !c) || new Set(countries).size !== countries.length) return;
  // A coordinated verb can govern both organizations. Explicit simultaneity is stronger than sharing a year.
  const simultaneous = /\s+(?:razem|wraz|jednocześnie|równocześnie) z (?:przystąpieniem|wejściem|dołączeniem) /iu;
  const together = simultaneous.test(m[3]!);
  const objects = m[3]!.split(together ? simultaneous : /\s*,\s*|\s+(?:i|oraz)\s+/iu);
  const repeatsVerb = new RegExp(`^(${verb}) (.+)$`, "iu");
  const governingDo = /^do /iu.test(objects[0]!);
  const types = objects.map((object, i) => {
    if (i === 0) return eventFor(object, m[2]!);
    const stated = repeatsVerb.exec(object);
    if (stated) return eventFor(stated[2]!, stated[1]!);
    // In "do UE i strefy Schengen" one preposition governs both objects.
    const target = !together && governingDo && !/^do /iu.test(object) ? "do " + object : object;
    return eventFor(target, together ? "przystąpił" : m[2]!);
  });
  if (types.some(e => !e) || new Set(types).size !== types.length) return;
  const subjects = countries.flatMap(country => types.map(event => ({ country: country!, event: event! })));
  if (subjects.length < 2) return;
  const year = Number.parseInt(m[4]!, 10);
  const target = Number.isFinite(year)
    ? { year, simultaneous: together }
    : { sameYear: m[4]!.toLowerCase() === "tym samym roku" };
  if ("sameYear" in target && subjects.length !== 2) return;
  // Without a direct comparison of calendar years, one year alone cannot settle an assertion of simultaneous entry.
  if ("sameYear" in target && together) return;
  return { subjects, target, inputMode: /^czy\s/iu.test(input) || input.endsWith("?") ? "question_yesno" : "claim",
    claim: { id: "c1", text: statement + ".", type: "fakt", temporal: { kind: "jednorazowe" },
      assertedAspect: "sedno", isMain: true, inputOverlap: 1 } };
}

type Entry = { record: CorpusRecord; name: string; quote: string; year: number };

function profileEntry(record: CorpusRecord, country: string, event: Exclude<Event, "nato">, now: number): Entry | undefined {
  const name = /^Unia Europejska: (.+?) — informacje o kraju UE$/u.exec(record.title)?.[1];
  if (record.sourceId !== "eu-portal" || !record.topics.includes("profil-panstwa") || !name || countryIdentity(name) !== country) return;
  const lines = record.text.split("\n").filter(line => events[event].field.test(line));
  if (lines.length !== 1) return;
  const quote = lines[0]!;
  const date = /^(\d{1,2}) (\p{L}+) (\d{4}) r\.$/u.exec(quote.replace(events[event].field, ""));
  if (!date) return;
  const month = MONTHS_GENITIVE_PL.findIndex(name => name === date[2]);
  const year = Number(date[3]);
  const when = new Date(Date.UTC(year, month, Number(date[1])));
  if (month < 0 || when.getUTCDate() !== Number(date[1]) || when.getTime() > now) return;
  return { record, name, quote, year };
}

function natoEntry(record: CorpusRecord, country: string, now: number): Entry | undefined {
  if (record.sourceId !== "nato" || !record.topics.includes("generated-from-data") || !record.topics.includes("data-przystapienia")) return;
  const row = /Lista państw członkowskich NATO: „([^”\n]+) ((?:19|20)\d{2})”\./u.exec(record.text);
  if (!row || countryIdentity(row[1]!) !== country) return;
  const name = NATO_PL[row[1]!];
  if (!name || record.title !== `NATO: ${name} — członkostwo w NATO od ${row[2]} r.` ||
      !record.text.startsWith(name + " — członkostwo w NATO od ") || !record.period?.startsWith(row[2]!) ||
      record.text.includes("państwo założycielskie") || !(Date.parse(record.period) <= now)) return;
  return { record, name, quote: row[0], year: Number(row[2]) };
}

export function accessionEntry(store: CorpusStore, country: string, event: Event, now: number): Entry | undefined {
  const slug = country.toLowerCase().replaceAll(" ", "-");
  const url = event === "nato" ? NATO_MEMBERS_URL : EU_COUNTRIES_URL.replace(/_pl$/u, "/" + slug + "_pl");
  const matches = (store.catalogPage?.(url) ?? []).flatMap(record => {
    if (record.url !== url || record.type !== "pierwotne" || record.level !== 1 || record.role !== "tresc" ||
        record.origin !== "corpus" || !(Date.parse(record.fetchedAt) <= now) ||
        detectInjection([record.title, record.text].join("\n"), "evidence", record.id).length) return [];
    return (event === "nato" ? natoEntry(record, country, now) : profileEntry(record, country, event, now)) ?? [];
  });
  return matches.length && matches.every(row => row.year === matches[0]!.year) ? matches[0] : undefined;
}

type Reading = Entry & { event: Event };
type Relation = "WSPIERA" | "OBALA";
type Assessment = { reading: Reading; relation: Relation };

function decisionFor(claim: Claim, rows: Assessment[], now: Date) {
  const records = new Map(rows.map(({ reading }) => [reading.record.id, reading.record]));
  const assessments: EvidenceAssessment[] = rows.map(({ reading, relation }) => ({
    claimId: claim.id, recordId: reading.record.id, aspect: "sedno", relation, quote: reading.quote, period: String(reading.year),
    quoteVerified: true, quoteMatchScore: 1, verifier: "brak", decisive: true,
  }));
  const decision = decideVerdict({ claim, records, assessments, now, singleKeyVerifier: false });
  if (decision.verdict === (rows[0]!.relation === "WSPIERA" ? "POTWIERDZONE" : "FALSZYWE") &&
      rows.every(({ reading }) => decision.decisiveRecordIds.includes(reading.record.id))) return decision;
}

function evidenceFor({ reading, relation }: Assessment) {
  return { ...answerEvidenceItem(reading.record, reading.quote, relation), usedForVerdict: true };
}

function compareYears(claim: Claim, entries: Reading[], sameYear: boolean, now: Date): ClaimVerdict | undefined {
  const equal = entries[0]!.year === entries[1]!.year;
  const relation = equal === sameYear ? "WSPIERA" : "OBALA";
  const rows = entries.map(reading => ({ reading, relation }) satisfies Assessment);
  const decision = decisionFor(claim, rows, now);
  if (!decision) return;
  const dates = entries.map(e => `${e.name} — rok ${events[e.event].label}: ${e.year}`).join(", ");
  const fact = `Rejestr podaje ${equal ? "ten sam rok" : "różne lata"}. ${dates}.`;
  return { claimId: claim.id, verdict: decision.verdict, ruleApplied: decision.ruleApplied, strength: decision.strength,
    reasonPl: fact, registerFactPl: fact, evidence: rows.map(evidenceFor) };
}

function checkYear(claim: Claim, entries: Reading[], year: number, simultaneous: boolean, now: Date): ClaimVerdict | undefined {
  // Sharing a calendar year is insufficient evidence of two accessions occurring together.
  if (simultaneous && entries.every(e => e.year === year)) return;
  const outcomes = [];
  const rows: Assessment[] = [];
  for (const [i, reading] of entries.entries()) {
    const relation = year === reading.year ? "WSPIERA" : "OBALA";
    const row = { reading, relation } satisfies Assessment;
    const subject = `${reading.name} — rok ${events[reading.event].label}`;
    const part = { ...claim, id: `${claim.id}.${i + 1}`, text: `${subject}: ${year}` };
    const decision = decisionFor(part, [row], now);
    if (!decision) return;
    outcomes.push({ ...decision, claim: part, reasonPl: `${subject}: ${reading.year}` });
    rows.push(row);
  }
  const { verdict, strength, ruleApplied } = aggregateCompound(outcomes);
  const fact = outcomes.map(p => p.reasonPl).join(", ") + ".";
  return { claimId: claim.id, verdict, strength, ruleApplied, reasonPl: fact, registerFactPl: fact,
    parts: outcomes.map((p, i) => ({ text: p.claim.text, verdict: p.verdict, reasonPl: p.reasonPl,
      ruleApplied: p.ruleApplied, evidence: [evidenceFor(rows[i]!)] })), evidence: rows.map(evidenceFor) };
}

export function accessionComparisonReport(run: PublicationRun & { assessedRecords: Set<string> }, q: Comparison): VerdictReport | undefined {
  const now = run.deps.now();
  const entries: Reading[] = [];
  try {
    for (const { country, event } of q.subjects) {
      const entry = accessionEntry(run.deps.store, country, event, +now);
      if (!entry) return;
      entries.push({ ...entry, event });
    }
  } catch {
    run.recordLookup("official_accession_years", "unavailable", []);
    return;
  }
  const verdict = "year" in q.target
    ? checkYear(q.claim, entries, q.target.year, q.target.simultaneous, now)
    : compareYears(q.claim, entries, q.target.sameYear, now);
  if (!verdict) return;
  run.stage("searching"); run.claims = [q.claim]; run.inputMode = q.inputMode;
  const ids = [...new Set(entries.map(e => e.record.id))];
  run.recordLookup("official_accession_years", "completed", ids);
  ids.forEach(id => run.assessedRecords.add(id));
  return run.report({ status: "OK", verdictMode: "rules", mainVerdict: verdict.verdict, verdicts: [verdict],
    summaryPl: buildSummaryPl(verdict, 0), transparencyPl: "Dla każdego państwa i zdarzenia kod odczytał rok z oficjalnego wykazu. Cytaty pokazują, które wpisy rozstrzygają poszczególne części twierdzenia." });
}
