/**
 * Okresy i daty dla reguł werdyktu (PLAN §4, reguły 3–5).
 *
 * Wszystko liczymy w UTC z dokładnością do dnia. Zakres `Range` jest domknięty: [start, end] w ms.
 * Nieznany / nieczytelny okres = `undefined`. Zasada ostrożności: nieznany okres traktujemy jako
 * NAKŁADAJĄCY SIĘ z każdym innym (lepiej pokazać sprzeczność niż ją ukryć) i nigdy jako „nowszy”.
 */

export interface Range {
  start: number;
  end: number;
}

// Preserve Polish diacritics: "pojawia się" is present; "pojawią się" is future.
const FUTURE_ACTION = /(?<!\p{L})(?:będ(?:ę|zie(?:my|cie|sz)?|ą)|zostan(?:ę|ą|ie(?:my|cie|sz)?)|wyśl(?:ę|ą|e(?:my|cie|sz)?)|pojawi(?:ę|ą|my|cie|sz)?\s+się|will|won['’]t|zamierz\p{L}*|planuj\p{L}*|plans? to|intends? to)(?!\p{L})/iu;
const INTENTION = /(?<!\p{L})(?:stanowisk\p{L}*|zapow(?:ied\p{L}*|iad\p{L}*)|deklar\p{L}*|ogłosi\p{L}*|oświadcz\p{L}*|obiecu\p{L}*|planuj\p{L}*|zamierz\p{L}*|postanowi\p{L}*|plans?|intentions?|pledges?|announc\p{L}*)(?!\p{L})/iu;

/** Detect a quote that describes only a future action or its announcement.
 * A separately stated observation in the same quote remains available to the reader and verifier. */
export function onlyAnnouncesFutureAction(claimText: string, quote: string): boolean {
  if (INTENTION.test(claimText) || FUTURE_ACTION.test(claimText)) return false;
  const parts = quote.normalize("NFC").split(/[.!?;:\n]+|,?\s+(?:ale|lecz|natomiast|but|and|i|oraz)\s+(?=nie\b|obecnie\b|aktualnie\b|wciąż\b|teraz\b|will\b|currently\b)/iu)
    .map(part => part.trim()).filter(Boolean);
  return parts.some(part => FUTURE_ACTION.test(part)) && parts.every(part => FUTURE_ACTION.test(part) || INTENTION.test(part));
}

const DAY_MS = 86_400_000;

function dayRange(y: number, m: number, d: number): Range | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const start = Date.UTC(y, m - 1, d);
  const check = new Date(start);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return undefined;
  return { start, end: start + DAY_MS - 1 };
}

function monthsRange(y: number, firstMonth: number, months: number): Range {
  const start = Date.UTC(y, firstMonth - 1, 1);
  const end = Date.UTC(y, firstMonth - 1 + months, 1) - 1;
  return { start, end };
}

function parseSingle(s: string): Range | undefined {
  let m: RegExpExecArray | null;
  // 2024-05-12, 2024-05-12T10:00:00Z, 2024-05-12 10:00
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s))) {
    return dayRange(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // 2024-05
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return undefined;
    return monthsRange(Number(m[1]), mo, 1);
  }
  // 2024-Q2, 2024Q2, 2024 Q2, Q2 2024, Q2-2024
  if ((m = /^(\d{4})[\s-]?Q([1-4])$/i.exec(s))) return monthsRange(Number(m[1]), (Number(m[2]) - 1) * 3 + 1, 3);
  if ((m = /^Q([1-4])[\s-]?(\d{4})$/i.exec(s))) return monthsRange(Number(m[2]), (Number(m[1]) - 1) * 3 + 1, 3);
  // 2024-H1, 2024H2, H1 2024
  if ((m = /^(\d{4})[\s-]?H([12])$/i.exec(s))) return monthsRange(Number(m[1]), m[2] === "1" ? 1 : 7, 6);
  if ((m = /^H([12])[\s-]?(\d{4})$/i.exec(s))) return monthsRange(Number(m[2]), m[1] === "1" ? 1 : 7, 6);
  // 2024
  if ((m = /^(\d{4})$/.exec(s))) return monthsRange(Number(m[1]), 1, 12);
  return undefined;
}

/**
 * Parsuje okres: rok, półrocze, kwartał, miesiąc, dzień, pełną datę ISO albo zakres
 * („2023-2024”, „2023–2025”, „2024-01-01/2024-06-30”, „2024-Q1..2024-Q3”).
 * Zwraca `undefined`, gdy nie umie (wtedy okres jest nieznany).
 */
export function parsePeriod(raw: string | null | undefined): Range | undefined {
  if (raw == null) return undefined;
  const s = raw.trim();
  if (s === "") return undefined;
  const single = parseSingle(s);
  if (single) return single;

  const yy = /^(\d{4})\s*[-–—]\s*(\d{4})$/.exec(s);
  if (yy) return joinRange(parseSingle(yy[1]!), parseSingle(yy[2]!));

  for (const sep of ["/", "..", "–", "—", " - "]) {
    const idx = s.indexOf(sep);
    if (idx > 0) {
      const r = joinRange(parseSingle(s.slice(0, idx).trim()), parseSingle(s.slice(idx + sep.length).trim()));
      if (r) return r;
    }
  }
  return undefined;
}

function joinRange(a: Range | undefined, b: Range | undefined): Range | undefined {
  if (!a || !b || a.start > b.end) return undefined;
  return { start: a.start, end: b.end };
}

/** Rok z daty publikacji jako zakres (zapasowy okres rekordu). */
export function yearRangeOf(iso: string | null | undefined): Range | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})/.exec(iso.trim());
  return m ? monthsRange(Number(m[1]), 1, 12) : undefined;
}

/** Nieznany okres nakłada się z każdym (zasada ostrożności). */
export function overlaps(a: Range | undefined, b: Range | undefined): boolean {
  if (!a || !b) return true;
  return a.start <= b.end && b.start <= a.end;
}

/** `a` w całości później niż `b`. Nieznany okres nigdy nie jest „później”. */
export function strictlyAfter(a: Range | undefined, b: Range | undefined): boolean {
  if (!a || !b) return false;
  return a.start > b.end;
}

/** Ta sama chwila minus `months` miesięcy (UTC). */
export function monthsBefore(now: Date, months: number): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - months,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  );
}

const MONTH_STEMS: [RegExp, number][] = [
  [/^(?:stycz|january)/, 1],
  [/^(?:lut|february)/, 2],
  [/^(?:mar|march)/, 3],
  [/^(?:kwie|april)/, 4],
  [/^(?:maj|may)/, 5],
  [/^(?:czerw|june)/, 6],
  [/^(?:lip|july)/, 7],
  [/^(?:sierp|august)/, 8],
  [/^(?:wrze|september)/, 9],
  [/^(?:pazdziern|october)/, 10],
  [/^(?:listopad|november)/, 11],
  [/^(?:grud|december)/, 12],
];
const MONTH_WORD_RE =
  "(stycz\\w*|lut\\w*|mar(?:zec|ca|cu)|kwie\\w*|maj[au]?|czerw(?:iec|ca|cu)|lip(?:iec|ca|cu)|sierp\\w*|wrze\\w*|pazdziern\\w*|listopad\\w*|grud\\w*|" +
  "january|february|march|april|may|june|july|august|september|october|november|december)";

function monthOf(word: string): number | undefined {
  return MONTH_STEMS.find(([re]) => re.test(word))?.[1];
}

function foldDate(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();
}

/**
 * Czy tekst (zweryfikowany cytat) wprost mówi o czasie zdarzenia lub późniejszym: pełna data albo miesiąc z rokiem,
 * których koniec przypada w dniu zdarzenia lub później, albo sam rok PÓŹNIEJSZY niż rok początku zdarzenia.
 * Przykład: cytat „przedłużone do 30 marca 2027 r.” mówi o listopadzie 2026, choć opublikowano go w październiku.
 * Sam rok zdarzenia nie wystarcza (za mało, by wiedzieć, że chodzi o czas po zdarzeniu).
 */
export function textCoversDate(text: string, event: Range): boolean {
  const t = foldDate(text);
  const eventYear = new Date(event.start).getUTCFullYear();
  const reaches = (r: Range | undefined) => !!r && r.end >= event.start;
  let rest = t;
  const take = (re: RegExp, f: (m: RegExpExecArray) => Range | undefined): boolean => {
    let hit = false;
    rest = rest.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      if (reaches(f(m))) hit = true;
      return " ";
    });
    return hit;
  };
  const dayMonthYear = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_WORD_RE}\\s+((?:19|20)\\d{2})\\b`, "g");
  const numeric = /\b(\d{1,2})[./](\d{1,2})[./]((?:19|20)\d{2})\b/g;
  const iso = /\b((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?\b/g;
  const monthYear = new RegExp(`\\b${MONTH_WORD_RE}\\s+((?:19|20)\\d{2})\\b`, "g");
  let covered = false;
  covered = take(dayMonthYear, (m) => { const mo = monthOf(m[2]!); return mo ? dayRange(Number(m[3]), mo, Number(m[1])) : undefined; }) || covered;
  covered = take(numeric, (m) => dayRange(Number(m[3]), Number(m[2]), Number(m[1]))) || covered;
  covered = take(iso, (m) => (m[3] ? dayRange(Number(m[1]), Number(m[2]), Number(m[3])) : Number(m[2]) >= 1 && Number(m[2]) <= 12 ? monthsRange(Number(m[1]), Number(m[2]), 1) : undefined)) || covered;
  covered = take(monthYear, (m) => { const mo = monthOf(m[1]!); return mo ? monthsRange(Number(m[2]), mo, 1) : undefined; }) || covered;
  if (covered) return true;
  for (const m of rest.matchAll(/(?<!\d[.,])\b((?:19|20)\d{2})\b(?![.,]\d)/g)) if (Number(m[1]) > eventYear) return true;
  return false;
}

/** A dated, adopted measure can specify its future validity. An announcement alone cannot. */
export function enactedPeriodCovers(text: string, event: Range): boolean {
  const folded = foldDate(text).replace(/\br\.(?=\s+do\b)/gu, "r");
  const dated = `(?:\\d{4}-\\d{2}(?:-\\d{2})?|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|(?:\\d{1,2}\\s+)?${MONTH_WORD_RE}\\s+\\d{4})`;
  const decision = "(?:przedluzono|przedluzon[eyao]|obowiazuj[eąa]|pozostaj\\w* w mocy|extended|in force|valid)";
  const endDate = new RegExp(`\\b${decision}\\s+[^.!?;]{0,110}?\\b(?:do|until|through)\\s+(${dated})(?![\\d-])`, "gu");
  return Array.from(folded.matchAll(endDate)).some(match => textCoversDate(match[1]!, event));
}
