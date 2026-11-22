/** The primary language of a publisher-declared BCP 47 tag. */
export function sourceLanguageTag(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  try { return new Intl.Locale(value.trim()).language; } catch { return undefined; }
}

export function guessLang(text: string, hint?: string): string {
  const declared = sourceLanguageTag(hint);
  if (declared) return declared;
  const t = text.slice(0, 3000).toLowerCase();
  if (/[ąćęłńóśźż]/.test(t) || /\b(że|się|jest|nie|dla|oraz|przez)\b/.test(t)) return "pl";
  if (/[äöüß]/.test(t) || /\b(und|der|die|das|nicht|ist|mit|ein)\b/.test(t)) return "de";
  if (/[àâçéèêëîïôùûœ]/.test(t) || /\b(les|des|est|une|dans|pour)\b/.test(t)) return "fr";
  if (/[ñ¿¡]/.test(t) || /\b(los|las|que|una|para|con)\b/.test(t)) return "es";
  if (/[Ѐ-ӿ]/.test(t)) return /[іїєґ]/.test(t) ? "uk" : "ru";
  return "en";
}
