/**
 * Lekki, zależny od języka „stemmer” do zapytań FTS5 i do lekkiego przeszeregowania leksykalnego.
 *
 * FTS5 nie ma polskiego stemmera, więc szukamy po prefiksie rdzenia. Stary sposób (ucinanie tokenu do
 * stałej długości) dawał rdzenie typu „joine*” dla angielskiego „joined”, które nie trafiały w „join”/„joins”.
 * Teraz:
 *  - język tekstu wykrywamy prostą heurystyką (polskie znaki, słowa funkcyjne PL/EN),
 *  - odcinamy znane końcówki fleksyjne danego języka (najdłuższa pasująca), pilnując minimalnej długości rdzenia,
 *  - tokeny krótkie (≤ 4 znaki: „NATO”, „UE”, „2024”) i tokeny z cyframi zostają w całości (dopasowanie dokładne).
 */

export type Lang = "pl" | "en";
/** Język tekstu; „mixed” = nie da się rozstrzygnąć (bez polskich znaków i bez wyraźnych słów funkcyjnych). */
export type TextLang = Lang | "mixed";

const PL_LETTERS = /[ąćęłńóśźż]/i;
const PL_FUNCTION = new Set(
  "i w we z ze na do od o u a ale lub czy to jest są był była było byli nie się że jak przez dla przy pod nad za po oraz już też który która które ten ta te roku".split(" "),
);
const EN_FUNCTION = new Set(
  "the a an of in on to is are was were be been and or for with by at from that this it as not has have had joined did does".split(" "),
);

/**
 * Język tekstu: „pl”, gdy są polskie litery albo przeważają polskie słowa funkcyjne; „en”, gdy są co najmniej
 * dwa angielskie słowa funkcyjne i przeważają; w pozostałych przypadkach „mixed” (stosujemy oba zestawy końcówek).
 */
export function detectLang(text: string): TextLang {
  if (PL_LETTERS.test(text)) return "pl";
  const toks = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let pl = 0;
  let en = 0;
  for (const t of toks) {
    if (PL_FUNCTION.has(t)) pl++;
    if (EN_FUNCTION.has(t)) en++;
  }
  if (pl > en) return "pl";
  if (en >= 2 && en > pl) return "en";
  return "mixed";
}

/** Rdzenie tokenu dla języka tekstu (dla „mixed” — rdzeń polski i angielski, bez duplikatów). */
export function stemsFor(token: string, lang: TextLang): (string | null)[] {
  if (lang !== "mixed") return [stemToken(token, lang)];
  const pl = stemToken(token, "pl");
  const en = stemToken(token, "en");
  return pl === en ? [pl] : [pl, en];
}

/** Minimalna długość rdzenia (w znakach) po odcięciu końcówki. */
export const MIN_STEM = { pl: 4, en: 4 } as const;
/** Tokeny do tej długości zostają w całości. */
export const KEEP_WHOLE_MAX = 4;

// Najdłuższe najpierw (sortowane przy starcie). Końcówki rzeczowników, przymiotników i czasowników.
const PL_SUFFIXES = [
  "owaniami", "owaniach", "owaniem", "owania", "owanie", "owaniu", "ościami", "ościach", "ością", "ości", "ość",
  "owała", "owało", "owali", "owały", "ować", "ował", "uje", "ują", "ując", "ujący", "ująca", "ujące",
  "iami", "iach", "iego", "iemu", "ich", "ych", "ymi", "imi", "ami", "ach", "owi", "owie", "ów", "om", "ego", "emu",
  "owej", "owego", "owemu", "owych", "owym", "owymi", "owy", "owa", "owe", "ową", "iej", "iem", "iom",
  "ej", "ym", "im", "ie", "ia", "iu", "ią", "ię", "ii", "ji", "yła", "iła", "ała", "eła", "yło", "iło", "ało", "eło",
  "yli", "ili", "ali", "eli", "yły", "iły", "ały", "eły", "ła", "ło", "li", "ły", "ać", "ić", "yć", "eć", "ąć",
  "em", "a", "e", "i", "o", "u", "y", "ą", "ę", "ł",
].sort((a, b) => b.length - a.length);

const EN_SUFFIXES = [
  "ational", "izations", "ization", "ations", "ation", "ments", "ment", "ness", "ings", "ing", "ied", "ies",
  "ed", "es", "s", "ly",
].sort((a, b) => b.length - a.length);

/**
 * Rdzeń tokenu (małe litery) albo null, gdy token ma zostać w całości.
 * Gdy żadna końcówka nie pasuje, rdzeniem jest cały token (szukamy go potem jako prefiksu).
 */
export function stemToken(token: string, lang: Lang): string | null {
  const t = token.toLowerCase();
  if (/\p{N}/u.test(t)) return null;
  const chars = Array.from(t);
  if (chars.length <= KEEP_WHOLE_MAX) return null;
  const min = MIN_STEM[lang];
  const suffixes = lang === "en" ? EN_SUFFIXES : PL_SUFFIXES;
  for (const s of suffixes) {
    if (!t.endsWith(s)) continue;
    const stem = Array.from(t.slice(0, t.length - s.length));
    if (stem.length >= min) return stem.join("");
  }
  return t;
}

const PL_VOWELS = /[aąeęioóuy]/;

/**
 * Polskie „e ruchome”: rdzeń z odmiany („członk-”, „marszałk-”) nie jest prefiksem mianownika
 * („członek”, „marszałek”). Zwraca wariant z „e” przed ostatnią spółgłoską albo null.
 */
export function mobileEVariant(stem: string): string | null {
  const ch = Array.from(stem);
  if (ch.length < 4) return null;
  const last = ch[ch.length - 1]!;
  const prev = ch[ch.length - 2]!;
  if (!/[kcnłlr]/.test(last) || PL_VOWELS.test(prev)) return null;
  // Przymiotnikowe „-sk-”, „-ck-”, „-dzk-” („polsk-”, „niemieck-”) nie mają „e” ruchomego.
  if (last === "k" && /[scz]/.test(prev)) return null;
  return [...ch.slice(0, -1), "e", last].join("");
}

/** Złożenie polskich znaków (także ł) — do porównań w przeszeregowaniu. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();
}
