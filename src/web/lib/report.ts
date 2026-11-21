/**
 * Pure presentation helpers for VerdictReport / ConversationReply (labels, grouping, tones).
 * Only `import type` from contracts, so zod never lands in the browser bundle.
 */
import type {
  Aspect,
  ClaimVerdict,
  ConversationReply,
  EvidenceItem,
  Relation,
  ReportWarning,
  SourceType,
  Strength,
  TechStatus,
  Verdict,
  VerdictReport,
  VerifierVote,
} from "../../shared/contracts";

/** Copy of VERDICT_LABEL_PL from contracts (value import would pull zod into the bundle). Kept in sync by a unit test. */
export const VERDICT_LABEL_PL: Record<Verdict, string> = {
  POTWIERDZONE: "Potwierdzone",
  FALSZYWE: "Fałszywe",
  WPROWADZAJACE: "Wprowadzające w błąd",
  BRAK_DOWODOW: "Brak wystarczających dowodów",
  NIE_PODLEGA: "Nie podlega weryfikacji",
};

/** Colour family per verdict: always paired with an icon and the text label (never colour alone). */
export type VerdictTone = "green" | "red" | "orange" | "blue" | "purple";

export const VERDICT_TONE: Record<Verdict, VerdictTone> = {
  POTWIERDZONE: "green",
  FALSZYWE: "red",
  WPROWADZAJACE: "orange",
  BRAK_DOWODOW: "blue",
  NIE_PODLEGA: "purple",
};

/** One plain-language sentence explaining what the verdict means. */
export const VERDICT_MEANING_PL: Record<Verdict, string> = {
  POTWIERDZONE: "Wiarygodne źródła potwierdzają tę informację.",
  FALSZYWE: "Wiarygodne źródła przeczą tej informacji.",
  WPROWADZAJACE: "Część informacji się zgadza, ale brakuje ważnego kontekstu albo jest nieaktualna.",
  BRAK_DOWODOW: "Nie znaleźliśmy wystarczających dowodów, żeby to rozstrzygnąć.",
  NIE_PODLEGA: "To opinia albo przewidywanie — nie da się tego sprawdzić w źródłach.",
};

export const STATUS_TITLE_PL: Record<TechStatus, string> = {
  OK: "Sprawdzenie zakończone",
  NIEPELNE: "Nie udało się dokończyć sprawdzenia",
  AWARIA: "Wystąpił problem techniczny",
  DOPRECYZUJ: "Potrzebuję więcej szczegółów",
  POZA_ZAKRESEM: "Tego nie sprawdzam",
};

export const STATUS_HINT_PL: Record<TechStatus, string> = {
  OK: "",
  NIEPELNE: "To problem techniczny, a nie ocena informacji. Spróbuj ponownie za kilka minut.",
  AWARIA: "To problem techniczny, a nie ocena informacji. Spróbuj ponownie za chwilę.",
  DOPRECYZUJ: "Napisz dokładniej, co chcesz sprawdzić — kto, co, kiedy i gdzie.",
  POZA_ZAKRESEM: "Sprawdzam informacje o faktach: wiadomości, posty, artykuły i linki do nich.",
};

export const STRENGTH_PL: Record<Strength, string> = { slaba: "słaba", srednia: "średnia", mocna: "mocna" };

/** Ogólny opis poziomu — tylko dla raportów bez listy czynników (starsze raporty, brak werdyktu). */
export const STRENGTH_WHY_PL: Record<Strength, string> = {
  slaba: "Za mało pewnych dowodów, by mocno oprzeć na nich wynik. Traktuj go ostrożnie.",
  srednia: "Wynik opiera się na wiarygodnym źródle, ale brakuje niezależnego potwierdzenia albo części dowodów nie dało się w pełni sprawdzić.",
  mocna: "Wiarygodne źródła mówią wprost to samo, a ich odczyt został sprawdzony.",
};

/** Kolor paska siły (kolor nigdy nie jest jedynym sygnałem — obok jest słowo i liczba). */
export const STRENGTH_VARIANT: Record<Strength, "success" | "warning" | "error"> = {
  mocna: "success",
  srednia: "warning",
  slaba: "error",
};

export const VERIFIER_PL: Record<VerifierVote, string> = {
  zgoda: "drugi model potwierdził cytaty",
  sprzeciw: "drugi model nie zgodził się z oceną",
  niepewne: "drugi model nie był pewny",
  brak: "nie sprawdzano drugim modelem",
};

export const SOURCE_TYPE_PL: Record<SourceType, string> = {
  pierwotne: "źródło urzędowe lub pierwotne",
  factcheck: "fact-check",
  analiza: "analiza",
};

export const RELATION_PL: Record<Relation, string> = {
  WSPIERA: "potwierdza",
  OBALA: "przeczy",
  CZESCIOWO: "potwierdza częściowo",
  INNY_KONTEKST: "dotyczy innego kontekstu",
  BEZ_ZWIAZKU: "bez związku",
};

export const ASPECT_PL: Record<Aspect, string> = {
  sedno: "sedno",
  czas: "czas",
  miejsce: "miejsce",
  liczba: "liczba",
  autorstwo: "autorstwo",
  zakres: "zakres",
};

export const WARNING_TITLE_PL: Record<ReportWarning["kind"], string> = {
  injection_detected: "Wykryliśmy próbę wpłynięcia na system — zignorowaliśmy ją",
  archival_material: "Materiał archiwalny",
  source_status: "Informacja o statusie źródła",
  incident_domain: "Ta strona była już notowana w bazie incydentów",
  incident_narrative: "Podobna narracja w bazie EUvsDisinfo",
  branch_unavailable: "Nie wszystkie źródła były dostępne",
  single_key_verifier: "Druga kontrola tym samym dostawcą",
  non_eea_processing: "Przetwarzanie poza Europejskim Obszarem Gospodarczym",
  image_limits: "Ograniczenia odczytu obrazu",
};

export type WarningSeverity = "warning" | "info";

export const WARNING_SEVERITY: Record<ReportWarning["kind"], WarningSeverity> = {
  injection_detected: "warning",
  archival_material: "warning",
  source_status: "info",
  incident_domain: "warning",
  incident_narrative: "info",
  branch_unavailable: "info",
  single_key_verifier: "info",
  non_eea_processing: "info",
  image_limits: "info",
};

export const EVIDENCE_GROUP_TITLE_PL: Record<EvidenceItem["group"], string> = {
  wspierajace: "Co potwierdza",
  obalajace: "Co przeczy",
  kontekst: "Kontekst",
};

export const EVIDENCE_GROUP_ORDER: EvidenceItem["group"][] = ["wspierajace", "obalajace", "kontekst"];

export function groupEvidence(items: EvidenceItem[]): Record<EvidenceItem["group"], EvidenceItem[]> {
  const out: Record<EvidenceItem["group"], EvidenceItem[]> = { wspierajace: [], obalajace: [], kontekst: [] };
  for (const it of items) (out[it.group] ?? out.kontekst).push(it);
  return out;
}

/** Evidence items on each side of a conflict, looked up by recordId in the claim's own evidence list. */
export function conflictSides(cv: ClaimVerdict): { supporting: EvidenceItem[]; refuting: EvidenceItem[] } | null {
  if (!cv.conflicting) return null;
  const byId = new Map(cv.evidence.map((e) => [e.recordId, e]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((e): e is EvidenceItem => !!e);
  const supporting = pick(cv.conflicting.supporting);
  const refuting = pick(cv.conflicting.refuting);
  if (supporting.length === 0 && refuting.length === 0) return null;
  return { supporting, refuting };
}

/** Claims paired with their verdicts, main claim first. */
export function claimRows(report: VerdictReport): { claimId: string; text: string; isMain: boolean; verdict: ClaimVerdict }[] {
  const rows = report.verdicts.map((v) => {
    const claim = report.claims.find((c) => c.id === v.claimId);
    return { claimId: v.claimId, text: claim?.text ?? "", isMain: claim?.isMain ?? false, verdict: v };
  });
  return rows.sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/** How the chat should render a reply. A technical status is never shown as a verdict. */
export type ReplyView = "verdict" | "answer" | "status" | "text";

/** An open question ("Kto…?", "Kiedy…?") is answered only with a verified quote — rendered by AnswerCard, not VerdictCard. */
export function isOpenQuestion(report: VerdictReport | undefined): boolean {
  return !!report && (report.inputMode === "question_open" || !!report.answer);
}

export function replyView(reply: ConversationReply): ReplyView {
  if (reply.report && reply.report.status === "OK" && (reply.kind === "answer" || (reply.kind === "verdict" && isOpenQuestion(reply.report)))) return "answer";
  if (reply.kind === "answer") return reply.report ? "status" : "text"; // an answer reply without OK report is a technical status
  if (reply.kind === "verdict" && reply.report && reply.report.status === "OK" && reply.report.mainVerdict) return "verdict";
  if (reply.kind === "status" || reply.kind === "rate_limited") return "status";
  if (reply.kind === "verdict") return "status"; // defensive: a "verdict" without a usable verdict is a technical status
  return "text";
}

export type StatusKey = Exclude<TechStatus, "OK"> | "RATE_LIMITED" | "GENERIC";

export function statusOf(reply: ConversationReply): StatusKey {
  if (reply.kind === "rate_limited") return "RATE_LIMITED";
  const s = reply.report?.status;
  return s && s !== "OK" ? s : "GENERIC";
}

export const STATUS_KEY_TITLE_PL: Record<StatusKey, string> = {
  NIEPELNE: STATUS_TITLE_PL.NIEPELNE,
  AWARIA: STATUS_TITLE_PL.AWARIA,
  DOPRECYZUJ: STATUS_TITLE_PL.DOPRECYZUJ,
  POZA_ZAKRESEM: STATUS_TITLE_PL.POZA_ZAKRESEM,
  RATE_LIMITED: "Za dużo wiadomości w krótkim czasie",
  GENERIC: "Nie mogę teraz tego sprawdzić",
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First sentence of a text (for short screen-reader announcements). */
export function firstSentence(text: string, max = 220): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?…])(\s|$)/.exec(t);
  const s = m?.[1] ?? t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * What the chat's polite live region says when a reply arrives — the outcome, not the interaction.
 * A technical status never sounds like a verdict.
 */
export function announcementFor(reply: ConversationReply): string {
  const view = replyView(reply);
  const r = reply.report;
  if (view === "verdict" && r?.mainVerdict) {
    const label = r.videoAnalysis ? "Ocena głównego twierdzenia z filmu" : "Wynik sprawdzenia";
    return `${label}: ${VERDICT_LABEL_PL[r.mainVerdict]}. ${firstSentence(r.summaryPl)}`.trim();
  }
  if (view === "answer" && r) {
    if (r.answer) return `Odpowiedź ze źródła: ${clip(r.answer.answerPl, 400)}`; // a quote may contain periods ("32.") — never split it
    return `Nie znalazłem odpowiedzi w źródłach. ${firstSentence(r.summaryPl)}`.trim();
  }
  if (view === "status") {
    const key = statusOf(reply);
    return `${STATUS_KEY_TITLE_PL[key]}. To nie jest ocena informacji.`;
  }
  return firstSentence(reply.textPl);
}

/** Archival warning for an answer: a report-level warning or an archival strength flag on any verdict. */
export function hasArchivalWarning(report: VerdictReport): boolean {
  return report.warnings.some((w) => w.kind === "archival_material") || report.verdicts.some((v) => v.strength.archivalWarning);
}
