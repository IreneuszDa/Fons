import type { ClaimVerdict, CorpusRecord, EvidenceItem, Relation } from "./contracts";

/** The first two identifiers come from an actual opposed pair in the verdict rules. */
export function prioritizeConflictEvidence<T extends { recordId: string }>(items: T[], conflict: ClaimVerdict["conflicting"]): T[] {
  if (!conflict) return items;
  const firstOnSide = (ids: string[]) => {
    for (const id of ids) {
      const item = items.find(e => e.recordId === id);
      if (item) return item;
    }
  };
  const supporting = firstOnSide(conflict.supporting);
  const refuting = firstOnSide(conflict.refuting);
  if (!supporting || !refuting) return items;
  return [supporting, refuting, ...items.filter(e => e.recordId !== supporting.recordId && e.recordId !== refuting.recordId)];
}

export function passageKind(record: CorpusRecord, passage: string): NonNullable<EvidenceItem["passageKind"]> {
  if (record.topics.includes("generated-from-data") || (record.origin === "live_snapshot" && record.topics.includes("official-channel"))) {
    return "structured_data";
  }
  if (record.role === "stala_rola" && record.claimReviewed) {
    if (record.claimReviewed.includes(passage)) return "reviewed_claim";
    // Some feeds join the reviewed statement and the publisher's assessment into one record.
    const start = record.text.indexOf(passage);
    if (record.text.startsWith(record.claimReviewed + "\n") && start >= 0 &&
      start < record.claimReviewed.length && start + passage.length > record.claimReviewed.length) return "structured_data";
  }
  return "excerpt";
}

/** A ClaimReview rating applies to the statement, while a quotation has its own speaker. */
export function passageAssessment(record: CorpusRecord, quote: string, proposed: Relation): Pick<EvidenceItem, "passageKind" | "relation" | "group"> {
  const kind = passageKind(record, quote);
  const relation = record.role === "stala_rola" && kind !== "excerpt" ? "INNY_KONTEKST" : proposed;
  return {
    passageKind: kind,
    relation,
    group: relation === "OBALA" ? "obalajace" : relation === "WSPIERA" ? "wspierajace" : "kontekst",
  };
}

export function passageText(text: string, kind: EvidenceItem["passageKind"]): string {
  if (kind === "structured_data") return `Odczyt z danych źródłowych: ${text}`;
  if (kind === "reviewed_claim") return `Teza oceniana przez wydawcę: ${text}`;
  return kind === "excerpt" ? `„${text}”` : `Fragment zapisanego rekordu: ${text}`;
}
