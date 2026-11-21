import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 128-bit random token, URL-safe (22 znaki). */
export function newToken(): string {
  return randomBytes(16).toString("base64url");
}

export function newRequestId(): string {
  return `req_${randomBytes(8).toString("hex")}`;
}

/** Constant-time string compare (hashes first so that lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Lowercase, strip diacritics (incl. Polish ł), keep letters/digits only. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    .toLowerCase();
}

export function foldWords(s: string): string {
  return fold(s)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "jest", "oraz", "nie", "czy", "dla", "aby", "ale", "jak", "sie", "przez", "tylko", "ten", "ta", "te", "tego",
  "ktory", "ktora", "ktore", "bardzo", "juz", "ze", "oraz", "ich", "jego", "jej", "sa", "byl", "byla", "bylo",
]);

/** Tokens used for case deduplication (PLAN §8). */
export function claimTokens(text: string): string[] {
  const out = foldWords(text)
    .split(" ")
    .filter((t) => t.length > 0 && (t.length >= 3 || /\d/.test(t)) && !STOPWORDS.has(t));
  return [...new Set(out)];
}

export function normalizeClaim(text: string): string {
  const t = claimTokens(text);
  return t.length > 0 ? [...t].sort().join(" ") : foldWords(text);
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of new Set(a)) if (sb.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * „Kotwice” twierdzenia do deduplikacji spraw: nazwy własne (wielka litera nie na początku zdania), skrótowce
 * (NATO, RCB) i liczby. Dwa zgłoszenia o innym mieście, kraju czy dacie to różne sprawy, nawet gdy reszta zdania
 * jest identyczna. Zwraca formy złożone (bez diakrytyków, małe litery), bez powtórzeń.
 */
export function claimAnchors(text: string): string[] {
  const out: string[] = [];
  const raw = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i]!;
    const prev = i > 0 ? raw[i - 1]! : "";
    const word = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!word) continue;
    const sentenceStart = i === 0 || /[.!?…:;]["”»)]*$/u.test(prev) || /^[„"«(]/u.test(tok);
    const folded = foldWords(word).replace(/\s+/g, "");
    if (!folded) continue;
    if (/\d/.test(word)) out.push(folded);
    else if (word.length >= 2 && /^\p{Lu}+$/u.test(word)) out.push(folded); // skrótowiec
    else if (!sentenceStart && /^\p{Lu}/u.test(word) && folded.length >= 3) out.push(folded);
  }
  return [...new Set(out)];
}

/** Dwie kotwice to ta sama nazwa w innej odmianie (Elbląg/Elblągu, Łódź/Łodzi); liczby muszą być identyczne. */
export function sameAnchor(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= Math.max(3, Math.min(5, a.length, b.length));
}

/**
 * Kotwice zgodne: każda kotwica krótszej listy ma odpowiednik w dłuższej (parafraza może dodać nazwę, ale nie
 * zmienić miasta). Brak kotwic po obu stronach = zgodne; po jednej stronie = zgodne (nie ma czego porównać).
 */
export function anchorsCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  return small.every((x) => large.some((y) => sameAnchor(x, y)));
}

/** Only http/https URLs; returns the normalised string or null. */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isoDatePart(s: string | null | undefined): string {
  if (!s) return "brak daty";
  return s.slice(0, 10);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
