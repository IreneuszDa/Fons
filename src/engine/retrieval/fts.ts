/**
 * Budowanie bezpiecznych zapytań FTS5 z tekstu użytkownika.
 *
 * Polska fleksja jest bogata, a FTS5 nie ma polskiego stemmera, więc używamy dopasowania prefiksowego
 * rdzenia wyznaczonego przez lekki stemmer zależny od języka (stem.ts): każdy dłuższy token daje DWA terminy —
 * pełny token (dokładnie) i rdzeń z `*` („sankcjami” → "sankcjami" OR "sankcj"*; „joined” → "joined" OR "join"*).
 * Tokeny krótkie (≤ 4 znaki) i z cyframi zostają w całości.
 *
 * BEZPIECZEŃSTWO: tekst użytkownika nigdy nie trafia do MATCH w surowej postaci. Tokenizujemy go
 * na ciągi liter/cyfr (wszystko inne — cudzysłowy, nawiasy, `*`, `^`, `:`, `-` — jest separatorem),
 * a każdy token jest ujęty w cudzysłów (z podwajaniem cudzysłowów dla pewności). Operatory FTS5
 * (NEAR, AND, OR, NOT, filtry kolumn) po tokenizacji są zwykłymi, zacytowanymi słowami.
 */

import { detectLang, mobileEVariant, stemToken, stemsFor, type Lang, type TextLang } from "./stem";

const PL_ONLY = /[ąćęłńóśźż]/;

const PL_STOPWORDS = `
a aby ach acz aczkolwiek aj albo ale ależ ani aż bardziej bardzo bez bo bowiem by byc byli bylo byly byl była było były będzie będą być
cala cale caly cała całe cały ci cie ciebie co cokolwiek coś czasami czasem czemu czy czyli daleko dla dlaczego dlatego do dobrze dokąd dość dużo dwa dwaj dwie dwoje dzisiaj dziś
gdy gdyby gdyż gdzie gdziekolwiek gdzieś go i ich ile im inna inne inny innych iż ja ją jak jakaś jakby jaki jakichś jakie jakiś jakiż jakkolwiek jako jakoś je jeden jedna jedno jednak jednakże jego jej jemu jest jestem jeszcze jeśli jeżeli już ją
każdy kiedy kilka kimś kto ktokolwiek ktoś która które którego której który których którym którzy lat lecz lub ma mają mało mam mi mimo między mną mnie mogą moi moim moja moje może możliwe można mój mu musi my na nad nam nami nas nasi nasz nasza nasze naszego naszych natomiast natychmiast nawet nią nic nich nie niech niego niej niemu nigdy nim nimi niż no o obok od około on ona one oni ono oraz oto owszem pan pana pani po pod podczas pomimo ponad ponieważ powinien powinna powinni powinno poza prawie przecież przed przede przedtem przez przy raz razie roku również sam sama są się skąd sobie sobą sposób swoje ta tak taka taki takie także tam te tego tej temu ten teraz też to tobą tobie toteż totobą trzeba tu tutaj twoi twoim twoja twoje twym twój ty tych tylko tym u w wam wami was wasz wasza wasze we według wiele wielu więc więcej wszyscy wszystkich wszystkie wszystkim wszystko wtedy wy właśnie z za zapewne zawsze ze zł znowu znów zostal został została zostało zostały zostali żaden żadna żadne żadnych że żeby
jest sa nie tak ze sie oraz tez
`
  .split(/\s+/)
  .filter(Boolean);

const EN_STOPWORDS = `
a about above after again against all am an and any are aren as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
also been get got however may might must shall via
`
  .split(/\s+/)
  .filter(Boolean);

export const STOPWORDS: ReadonlySet<string> = new Set([...PL_STOPWORDS, ...EN_STOPWORDS]);

/** Maksymalna liczba terminów w jednym zapytaniu MATCH (ochrona przed bardzo długimi wejściami). */
export const MAX_QUERY_TERMS = 64;

const PII_PLACEHOLDER = /\[(?:PESEL|TELEFON|EMAIL|IBAN|KARTA|DOWOD)\]/gi;

/** Etykiety po maskowaniu danych nie są treścią do wyszukania. */
export function stripPiiPlaceholders(text: string): string {
  return text.replace(PII_PLACEHOLDER, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** Dzieli tekst na tokeny (litery i cyfry Unicode), małymi literami. Bez usuwania stopwords. */
export function rawTokens(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Tokeny znaczące: bez stopwords, min. 2 znaki, bez duplikatów (kolejność pierwszego wystąpienia). */
export function contentTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of rawTokens(stripPiiPlaceholders(text))) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Długość prefiksu (w znakach) dla tokenu albo null, gdy dopasowanie ma być dokładne.
 * Wyznaczana przez stemmer zależny od języka (stem.ts); zostawiona dla zgodności i testów.
 */
export function prefixLength(token: string, lang: Lang = "pl"): number | null {
  const stem = stemToken(token, lang);
  return stem === null ? null : Array.from(stem).length;
}

function quote(body: string): string {
  return `"${body.replace(/"/g, '""')}"`;
}

/** Najważniejszy termin FTS5 dla tokenu: rdzeń z `*` albo cały token (dokładnie). */
export function ftsTerm(token: string, lang: Lang = "pl"): string {
  const stem = stemToken(token, lang);
  return stem === null ? quote(token) : `${quote(stem)}*`;
}

/** Terminy FTS5 dla tokenu: rdzeń (rdzenie) z `*` + pełny token (dokładnie), gdy rdzeń jest krótszy od tokenu. */
export function ftsTerms(token: string, lang: TextLang = "pl"): string[] {
  const stems = stemsFor(token, lang);
  if (stems.some((s) => s === null)) return [quote(token)];
  const out = (stems as string[]).map((s) => `${quote(s)}*`);
  if (!stems.includes(token)) out.push(quote(token));
  if (lang !== "en") {
    const pl = stems[0] as string;
    const v = pl !== token ? mobileEVariant(pl) : null;
    if (v) out.push(`${quote(v)}*`);
  }
  return out;
}

/**
 * Buduje zapytanie MATCH (terminy połączone OR) z jednego lub wielu tekstów.
 * Terminy z różnych tekstów są przeplatane (round-robin), żeby limit MAX_QUERY_TERMS
 * nie wyciął zapytań dodatkowych (np. tłumaczenia EN). Zwraca null, gdy nie ma żadnego znaczącego tokenu.
 */
export function buildMatchQuery(texts: string[], maxTerms: number = MAX_QUERY_TERMS): string | null {
  const terms = matchTerms(texts, maxTerms);
  return terms.length > 0 ? terms.join(" OR ") : null;
}

/** Terminy FTS5 (już zacytowane) z wielu tekstów, przeplatane round-robin, bez duplikatów. */
export function matchTerms(texts: string[], maxTerms: number = MAX_QUERY_TERMS): string[] {
  const lists = texts
    .map((t) => {
      const lang = detectLang(t);
      return contentTokens(t).map((tok) => ftsTerms(tok, PL_ONLY.test(tok) ? "pl" : lang));
    })
    .filter((l) => l.length > 0);
  if (lists.length === 0) return [];
  const used = new Set<string>();
  const terms: string[] = [];
  const idx = lists.map(() => 0);
  let progressed = true;
  while (terms.length < maxTerms && progressed) {
    progressed = false;
    for (let i = 0; i < lists.length && terms.length < maxTerms; i++) {
      const list = lists[i]!;
      while (idx[i]! < list.length) {
        const group = list[idx[i]!]!;
        idx[i] = idx[i]! + 1;
        const fresh = group.filter((term) => !used.has(term));
        if (fresh.length === 0) continue;
        for (const term of fresh) {
          if (terms.length >= maxTerms) break;
          used.add(term);
          terms.push(term);
        }
        progressed = true;
        break;
      }
    }
  }
  return terms;
}
