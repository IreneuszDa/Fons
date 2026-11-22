import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CorpusRecord, type Claim, type EvidenceAssessment } from "../shared/contracts";
import { preciseDateAssessment, refutesPriorMembership, requestedEventDay, statedDays } from "./event-day";
import { decideVerdict } from "./verdict/rules";
import { asksForElectionRoundDate, publishedRoundDay } from "./election-result";

function entries(file: string) {
  return readFileSync(new URL("../../data/corpus/" + file + ".jsonl", import.meta.url), "utf8").trim().split("\n")
    .map(line => CorpusRecord.parse(JSON.parse(line)));
}
const countries = entries("eu-portal");
const nato = entries("nato");
const request: Claim = { id: "c1", isMain: true, type: "fakt", assertedAspect: "czas", inputOverlap: 1,
  temporal: { kind: "stan", date: "2004-05-01" }, text: "Litwa jest członkiem Unii Europejskiej od 1 maja 2004 roku." };
const vote = (r: CorpusRecord, quote: string): EvidenceAssessment => ({ claimId: "c1", recordId: r.id, relation: "WSPIERA",
  aspect: "czas", quote, quoteVerified: true, quoteMatchScore: 1, verifier: "zgoda", decisive: false });

it("odróżnia listę podającą rok od pełnego pola w litewskim profilu UE", () => {
  const exact = countries.find(r => r.url.endsWith("/lithuania_pl"))!;
  const year = countries.find(r => r.title.startsWith("Unia Europejska: Litwa — członkostwo"))!;
  const quote = exact.text.split("\n").find(line => line.startsWith("W UE:"))!;
  const checked = [vote(exact, quote), vote(year, year.text)];
  const records = new Map([exact, year].map(r => [r.id, r]));
  const input = { claim: request, records, now: new Date("2026-11-22"), singleKeyVerifier: true };
  expect(requestedEventDay(request)).toBe("2004-05-01");
  expect(preciseDateAssessment("2004-05-01", checked[1]!, year).excluded).toBe("insufficient_event_date_precision");
  expect(decideVerdict({ ...input, assessments: checked })).toMatchObject({ verdict: "POTWIERDZONE", decisiveRecordIds: [exact.id] });
  expect(decideVerdict({ ...input, assessments: [checked[1]!] })).toMatchObject({ verdict: "BRAK_DOWODOW", decisiveRecordIds: [] });
});

it("rozpoznaje pełne daty z różnych zapisów i zachowuje rozdzielczość kalendarza", () => {
  expect(statedDays("1.05.2004; 1 May 2004; May 1, 2004; 2004-05-01; 1 maja 2004")).toEqual(["2004-05-01"]);
  expect(statedDays("2004; maj 2004; 31.02.2026")).toEqual([]);
});

it("wiąże jedyny rok wydarzenia z dniem w tej samej tezie", () => {
  const text = "Pierwsza tura wyborów prezydenckich w 2025 roku odbyła się 18 maja.";
  const claim: Claim = { ...request, text, temporal: { kind: "jednorazowe", date: "2025-05-18" } };
  expect(requestedEventDay(claim)).toBe("2025-05-18");
  expect(requestedEventDay({ ...claim, text: text.replace("18 maja", "19 maja") })).toBeUndefined();
  expect(requestedEventDay({ ...claim, text: text.replace("w 2025 roku ", "") })).toBeUndefined();
  expect(requestedEventDay({ ...claim, text: text.replace("18 maja", "18 maja lub 19 maja") })).toBeUndefined();
  expect(requestedEventDay({ ...claim, text: text.replace("w 2025 roku", "w 2024 lub w 2025 roku") })).toBeUndefined();
});

it("odróżnia dzień głosowania od frekwencji i dodatkowych twierdzeń o jego legalności", () => {
  expect(asksForElectionRoundDate("Czy druga tura wyborów samorządowych odbyła się 21 kwietnia 2024 roku?")).toBe(true);
  expect(asksForElectionRoundDate("Frekwencja w drugiej turze wyborów samorządowych 21 kwietnia 2024 roku była rekordowa.")).toBe(false);
  expect(asksForElectionRoundDate("Druga tura wyborów samorządowych odbyła się nielegalnie 21 kwietnia 2024 roku.")).toBe(false);
});

it("wiąże obie daty w opublikowanym raporcie z właściwymi turami i zakresem wyborów", () => {
  const report = entries("institutional-references").find(r => r.text.includes("których pierwsza tura odbyła się"))!;
  const question = "Czy pierwsza tura wyborów prezydenckich w Polsce odbyła się 1 czerwca 2025 roku?";
  expect(publishedRoundDay(question, report.text, report)).toBe("2025-05-18");
  expect(publishedRoundDay(question.replace("pierwsza", "druga"), "druga tura 1 czerwca 2025 r.", report)).toBe("2025-06-01");
  expect(publishedRoundDay(question.replace("Polsce", "Norwegii"), report.text, report)).toBeUndefined();
  expect(publishedRoundDay(question.replace("prezydenckich", "samorządowych"), report.text, report)).toBeUndefined();
  expect(publishedRoundDay(question, "druga tura 1 czerwca 2025 r.", report)).toBeUndefined();
});

it("odróżnia stan członkostwa w danym dniu od dnia akcesji, wniosku i przystąpienia innego kraju", () => {
  const claim: Claim = { ...request, text: "W dniu 1 stycznia 2016 r. Czarnogóra była już członkiem NATO.",
    temporal: { kind: "stan", date: "2016-01-01" }, assertedAspect: "sedno" };
  const register = nato.find(r => r.text.startsWith("Czarnogóra — członkostwo w NATO od"))!;
  const entry = register.text.split(").")[0] + ").";
  const reading: EvidenceAssessment = { ...vote(register, entry), relation: "OBALA" };
  expect(requestedEventDay(claim)).toBeUndefined();
  expect(refutesPriorMembership(claim, reading, register)).toBe(true);
  expect(refutesPriorMembership({ ...claim, text: claim.text.replace("Czarnogóra", "Serbia") }, reading, register)).toBe(false);
  expect(refutesPriorMembership({ ...claim, text: claim.text.replace("NATO", "UE") }, reading, register)).toBe(false);
  expect(refutesPriorMembership(claim, { ...reading, verifier: "niepewne" }, register)).toBe(false);
  const candidate = countries.find(r => r.text.includes("Status kandydata otrzymała"))!;
  expect(refutesPriorMembership(claim, { ...reading, recordId: candidate.id, quote: candidate.text }, candidate)).toBe(false);
  expect(decideVerdict({ claim, records: new Map([[register.id, register]]), assessments: [reading], now: new Date("2026-11-22"),
    singleKeyVerifier: true })).toMatchObject({ verdict: "FALSZYWE", decisiveRecordIds: [register.id] });
});
