import type { Claim, CorpusRecord, CorpusStore, EvidenceAssessment, VerdictReport } from "../shared/contracts";
import { REGISTER_TOPIC, registeredMembers } from "../corpus/ingest/member-register";
import { ENLARGEMENT_URL, EU_COUNTRIES_URL, EURO_AREA_URL } from "../corpus/ingest/eu-membership";
import { NATO_MEMBERS_URL, NATO_PL } from "../corpus/ingest/nato-data";
import { answerEvidenceItem } from "./answer";
import { buildJustification, buildSummaryPl } from "./justify";
import { countryIdentity, registeredCountryName, subjectAliases } from "./retrieval/subject";
import { detectInjection, decideVerdict } from "./ports";
import { foldForMatch, formatDatePl } from "./text";
import type { PublicationRun } from "./verify";

interface MembershipClaim {
  country: string;
  organization: "NATO" | "UE";
  negated: boolean;
  inputMode: "claim" | "question_yesno";
  claim: Claim;
}

export function parseMembership(text: string): MembershipClaim | undefined {
  const input = text.trim().normalize("NFC");
  if (input.length > 150) return;
  const statement = input.replace(/^czy\s+/iu, "").replace(/[.?]$/u, "");
  const m = /^([\p{L}]+(?:[ -][\p{L}]+){0,4}?)\s+(?:(?:obecnie|aktualnie)\s+)?(nie\s+)?(?:(?:jest|są)\s+(?:członkiem|członkami|w)|(?:należy|należą)\s+do)\s+(NATO|UE|Unii Europejskiej)$/iu.exec(statement);
  if (!m || !registeredCountryName(m[1]!)) return;
  return { country: m[1]!, negated: !!m[2], organization: m[3]!.toUpperCase() === "NATO" ? "NATO" : "UE",
    inputMode: /^czy\s/iu.test(input) || input.endsWith("?") ? "question_yesno" : "claim",
    claim: { id: "c1", text: statement + ".", type: "fakt", temporal: { kind: "stan" }, assertedAspect: "sedno", isMain: true, inputOverlap: 1 } };
}

export const MEMBERSHIP_FRESH_READ_MS = 30 * 86_400_000;
const EU_PROFILE_PREFIX = EU_COUNTRIES_URL.replace(/_pl$/, "/");
type RegisterEntry = { record: CorpusRecord; country: string; member: boolean; quote: string; complete?: boolean };

function readEntry(r: CorpusRecord, q: MembershipClaim, names: Set<string>, now: Date): RegisterEntry | undefined {
  const age = now.getTime() - Date.parse(r.fetchedAt);
  if (r.role !== "tresc" || r.type !== "pierwotne" || r.level !== 1 || r.origin !== "corpus" ||
      !Number.isFinite(age) || age < 0 || age >= MEMBERSHIP_FRESH_READ_MS) return;
  if (r.topics.includes(REGISTER_TOPIC)) {
    const allowed = q.organization === "NATO" ? r.sourceId === "nato" && r.url === NATO_MEMBERS_URL :
      r.sourceId === "eu-portal" && (r.url === EU_COUNTRIES_URL || r.url === EURO_AREA_URL);
    const identities = allowed ? registeredMembers(r, q.organization) : undefined;
    const country = countryIdentity(q.country);
    if (!identities || !country || detectInjection(r.text, "quote", r.id).length) return;
    return { record: r, country: q.country, member: identities.includes(country), quote: r.text, complete: true };
  }
  let member = true;
  let country: string | undefined;
  let quote: string | undefined;
  if (q.organization === "NATO" && r.sourceId === "nato" && r.url === NATO_MEMBERS_URL && r.topics.includes("generated-from-data")) {
    // The accession date alone would only establish a historical event. Require the named row of the member list.
    const m = /^([^—\n]+?) — członkostwo w NATO od [^\n]*?Lista państw członkowskich NATO: „([^”\n]+) (?:19|20)\d{2}”\./u.exec(r.text);
    if (!m || NATO_PL[m[2]!] !== m[1] || !r.title.startsWith(`NATO: ${m[1]} — członkostwo w NATO od `)) return;
    country = m?.[1]; quote = m?.[0];
  } else if (q.organization === "UE" && r.sourceId === "eu-portal") {
    if (r.url === ENLARGEMENT_URL && r.topics.includes("kraj-kandydujacy")) {
      const m = /^([^()\n]+?) \(kraj kandydujący do UE\)/u.exec(r.text);
      country = m?.[1]; quote = m?.[0]; member = false;
    } else if (r.url === EU_COUNTRIES_URL && r.topics.includes("profil-panstwa")) {
      country = /^Unia Europejska: (.+?) — członkostwo w UE,/u.exec(r.title)?.[1];
      if (/^Państwo członkowskie UE od \d{4} r\./u.test(r.text)) quote = r.text;
    } else if (r.url.startsWith(EU_PROFILE_PREFIX) && r.topics.includes("profil-panstwa")) {
      country = /^Unia Europejska: (.+?) — informacje o kraju UE$/u.exec(r.title)?.[1];
      quote = /^W UE: od [^\n]*\d{4} r\./mu.exec(r.text)?.[0];
    }
  }
  if (!country || !quote || !country.split(/[()]/u).some(s => names.has(foldForMatch(s)))) return;
  if (detectInjection([r.title, r.publisher, quote].join("\n"), "evidence", r.id).length) return;
  return { record: r, country: country.split(" (")[0]!, member, quote };
}

export function membershipEntries(store: CorpusStore, q: MembershipClaim, now: Date) {
  if (!store.catalogPage) return;
  const aliases = subjectAliases(q.country).split(" | ");
  const names = new Set(aliases.map(foldForMatch));
  const pages = q.organization === "NATO" ? [NATO_MEMBERS_URL] : [EU_COUNTRIES_URL, EURO_AREA_URL, ENLARGEMENT_URL,
    ...aliases.filter(alias => /^[a-z -]+$/iu.test(alias)).map(alias => EU_PROFILE_PREFIX + alias.toLowerCase().replace(/ /gu, "-") + "_pl")];
  const rows = [...new Set(pages)].flatMap(url => store.catalogPage!(url).filter(r => r.url === url));
  // Older/custom corpora can omit this adapter; their normal retrieval remains available.
  if (!rows.length) return;
  const entries = rows.flatMap(r => readEntry(r, q, names, now) ?? []);
  const individual = entries.filter(e => !e.complete);
  if (individual.length && entries.every(e => e.member === individual[0]!.member)) return individual;
  return entries;
}

export function membershipReport(run: PublicationRun & { assessedRecords: Set<string> }, q: MembershipClaim): VerdictReport | undefined {
  const now = run.deps.now();
  run.stage("searching");
  let entries: RegisterEntry[] | undefined;
  try { entries = membershipEntries(run.deps.store, q, now); }
  catch {
    run.claims = [q.claim]; run.inputMode = q.inputMode;
    run.recordLookup("official_membership", "unavailable", []);
    return run.report({ status: "NIEPELNE", statusMessagePl: "Nie udało się odczytać oficjalnego wykazu członkostwa." });
  }
  if (!entries) return;
  run.claims = [q.claim]; run.inputMode = q.inputMode;
  run.recordLookup("official_membership", "completed", entries.map(e => e.record.id));
  for (const e of entries) run.assessedRecords.add(e.record.id);
  const records = new Map(entries.map(e => [e.record.id, e.record]));
  const inconsistent = new Set(entries.map(e => e.member)).size > 1;
  const assessments: EvidenceAssessment[] = entries.map(e => ({
    claimId: q.claim.id, recordId: e.record.id, aspect: "sedno", quote: e.quote, quoteVerified: true,
    quoteMatchScore: 1, period: e.record.fetchedAt.slice(0, 10), relation: e.member !== q.negated ? "WSPIERA" : "OBALA",
    verifier: "brak", decisive: !inconsistent, ...(inconsistent && { excluded: "inconsistent_registry" }),
  }));
  const d = decideVerdict({ claim: q.claim, records, assessments, now, singleKeyVerifier: false });
  const used = new Set(d.decisiveRecordIds);
  const evidence = assessments.map(a => ({ ...answerEvidenceItem(records.get(a.recordId)!, a.quote, a.relation), usedForVerdict: used.has(a.recordId) }));
  const source = q.organization === "NATO" ? "oficjalnym wykazie NATO" : "wykazach członków i kandydatów Unii Europejskiej";
  const justification = buildJustification({ claim: q.claim, records, assessments, decision: d, searchedPl: [source], unavailablePl: [], verdictMode: "rules" });
  const reasonPl = inconsistent ? "Aktualne wpisy w wykazach podają sprzeczny status tego państwa." :
    entries.length ? justification.reasonPl : `W ${source} brakuje jednoznacznego wpisu dla tego państwa odczytanego w ciągu ostatnich 30 dni.`;
  const first = entries.find(e => used.has(e.record.id));
  const plural = /(?:^|\s)(?:są|należą)\s/iu.test(q.claim.text);
  const registerFactPl = first && (first.member
    ? `${first.country} ${plural ? "należą" : "należy"} do ${q.organization}.`
    : first.complete ? `${first.country} ${plural ? "nie należą" : "nie należy"} do ${q.organization}.`
      : `${first.country} ${plural ? "mają" : "ma"} status kandydata do UE.`);
  const verdict = { claimId: q.claim.id, verdict: d.verdict, ruleApplied: d.ruleApplied, strength: d.strength, reasonPl, evidence,
    ...(registerFactPl && { registerFactPl }),
    ...(d.conflicting && { conflicting: d.conflicting }), ...(justification.triedPl && { triedPl: justification.triedPl }) };
  const latest = entries.map(e => e.record.fetchedAt).sort().at(-1);
  return run.report({ status: "OK", verdictMode: "rules", mainVerdict: d.verdict, verdicts: [verdict], summaryPl: buildSummaryPl(verdict, 0),
    transparencyPl: first?.complete
      ? `Kod porównał rozpoznane państwo z pełnym wykazem. Liczba unikalnych państw zgadza się z liczbą podaną przez wydawcę. W raporcie podajemy cały wykaz i adres źródła. Data odczytu: ${formatDatePl(first.record.fetchedAt)}.`
      : `Kod porównał nazwę państwa i status w ${source}. Uwzględnia odczyty z ostatnich 30 dni. ` +
      (latest ? `Data odczytu wpisu: ${formatDatePl(latest)}.` : "Sam brak pozycji nie przesądza o członkostwie.") });
}
