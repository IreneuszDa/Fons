// Split only at a new question clause, never at a list of names or alternatives.
// The original message remains available to the answer model to resolve pronouns.
const QUESTION_WORD = String.raw`(?:czy|kto|co|ile|ilu|kiedy|gdzie|skąd|dokąd|dlaczego|czemu|jak(?:i|a|ie|ich|im)?|któr(?:y|a|e|ym|ego)|od kiedy|do kiedy|w któr(?:ym|ej))`;
const NEXT_QUESTION = new RegExp(String.raw`(?:[?;]\s*(?:[ia]\s+)?|,?\s+(?:i|oraz|a)\s+|\n\s*(?:[-•]|\d+[.)])?\s*)(?=${QUESTION_WORD}(?!\p{L}))`, "iu");
const STARTS_QUESTION = new RegExp(String.raw`^(?:(?:hej|cześć|proszę|powiedz mi|sprawdź)[,!\s]+)*${QUESTION_WORD}(?!\p{L})`, "iu");
export const MAX_QUESTION_PARTS = 4;

export function separateQuestions(text?: string): string[] {
  if (!text || text.length > 2000) return [];
  const input = text.trim().replace(/^(?:[-•]|1[.)])\s*/u, "");
  if (!STARTS_QUESTION.test(input)) return [];
  const parts = input.split(NEXT_QUESTION).map(q => q.trim().replace(/[?;]+$/, "")).filter(Boolean);
  if (parts.length < 2 || parts.some(q => q.split(/\s+/u).length < 2)) return [];
  return parts.map(q => `${q}?`);
}
