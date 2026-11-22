import { detectInjection } from "./ports";

/** A suggested source is an unlinked noun phrase, displayed only after independent review. */
export function neededEvidencePhrase(text: string): string | undefined {
  const phrase = text.trim().replace(/[.]$/u, "").trimEnd();
  if (phrase.length < 6 || phrase.length > 220 || /[.!?;:\n\r<>@/]/u.test(phrase)) return;
  if (detectInjection(phrase, "quote").length) return;
  return phrase;
}
