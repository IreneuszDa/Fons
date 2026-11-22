import { expect, it } from "vitest";
import type { Claim, EvidenceAssessment } from "../../shared/contracts";
import { readCorpus } from "../../corpus/files";
import { buildEv } from "./evidence";
import { supportsMeasurement } from "./measurement-support";

it("compares a dated count with the recorded primary-source quote, including the unit, operator, year and geography", () => {
  const record = readCorpus().records.find(r => r.id === "sg-pl:8868605f417d")!;
  const text = "W 2023 roku odnotowano ponad 26 tysięcy prób nielegalnego przekroczenia granicy polsko-białoruskiej.";
  const claim: Claim = { id: "c1", temporal: { kind: "jednorazowe", date: "2023" }, type: "fakt", isMain: true, text, assertedAspect: "liczba", inputOverlap: 1 };
  const a: EvidenceAssessment = { claimId: claim.id, recordId: record.id, relation: "WSPIERA", verifier: "zgoda", aspect: "liczba", period: record.period, quote: record.text, quoteVerified: true, quoteMatchScore: 1, decisive: true };
  const evidence = buildEv(a, record, true);
  const now = new Date(record.fetchedAt);
  expect(supportsMeasurement(claim, evidence, now)).toBe(true);
  for (const changed of [text.replace("prób", "osób"), text.replace("ponad", "poniżej"), text.replace("26", "27"), text.replace("białoruskiej", "ukraińskiej"), text.replace("2023", "2024")]) {
    expect(supportsMeasurement({ ...claim, text: changed }, evidence, now)).toBe(false);
  }
  expect(supportsMeasurement(claim, buildEv({ ...a, verifier: "niepewne" }, record, true), now)).toBe(false);
});

it("uses the observed current NBP rate only for its named metric and verification date", () => {
  const record = readCorpus().records.find(r => r.sourceId === "nbp-rates" && r.topics.includes("series-latest"))!;
  const value = record.text.match(/(\d+(?:,\d+)?)%/u)![1];
  const text = `Stopa referencyjna NBP wynosi ${value} procent.`;
  const claim: Claim = { id: "c1", temporal: { kind: "stan" }, type: "fakt", isMain: true, text, assertedAspect: "liczba", inputOverlap: 1 };
  const a: EvidenceAssessment = { claimId: claim.id, recordId: record.id, relation: "WSPIERA", verifier: "zgoda", aspect: "liczba", period: record.period, quote: record.text, quoteVerified: true, quoteMatchScore: 1, decisive: true };
  const e = buildEv(a, record, true);
  const now = new Date(record.fetchedAt);
  expect(supportsMeasurement(claim, e, now)).toBe(true);
  expect(supportsMeasurement({ ...claim, text: text.replace("referencyjna", "lombardowa") }, e, now)).toBe(false);
  expect(supportsMeasurement(claim, e, new Date(now.getTime() + 86_400_000))).toBe(false);
});
