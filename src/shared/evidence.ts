import type { CorpusRecord, EvidenceItem } from "./contracts";

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

export function passageText(text: string, kind: EvidenceItem["passageKind"]): string {
  if (kind === "structured_data") return `Odczyt z danych źródłowych: ${text}`;
  if (kind === "reviewed_claim") return `Teza oceniana przez wydawcę: ${text}`;
  return kind === "excerpt" ? `„${text}”` : `Fragment zapisanego rekordu: ${text}`;
}
