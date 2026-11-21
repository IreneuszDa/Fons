/**
 * PII masking (PLAN §6 "Prywatność") and user-id pseudonymisation.
 *
 * Masks: PESEL (checksum + month validated; also written 4-4-3 / 6-5 with spaces or dashes), Polish phone numbers
 * (3-3-3, 3-2-2-2, 2-3-2-2, „(22) 123 45 67”, unbroken), e-mail, IBAN (PL and generic, mod-97; also a bare 26-digit
 * Polish NRB), payment cards (Luhn), Polish ID-card numbers (series + number, checksum 7-3-1).
 * Context distinguishes contact details and personal identifiers from measurements,
 * public reference numbers and other figures in a claim. Names stay in the text.
 */
import { createHmac } from "node:crypto";
import { loadConfig } from "../server/config";

export type PiiKind = "PESEL" | "TELEFON" | "EMAIL" | "IBAN" | "KARTA" | "DOWOD";

// ─────────────────────────── validators ───────────────────────────

export function isValidPesel(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * w[i]!;
  const check = (10 - (sum % 10)) % 10;
  if (check !== Number(digits[10])) return false;
  // Month field encodes the century: 01–12 (1900), 21–32 (2000), 41–52, 61–72, 81–92.
  const mm = Number(digits.slice(2, 4)) % 20;
  const dd = Number(digits.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Polish ID card (dowód osobisty): 3 letters + 6 digits, the first digit is the check digit (weights 7,3,1,7,3,1,7,3). */
export function isValidIdCard(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{3}\d{6}$/.test(s)) return false;
  const vals = [...s].map((ch) => (ch >= "A" && ch <= "Z" ? ch.charCodeAt(0) - 55 : Number(ch)));
  const w = [7, 3, 1, 7, 3, 1, 7, 3];
  const rest = [...vals.slice(0, 3), ...vals.slice(4)];
  const sum = rest.reduce((acc, v, i) => acc + v * w[i]!, 0);
  return sum % 10 === vals[3];
}

/** Generic IBAN check (ISO 13616 mod-97). Input: letters/digits only, any case. */
export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("PL") && iban.length !== 28) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// ─────────────────────────── patterns ───────────────────────────

const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/gu;
// Generic IBAN with optional single spaces in groups of 4.
const IBAN_RE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?(?![A-Za-z0-9])/g;
// Polish NRB (26 digits), commonly written "12 1234 5678 9012 3456 7890 1234".
const NRB_RE = /(?<![\d])\d{2}(?:[ -]?\d{4}){6}(?!\d)/g;
// 13–19 digits, optionally in groups separated by single spaces/dashes.
const CARD_RE = /(?<![\d])\d(?:[ -]?\d){12,18}(?!\d)/g;
const PESEL_RE = /(?<!\d)\d{11}(?!\d)/g;
// PESEL written in groups (4-4-3 or 6-5) with single spaces or dashes; validated after stripping separators.
const PESEL_GROUPED_RE = /(?<!\d[\p{Zs}-]?)(?:\d{4}[\p{Zs}-]\d{4}[\p{Zs}-]\d{3}|\d{6}[\p{Zs}-]\d{5})(?![\p{Zs}-]?\d)/gu;
// Polish ID card: series + 6 digits. Lowercase needs an explicit ID-card label.
const ID_CARD_RE = /(?<![\p{L}\p{N}])[A-Za-z]{3}[\p{Zs}-]?\d{6}(?![\p{L}\p{N}])/gu;
// +48 / 0048 optional; 9 digits as 3-3-3, 2-3-2-2, 3-2-2-2, "(22) 123 45 67" or unbroken.
const PHONE_RE =
  /(?<![\p{L}\p{N}+])(\(?(?:\+|00)48\)?[\p{Zs}-]?)?(\d{3}[\p{Zs}-]\d{3}[\p{Zs}-]\d{3}|\d{2}[\p{Zs}-]\d{3}[\p{Zs}-]\d{2}[\p{Zs}-]\d{2}|\d{3}[\p{Zs}-]\d{2}[\p{Zs}-]\d{2}[\p{Zs}-]\d{2}|\(\d{2}\)[\p{Zs}-]?\d{3}[\p{Zs}-]?\d{2}[\p{Zs}-]?\d{2}|\d{9})(?![\p{L}\p{N}])/gu;

const MOBILE_PREFIXES = new Set(["45", "50", "51", "53", "57", "60", "66", "69", "72", "73", "78", "79", "88"]);
const AREA_CODES = new Set(
  "12 13 14 15 16 17 18 22 23 24 25 29 32 33 34 41 42 43 44 46 48 52 54 55 56 58 59 61 62 63 65 67 68 71 74 75 76 77 81 82 83 84 85 86 87 89 91 94 95".split(
    " ",
  ),
);
const PUBLIC_NUMBER_BEFORE = /(?<![\p{L}\p{N}])(?:krs|regon|celex|doi|isbn|issn|sygnatur\p{L}*|(?:nr\.?|numer)\s+(?:sprawy|druku|projektu|uchwa[łl]y|aktu)|(?:bud[żz]et|kwot|koszt|przych[óo]d|doch[óo]d|warto[śs][ćc]|liczb)\p{L}*(?:\s+(?:wynosi|wynios[łl]\p{L}*|to))?)[\p{Zs}\t:=]*$/iu;
const PUBLIC_UNITS = [
  String.raw`z[łl]|pln|eur|euro|usd|dolar\p{L}*|rubl\p{L}*|hrywn\p{L}*`,
  String.raw`km|m²|km²|kg|ton\p{L}*|szt\.?|mln|ty[sś]\.?|mld|roku|r\.`,
  String.raw`os[óo]b|ludzi|mieszka[ńn]c\p{L}*|ludno[śs][ćc]\p{L}*|g[łl]os\p{L}*`,
  String.raw`przypadk\p{L}*|zg[łl]osze\p{L}*|wniosk\p{L}*|ods[łl]on\p{L}*|bajt\p{L}*|wy[śs]wietle\p{L}*|egzemplarz\p{L}*|zaka[żz]e\p{L}*|dawk\p{L}*`,
].join("|");
const PUBLIC_UNIT_AFTER = new RegExp(String.raw`^[\p{Zs}\t]*(?:[%‰$€]|(?:${PUBLIC_UNITS})(?![\p{L}\p{N}]))`, "iu");
const PHONE_LABEL = /(?<![\p{L}\p{N}])(?:(?:nr\.?|numer)\s+(?:telefonu|tel\.?)|telefon\p{L}*|tel\.?|(?:zadzwo[ńn]|oddzwo[ńn])(?:\s+pod(?:\s+numer)?)?)[\p{Zs}\t:]*(?:to[\p{Zs}\t]+)?$/iu;
const ID_CARD_LABEL = /(?<![\p{L}\p{N}])(?:dow[óo]d|dowodu)(?:\s+osobist\p{L}*)?(?:\s+(?:numer|nr\.?))?[\p{Zs}\t:]*(?:to[\p{Zs}\t]+)?$/iu;
const PESEL_LABEL = /(?<![\p{L}\p{N}])PESEL[\p{Zs}\t:]*(?:to[\p{Zs}\t]+)?$/iu;
const PAYMENT_CARD_LABEL = /(?<![\p{L}\p{N}])(?:karta|karty)(?:\s+(?:płatnicz\p{L}*|kredytow\p{L}*|debetow\p{L}*))?(?:\s+(?:numer|nr\.?))?[\p{Zs}\t:]*(?:to[\p{Zs}\t]+)?$/iu;

function looksLikePublicNumber(whole: string, offset: number, length: number, label: RegExp): boolean {
  const before = whole.slice(Math.max(0, offset - 80), offset);
  if (label.test(before)) return false;
  return PUBLIC_NUMBER_BEFORE.test(before) || PUBLIC_UNIT_AFTER.test(whole.slice(offset + length, offset + length + 36));
}

function phoneLooksReal(body: string): boolean {
  body = body.replace(/\p{Zs}/gu, " ");
  const digits = body.replace(/[ ()-]/g, "");
  const first2 = digits.slice(0, 2);
  // "(22) 123 45 67": parenthesised area code
  if (body.startsWith("(")) return AREA_CODES.has(first2);
  // 3-2-2-2 is the common way of writing mobile numbers ("601 23 45 67")
  if (/^\d{3}[ -]\d{2}[ -]\d{2}[ -]\d{2}$/.test(body)) return MOBILE_PREFIXES.has(first2);
  if (/^\d{3} \d{3} \d{3}$/.test(body) || /^\d{9}$/.test(body) || /^\d{3}-\d{3}-\d{3}$/.test(body)) {
    // 3-3-3 also looks like a thousands-grouped amount: only accept mobile prefixes
    // (or a landline area code when written without spaces / with dashes).
    if (MOBILE_PREFIXES.has(first2)) return true;
    return !body.includes(" ") && AREA_CODES.has(first2);
  }
  // 2-3-2-2 is the landline layout
  return AREA_CODES.has(first2) || MOBILE_PREFIXES.has(first2);
}

/**
 * Masks personal data. Order matters: e-mail → IBAN/NRB → card → PESEL → phone,
 * so that longer structured numbers are consumed before the shorter patterns.
 */
export function maskPii(text: string): { text: string; masked: boolean; kinds: string[] } {
  const kinds = new Set<PiiKind>();
  let out = text;

  out = out.replace(EMAIL_RE, () => {
    kinds.add("EMAIL");
    return "[EMAIL]";
  });

  out = out.replace(IBAN_RE, (m) => {
    if (!ibanValid(m)) return m;
    kinds.add("IBAN");
    return "[IBAN]";
  });

  out = out.replace(NRB_RE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (!ibanValid("PL" + digits)) return m;
    kinds.add("IBAN");
    return "[IBAN]";
  });

  out = out.replace(CARD_RE, (m, offset: number, whole: string) => {
    const digits = m.replace(/[ -]/g, "");
    // An 11-digit run is a PESEL candidate; cards are 13–19 digits.
    if (!luhnValid(digits) || looksLikePublicNumber(whole, offset, m.length, PAYMENT_CARD_LABEL)) return m;
    kinds.add("KARTA");
    return "[KARTA]";
  });

  out = out.replace(PESEL_RE, (m, offset: number, whole: string) => {
    if (!isValidPesel(m) || looksLikePublicNumber(whole, offset, m.length, PESEL_LABEL)) return m;
    kinds.add("PESEL");
    return "[PESEL]";
  });

  out = out.replace(PESEL_GROUPED_RE, (m, offset: number, whole: string) => {
    if (!isValidPesel(m.replace(/[\p{Zs}-]/gu, "")) || looksLikePublicNumber(whole, offset, m.length, PESEL_LABEL)) return m;
    kinds.add("PESEL");
    return "[PESEL]";
  });

  out = out.replace(ID_CARD_RE, (m, offset: number, whole: string) => {
    const series = m.slice(0, 3);
    const labeled = ID_CARD_LABEL.test(whole.slice(Math.max(0, offset - 80), offset));
    if ((!labeled && series !== series.toUpperCase()) || !isValidIdCard(m)) return m;
    if (!labeled && looksLikePublicNumber(whole, offset, m.length, ID_CARD_LABEL)) return m;
    kinds.add("DOWOD");
    return "[DOWOD]";
  });

  out = out.replace(PHONE_RE, (m, prefix: string | undefined, body: string, offset: number, whole: string) => {
    const labeled = PHONE_LABEL.test(whole.slice(Math.max(0, offset - 80), offset));
    if (!prefix && !labeled && (!phoneLooksReal(body) || looksLikePublicNumber(whole, offset, m.length, PHONE_LABEL))) return m;
    kinds.add("TELEFON");
    return "[TELEFON]";
  });

  return { text: out, masked: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Pseudonymous, stable user identifier: HMAC-SHA256(rawId) keyed with the
 * USER_ID_PEPPER (separate from other secrets), hex, 32 chars.
 * `pepper` override exists for tests only.
 */
export function pseudonymize(rawId: string, pepper?: string): string {
  const key = pepper ?? loadConfig().userIdPepper;
  return createHmac("sha256", key).update(rawId, "utf8").digest("hex").slice(0, 32);
}
