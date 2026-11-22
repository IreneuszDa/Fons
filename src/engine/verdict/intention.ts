import type { Relation } from "../../shared/contracts";

// A marker detects candidate claims generously. Only a small declarative grammar below can resolve one.
const PRESENT_INTENTION = /(?<!\p{L})(?:planuj(?:e|ą|emy|ecie|esz|ę)|zamierz(?:a|ają|amy|acie|asz|am)|chc(?:e|ą|emy|ecie|esz|ę)|(?:ma|mają|mamy)\s+(?:w\s+planach|zamiar|plany?)|(?:przymierza|przymierzają)\s+się\s+do|(?:plans?|intends?|wants?|aims?)\s+to|(?:has|have)\s+plans?\s+to)(?!\p{L})/iu;
const STATED_GOAL = /(?<!\p{L})(?:(?:celem|zamiarem)(?:\s+[\p{L}-]+){0,6}\s+(?:nie\s+)?jest|(?:jest|pozostaje)\s+(?:celem|zamiarem)|(?:dąży|dążą|dążymy)\s+do|(?:ma|mają)\s+na\s+celu|(?:goal|objective|intention|aim)\s+is|seeks?\s+to)(?!\p{L})/iu;
const ATTRIBUTED_MOTIVE = /(?<!\p{L})(?:(?:motywem|motywacją|planem)(?:\s+[\p{L}-]+){0,6}\s+(?:nie\s+)?jest|kieruj(?:e|ą)\s+się|(?:motive|motivation|plan)\s+is|is\s+motivated\s+by)(?!\p{L})/iu;

export function mentionsIntention(text: string): boolean {
  const wording = text.normalize("NFC");
  return PRESENT_INTENTION.test(wording) || STATED_GOAL.test(wording) || ATTRIBUTED_MOTIVE.test(wording);
}

interface Intention { actor: string; operator: string; action: string; negated: boolean }
const QUALIFIED = /(?:^|\s)(?:czy|jakoby|rzekomo|podobno|jeśli|jeżeli|gdyby|może|prawdopodobnie|if|whether|perhaps|allegedly|might|would)(?:\s|$)/iu;
const POLISH_ACTION = /(?:ć|[csz]j[aeęąi]|[nc]i[eaęu]|[nc]iem)$/u;

/** Match one whole assertion. An action and its object have to appear together within the scope of the intention. */
function declaredIntention(raw: string, question: boolean): Intention | undefined {
  const text = raw.normalize("NFC").toLowerCase().trim().replace(/^[„“"«]/u, "").replace(/[.”"»]+$/u, "")
    .replace(/\s+/gu, " ");
  const sentence = question ? text.replace(/^czy /u, "").replace(/\?$/u, "") : text;
  if (sentence.length > 300 || !/^[\p{L}\p{N} '-]+$/u.test(sentence) || QUALIFIED.test(sentence)) return;
  const nominal = /^(celem|zamiarem) ([\p{L}][\p{L} -]{0,85}?) (nie )?jest (.+)$/u.exec(sentence);
  const personal = /^([\p{L}][\p{L} -]{0,85}?) (nie )?(planuj(?:e|ą|emy)|zamierz(?:a|ają|amy)|chc(?:e|ą|emy)|dąż(?:y|ą|ymy) do|(?:ma|mają) (?:zamiar|na celu|w planach)) (.+)$/u.exec(sentence);
  const english = /^([\p{L}][\p{L}' -]{0,85}?) ((?:does|do) not )?(plan|intend|want|aim|seek)s? to (.+)$/u.exec(sentence);
  const enNominal = /^([\p{L}][\p{L}' -]{0,85}?)'s (goal|objective|intention|aim) is (not )?to (.+)$/u.exec(sentence);
  const m = nominal ?? personal ?? english ?? enNominal;
  if (!m) return;
  const actor = nominal ? m[2]! : m[1]!;
  const operator = nominal ? m[1]! : enNominal ? m[2]! : m[3]!;
  const negated = !!(nominal || enNominal ? m[3] : m[2]);
  const action = m[4]!;
  const words = action.split(" ");
  if (words.length < 2 || words.length > 18 || !words.slice(1).some(w => w.length >= 3)) return;
  if ((english || enNominal) && /^(?:the|an?|in|on|to|not|of|by|and|for)$/u.test(words[0]!)) return;
  if (!english && !enNominal && !POLISH_ACTION.test(words[0]!)) return;
  return { actor, operator, negated, action };
}

/** The verifier may propose a relation. The scoped actor, modality, action, object and polarity must agree with it. */
export function directlyStatesIntention(claimText: string, quote: string, relation: Relation): boolean {
  const claim = declaredIntention(claimText, true), evidence = declaredIntention(quote, false);
  if (!claim || !evidence || claim.actor !== evidence.actor || claim.operator !== evidence.operator || claim.action !== evidence.action) return false;
  return relation === (claim.negated === evidence.negated ? "WSPIERA" : "OBALA");
}
