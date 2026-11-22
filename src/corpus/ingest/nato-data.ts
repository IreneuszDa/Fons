/**
 * Dane NATO jako osobne, wyszukiwalne zdania (rekordy w źródle "nato"):
 *  1. członkowie NATO: lista alfabetyczna "Państwo rok" ze strony nato.int (32 państwa) + daty przystąpienia z tekstu tej samej strony
 *     (zdania dowodowe cytowane dosłownie w rekordzie; gdy zdania brak, rekord ma tylko rok z listy),
 *  2. wydatki obronne jako % realnego PKB: tabela 3 raportu "Defence Expenditure of NATO Countries (2014-2025)" (PDF NATO,
 *     tekst warstwowy -> pdftotext -layout). Edycja 2026 (def-exp-2026-en.pdf) jest PDF-em bez warstwy tekstowej (zrzut obrazu), więc
 *     nie jest czytana (bez OCR); najnowsze liczby w tekście stron NATO trafiają do rekordów dosłownych.
 * Rekordy z tych parserów mają tag "generated-from-data" (zdanie złożone z pól listy/tabeli + cytat źródła).
 */
import { memberRegister } from "./member-register";
import { execFile } from "node:child_process";
import type { CorpusRecord } from "../../shared/contracts";
import { MONTHS_PL_GEN, parseEnglishDate } from "./officialpages";
import { type PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

export const NATO_MEMBERS_URL = "https://www.nato.int/en/about-us/organization/nato-member-countries";
export const DEFEXP_ARTICLE_URL = "https://www.nato.int/en/news-and-events/articles/news/2025/08/28/defence-expenditure-of-nato-countries-2014-2025";
export const DEFEXP_PDF_URL = "https://www.nato.int/content/dam/nato/webready/documents/finance/def-exp-2025-en.pdf";

/** Nazwy państw NATO po polsku (klucz: nazwa z nato.int). */
export const NATO_PL: Record<string, string> = {
  Albania: "Albania", Belgium: "Belgia", Bulgaria: "Bułgaria", Canada: "Kanada", Croatia: "Chorwacja", Czechia: "Czechy", Denmark: "Dania",
  Estonia: "Estonia", Finland: "Finlandia", France: "Francja", Germany: "Niemcy", Greece: "Grecja", Hungary: "Węgry", Iceland: "Islandia",
  Italy: "Włochy", Latvia: "Łotwa", Lithuania: "Litwa", Luxembourg: "Luksemburg", Montenegro: "Czarnogóra", "North Macedonia": "Macedonia Północna",
  Norway: "Norwegia", Poland: "Polska", Portugal: "Portugalia", Romania: "Rumunia", Slovakia: "Słowacja", Slovenia: "Słowenia", Spain: "Hiszpania",
  Sweden: "Szwecja", "The Netherlands": "Niderlandy (Holandia)", "Türkiye": "Turcja (Türkiye)", "United Kingdom": "Wielka Brytania", "United States": "Stany Zjednoczone",
};

/** Alias nazw z tabeli wydatków → nazwa z listy członków. */
const TABLE_NAME_ALIASES: Record<string, string> = { "Slovak Republic": "Slovakia", Netherlands: "The Netherlands" };

export interface MemberRow {
  name: string;
  year: number;
}

/** Linie "Albania 2009" między "Alphabetical list of NATO member countries" a opisem rund rozszerzenia. */
export function parseMemberList(lines: string[]): MemberRow[] {
  const i0 = lines.findIndex((l) => /^Alphabetical list of NATO member countries/.test(l));
  if (i0 < 0) return [];
  const out: MemberRow[] = [];
  for (const l of lines.slice(i0 + 1)) {
    if (/^How each country became a NATO member/.test(l)) break;
    const m = /^(.+?)\s+(19\d{2}|20\d{2})$/.exec(l);
    if (m) out.push({ name: m[1]!, year: Number(m[2]) });
  }
  return out;
}

interface Round {
  year: number;
  /** Państwa przystępujące w tej rundzie (nazwy z listy nato.int); puste = reszta z listy o tym roku. */
  /** Zdanie dowodowe w tekście strony (dosłownie) z datą. */
  evidence: RegExp;
  /** Data ISO podawana tylko, gdy zdanie dowodowe znaleziono na stronie. */
  iso: string;
  note?: string;
}

export const NATO_ROUNDS: Round[] = [
  { year: 1949, iso: "1949-04-04", evidence: /Twelve countries from Europe and North America signed the North Atlantic Treaty on 4 April 1949 in Washington, D\.C\./, note: "państwo założycielskie; Traktat Północnoatlantycki podpisano 4 kwietnia 1949 r." },
  { year: 1952, iso: "1952-02-18", evidence: /on 18 February 1952, Greece and Türkiye joined NATO\./ },
  { year: 1955, iso: "1955-05-06", evidence: /Germany became a NATO member on 6 May 1955\./ },
  { year: 1982, iso: "1982-05-30", evidence: /Spain joined the Alliance on 30 May 1982/ },
  { year: 1999, iso: "1999-03-12", evidence: /on 12 March 1999 they became the first former members of the Warsaw Pact to join NATO\./ },
  { year: 2004, iso: "2004-03-29", evidence: /On 29 March 2004, they officially became members of the Alliance/ },
  { year: 2009, iso: "2009-04-01", evidence: /became official members of the Alliance on 1 April 2009\./ },
  { year: 2017, iso: "2017-06-05", evidence: /Montenegro became a member of the Alliance on 5 June 2017\./ },
  { year: 2020, iso: "2020-03-27", evidence: /On 27 March 2020, it became NATO's 30th member\./ },
  { year: 2023, iso: "2023-04-04", evidence: /Finland deposited its Instrument of Accession to the North Atlantic Treaty on 4 April 2023, becoming NATO's 31st member country\./ },
  { year: 2024, iso: "2024-03-07", evidence: /Sweden deposited its Instrument of Accession to the North Atlantic Treaty on 7 March 2024, becoming NATO's 32nd member country\./ },
];

function plDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS_PL_GEN[Number(m) - 1]} ${y} r.`;
}

function plList(names: string[]): string {
  const pl = names.map((n) => NATO_PL[n] ?? n);
  return pl.length <= 1 ? (pl[0] ?? "") : `${pl.slice(0, -1).join(", ")} i ${pl[pl.length - 1]}`;
}

export interface MemberRecordInput {
  members: MemberRow[];
  pageText: string;
  url: string;
  fetchedAt: string;
  publishedAt: string | null;
}

/** Rekordy "członek NATO od …" (po jednym na państwo) i "runda rozszerzenia" (po jednym na rok). Czysta funkcja — do testów. */
export function buildMemberRecords(input: MemberRecordInput, base: ReturnType<typeof baseFromCatalog>): CorpusRecord[] {
  const flat = squash(input.pageText);
  const out: CorpusRecord[] = [];
  const topicsBase = ["nato", "czlonkostwo", "rozszerzenie-nato", "data-przystapienia", "generated-from-data", "komunikat-instytucji"];
  for (const round of NATO_ROUNDS) {
    const countries = input.members.filter((m) => m.year === round.year).map((m) => m.name);
    if (countries.length === 0) continue;
    const evidence = round.evidence.exec(flat)?.[0] ?? null;
    const dated = evidence ? round.iso : null;
    const when = dated ? `${plDate(dated)} (${dated})` : `${round.year} r.`;
    const quote = evidence ? ` Zdanie ze strony NATO: „${evidence}”` : "";
    const verb = round.year === 1949 ? "należą do 12 państw założycielskich NATO" : "przystąpiły do NATO";
    // Rekord rundy
    out.push({
      ...base,
      id: recordId("nato", `${input.url}|round|${round.year}`),
      url: input.url,
      title: `NATO: członkowie przyjęci w ${round.year} r. — ${plList(countries)}`,
      publishedAt: input.publishedAt,
      fetchedAt: input.fetchedAt,
      lang: "pl",
      text: `${plList(countries)} ${countries.length === 1 ? (round.year === 1949 ? "należy do państw założycielskich NATO" : "przystąpiła do NATO") : verb}: ${when}.${round.note && round.year !== 1949 ? ` ${round.note}` : ""}${quote}`,
      topics: [...topicsBase, "runda-rozszerzenia", ...countries.map((c) => (NATO_PL[c] ?? c).toLowerCase().replace(/[^a-ząćęłńóśźż]+/g, "-"))],
      period: dated ?? String(round.year),
      origin: "corpus",
    });
    // Rekordy państw
    for (const c of countries) {
      const pl = NATO_PL[c] ?? c;
      out.push({
        ...base,
        id: recordId("nato", `${input.url}|member|${c}`),
        url: input.url,
        title: `NATO: ${pl} — członkostwo w NATO od ${round.year} r.`,
        publishedAt: input.publishedAt,
        fetchedAt: input.fetchedAt,
        lang: "pl",
        text:
          round.year === 1949
            ? `${pl} — członkostwo w NATO od 1949 r.: państwo założycielskie (jedno z 12); Traktat Północnoatlantycki podpisano 4 kwietnia 1949 r. Lista państw członkowskich NATO: „${c} ${round.year}”.${quote}`
            : `${pl} — członkostwo w NATO od ${dated ? plDate(dated) : `${round.year} r.`}${dated ? ` (${dated})` : ""}. Lista państw członkowskich NATO: „${c} ${round.year}”.${quote}`,
        topics: [...topicsBase, "polska-w-nato", c === "Poland" ? "polska" : (NATO_PL[c] ?? c).toLowerCase().replace(/[^a-ząćęłńóśźż]+/g, "-")],
        period: dated ?? String(round.year),
        origin: "corpus",
      });
    }
  }
  return out;
}

// ───────────────────────────── Wydatki obronne ─────────────────────────────

export interface DefExpTable {
  years: string[];
  rows: { name: string; values: (number | null)[]; national: boolean }[];
}

/** Tabela 3 "Share of real GDP (%)" z tekstu `pdftotext -layout` raportu NATO. */
export function parseDefExpShareOfGdp(text: string): DefExpTable | null {
  const lines = text.split("\n");
  const i0 = lines.findIndex((l) => /^\s*Share of real GDP \(%\)\s*$/.test(l));
  if (i0 < 0) return null;
  const yearsLine = lines.slice(i0 + 1, i0 + 4).find((l) => /\b2014\b/.test(l));
  if (!yearsLine) return null;
  const years = yearsLine.trim().split(/\s+/);
  const rows: DefExpTable["rows"] = [];
  for (const l of lines.slice(lines.indexOf(yearsLine) + 1)) {
    if (!l.trim()) {
      if (rows.length > 0) break;
      continue;
    }
    const m = /^(\S.*?)\s{2,}((?:-?\d+(?:\.\d+)?|\.\.)(?:\s+(?:-?\d+(?:\.\d+)?|\.\.))*)\s*$/.exec(l);
    if (!m) continue;
    const vals = m[2]!.trim().split(/\s+/);
    if (vals.length !== years.length) continue;
    const rawName = m[1]!.trim();
    rows.push({ name: rawName.replace(/\*$/, ""), national: rawName.endsWith("*"), values: vals.map((v) => (v === ".." ? null : Number(v))) });
  }
  return rows.length >= 30 ? { years, rows } : null;
}

function num(v: number): string {
  return v.toFixed(2).replace(".", ",");
}

function yearLabel(y: string): { year: string; estimate: boolean } {
  return { year: y.replace(/e$/, ""), estimate: /e$/.test(y) };
}

export interface DefExpRecordInput {
  table: DefExpTable;
  url: string;
  fetchedAt: string;
  publishedAt: string | null;
}

const SERIES_NAMES = new Set(["NATO Europe and Canada", "NATO Total"]);

/** Rekordy: seria 2014-2025e dla każdego państwa/agregatu + pojedyncze lata (2014, 2022, 2025e — wszyscy; Polska — każdy rok). Czysta funkcja. */
export function buildDefExpRecords(input: DefExpRecordInput, base: ReturnType<typeof baseFromCatalog>): CorpusRecord[] {
  const out: CorpusRecord[] = [];
  const report = "raport NATO „Defence Expenditure of NATO Countries (2014-2025)” (tabela 3: udział wydatków obronnych w realnym PKB, ceny z 2021 r.; dane za 2024 i 2025 to szacunki, termin zamknięcia danych 3 czerwca 2025 r.)";
  const topicsBase = ["nato", "wydatki-na-obrone", "5-procent-pkb", "obronnosc", "statystyka", "generated-from-data", "komunikat-instytucji"];
  const firstYear = input.table.years[0]!;
  const lastYear = input.table.years[input.table.years.length - 1]!;
  for (const row of input.table.rows) {
    const canonical = TABLE_NAME_ALIASES[row.name] ?? row.name;
    const isSeries = SERIES_NAMES.has(row.name);
    const pl = isSeries ? (row.name === "NATO Total" ? "NATO ogółem" : "europejscy członkowie NATO i Kanada łącznie") : (NATO_PL[canonical] ?? canonical);
    const slug = isSeries ? row.name.toLowerCase().replace(/\s+/g, "-") : canonical === "Poland" ? "polska" : pl.toLowerCase().replace(/[^a-ząćęłńóśźż]+/g, "-");
    const pairs = input.table.years.map((y, i) => ({ y, v: row.values[i] ?? null })).filter((p): p is { y: string; v: number } => p.v !== null);
    if (pairs.length === 0) continue;
    const series = pairs.map((p) => `${yearLabel(p.y).year}${yearLabel(p.y).estimate ? " (szac.)" : ""}: ${num(p.v)}%`).join("; ");
    out.push({
      ...base,
      id: recordId("nato", `${input.url}|defexp-series|${canonical}`),
      url: input.url,
      title: `NATO: wydatki obronne — ${pl}, % PKB w latach ${yearLabel(firstYear).year}-${yearLabel(lastYear).year}`,
      publishedAt: input.publishedAt,
      fetchedAt: input.fetchedAt,
      lang: "pl",
      text: `Wydatki obronne (definicja NATO) — ${pl}, udział w PKB w latach ${yearLabel(firstYear).year}-${yearLabel(lastYear).year}: ${series}. Źródło: ${report}.`,
      topics: [...topicsBase, slug, ...(canonical === "Poland" ? ["polska"] : [])],
      period: `${yearLabel(firstYear).year}-${yearLabel(lastYear).year}`,
      origin: "corpus",
    });
    const singles = input.table.years.filter((y) => canonical === "Poland" || SERIES_NAMES.has(row.name) || ["2014", "2022", lastYear].includes(y));
    for (const y of singles) {
      const i = input.table.years.indexOf(y);
      const v = row.values[i];
      if (v === null || v === undefined) continue;
      const { year, estimate } = yearLabel(y);
      out.push({
        ...base,
        id: recordId("nato", `${input.url}|defexp|${canonical}|${year}`),
        url: input.url,
        title: `NATO: wydatki obronne — ${pl}, ${year} r.: ${num(v)}% PKB${estimate ? " (szacunek)" : ""}`,
        publishedAt: input.publishedAt,
        fetchedAt: input.fetchedAt,
        lang: "pl",
        text: `W ${year} r. wydatki obronne (definicja NATO) — ${pl}: ${num(v)}% PKB${estimate ? " (szacunek NATO)" : ""}. Źródło: ${report}.`,
        topics: [...topicsBase, slug, ...(canonical === "Poland" ? ["polska"] : [])],
        period: year,
        origin: "corpus",
      });
    }
  }
  return out;
}

async function pdfToTextLayout(buf: Buffer): Promise<string> {
  const child = execFile("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" });
  return await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`pdftotext zakończył się kodem ${code}`))));
    child.stdin?.on("error", () => {});
    child.stdin?.end(buf);
  });
}

export async function ingestNatoData(
  client: PoliteClient,
  opts: IngestOptions,
  result: IngestResult,
  members: { lines: string[]; pageText: string; url: string; fetchedAt: string; publishedAt: string | null } | null,
): Promise<void> {
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "nato"));
  if (members) {
    const rows = parseMemberList(members.lines);
    const start = members.lines.findIndex(l => /^Alphabetical list of NATO member countries/u.test(l));
    const end = members.lines.findIndex((l, i) => i > start && /^How each country became a NATO member/u.test(l));
    const declared = /At present, NATO has (\d+) member countries\./u.exec(members.pageText)?.[1];
    const lines = members.lines.slice(start + 1, end).filter(line => line.trim());
    const complete = start >= 0 && end > start && lines.length === rows.length && members.url === NATO_MEMBERS_URL &&
      memberRegister("NATO", base, members.url, members.fetchedAt, members.publishedAt, Number(declared), rows.map(r => r.name));
    if (complete) result.records.push(complete);
    else result.skipped.push({ what: NATO_MEMBERS_URL, reason: "Nie potwierdzono kompletności wykazu NATO" });
    const recs = buildMemberRecords({ members: rows, pageText: members.pageText, url: members.url, fetchedAt: members.fetchedAt, publishedAt: members.publishedAt }, base);
    result.records.push(...recs);
    opts.log(`  NATO członkowie: ${rows.length} państw -> ${recs.length} zdań`);
  }
  try {
    const art = await client.get(DEFEXP_ARTICLE_URL);
    const dateLine = parseHtmlPage(art.body, ".article-text-wrapper").text.split("\n").map(squash).find((l) => /^\d{1,2} [A-Z][a-z]+ \d{4}$/.test(l));
    const publishedAt = dateLine ? parseEnglishDate(dateLine) : null;
    const bin = await client.getBinary(DEFEXP_PDF_URL, { accept: "application/pdf,*/*" });
    const table = parseDefExpShareOfGdp(await pdfToTextLayout(bin.data));
    if (!table) throw new Error("nie rozpoznano tabeli 3 (udział wydatków obronnych w PKB) w PDF");
    const recs = buildDefExpRecords({ table, url: DEFEXP_PDF_URL, fetchedAt: bin.fetchedAt, publishedAt }, base);
    result.records.push(...recs);
    opts.log(`  NATO wydatki obronne % PKB: ${table.rows.length} wierszy -> ${recs.length} zdań (publishedAt=${publishedAt ?? "brak"})`);
  } catch (e) {
    result.skipped.push({ what: DEFEXP_PDF_URL, reason: (e as Error).message });
  }
}
