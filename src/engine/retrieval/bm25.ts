import type { Database } from "better-sqlite3";
import type { EvidenceCandidate, RetrievalBranch, RetrievalQuery } from "../../shared/contracts";
import { skipLookup, throwIfAborted } from "./errors";
import { matchTerms, stripPiiPlaceholders } from "./fts";
import { BM25_MAX_SOURCE_SHARE, capPerSource } from "./diversity";
import { reciprocalRankFusion } from "./fusion";
import { fold } from "./stem";
import { institutionalMeasure, sourceMeasureValues } from "../verdict/slots";

/** Wagi kolumn records_fts(title, text, claim_reviewed): tytuł wyżej niż treść. */
export const BM25_WEIGHTS = { title: 10, text: 1, claim: 5 } as const;

export const DEFAULT_BRANCH_LIMIT = 30;

/**
 * Wagi list łączonych wewnątrz gałęzi BM25:
 *  - full  — wszystkie kolumny (records_fts),
 *  - head  — tylko tytuł i teza fact-checku (rekordy, których tytuł/claimReviewed pasuje, zawsze trafiają do puli),
 *  - fold  — tabela bez polskich znaków (records_fold), dla zapytań pisanych bez ogonków.
 */
export const BM25_LIST_WEIGHTS = { full: 1, head: 1, fold: 0.6 } as const;

export function queryTexts(q: RetrievalQuery): string[] {
  return [q.claim.text, ...(q.extraQueries ?? [])]
    .map((t) => (typeof t === "string" ? stripPiiPlaceholders(t) : ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Złożenie terminu FTS5 (już zacytowanego) do postaci bez znaków diakrytycznych — dla records_fold. */
function foldTerm(term: string): string {
  return fold(term);
}

/**
 * Gałąź BM25 po korpusie lokalnym (FTS5). Konieczna (required=true): jej awaria = NIEPEŁNE.
 * Wyjątki SQLite z zapytania głównego (np. brak tabeli) nie są łapane — `retrieve()` oznaczy gałąź jako
 * niedostępną. Zapytania pomocnicze (tytuł, tabela bez ogonków) są „best effort”.
 */
export function createBm25Branch(db: Database): RetrievalBranch {
  const { title, text, claim } = BM25_WEIGHTS;
  const stmts = new Map<string, import("better-sqlite3").Statement>();
  const prep = (key: string, sql: string) => {
    let s = stmts.get(key);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(key, s);
    }
    return s;
  };
  let hasFold: boolean | undefined;
  const foldAvailable = (): boolean => {
    if (hasFold === undefined) {
      try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'records_fold'").get();
        hasFold = !!row && ((db.prepare("SELECT COUNT(*) AS n FROM records_fold").get() as { n: number }).n ?? 0) > 0;
      } catch {
        hasFold = false;
      }
    }
    return hasFold;
  };

  const run = (key: string, table: "records_fts" | "records_fold", match: string, limit: number) =>
    prep(
      `${key}:${table}`,
      `SELECT r.id AS id, r.source_id AS src, bm25(${table}, ${title}, ${text}, ${claim}) AS s
         FROM ${table}
         JOIN records r ON r.rowid = ${table}.rowid
        WHERE ${table} MATCH ?
        ORDER BY s
        LIMIT ?`,
    ).all(match, limit) as { id: string; src: string | null; s: number }[];

  // bm25() w SQLite: mniejsze (bardziej ujemne) = lepsze → score dodatni, większy = lepszy.
  // `sources` zbiera źródło każdego trafienia — do miękkiego limitu jednego źródła w puli (diversity.ts).
  const toCandidates = (rows: { id: string; src: string | null; s: number }[], sources: Map<string, string>): EvidenceCandidate[] =>
    rows.map((row) => {
      if (row.src) sources.set(row.id, row.src);
      return { recordId: row.id, score: -row.s, via: "bm25" as const };
    });

  /**
   * Miękki limit jednego źródła: najwyżej BM25_MAX_SOURCE_SHARE × limit miejsc, nadmiar na koniec listy (zostaje,
   * gdy innych trafień brakuje). Zapytania pobierają 2 × limit wierszy, żeby było czym wypełnić zwolnione miejsca.
   */
  const capped = (cands: EvidenceCandidate[], sources: Map<string, string>, limit: number): EvidenceCandidate[] =>
    capPerSource(cands, (c) => sources.get(c.recordId), Math.max(4, Math.ceil(limit * BM25_MAX_SOURCE_SHARE)), limit);

  return {
    id: "bm25",
    required: true,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      throwIfAborted(q.signal);
      const terms = matchTerms(queryTexts(q));
      if (terms.length === 0) return skipLookup(q);
      const limit = q.limit ?? DEFAULT_BRANCH_LIMIT;
      const rowLimit = limit * 2;
      const match = terms.join(" OR ");
      const sources = new Map<string, string>();
      const full = toCandidates(run("full", "records_fts", match, rowLimit), sources);
      const measure = institutionalMeasure(q.claim.text);
      // Legal terms are often written out ("czteroletnią kadencję"). Requiring the
      // user's number would hide the very provision capable of correcting it.
      let statutory: EvidenceCandidate[] = [];
      if (measure?.kind === "term" || (/\bkadencj\p{L}*/iu.test(q.claim.text) && /(?:\blat\b|\brok\p{L}*|letni\p{L}*)/iu.test(q.claim.text))) {
        const offices = q.claim.text.match(/(?:prezydent|sejm|senat|posł|radn|wójt|burmistrz)\p{L}*/giu) ?? [];
        const names = matchTerms(offices);
        if (names.length) {
          const rows = prep("statutory-term", `SELECT r.id, r.source_id AS src, bm25(records_fts) AS s
            FROM records_fts JOIN records r ON records_fts.rowid = r.rowid
            WHERE records_fts MATCH ? AND r.source_id = 'sejm-eli'
              AND (r.text LIKE '%letni%' OR r.text LIKE '% lat%')
            ORDER BY s LIMIT 4`).all(`text : ("kadencj"* AND (${names.join(" OR ")}))`) as { id: string; src: string; s: number }[];
          statutory = toCandidates(rows, sources);
        }
      }
      if (measure?.kind === "count") {
        const subjects = matchTerms([measure.subject.replace(/ (?:rp|rzeczypospolitej polskiej)$/, "")]);
        const units = matchTerms([measure.unit]);
        if (subjects.length && units.length) {
          const table = foldAvailable() ? "records_fold" : "records_fts";
          const rows = prep("count:" + table, `SELECT r.id, r.source_id AS src, r.text AS body, bm25(${table}) AS s
            FROM ${table} JOIN records r ON ${table}.rowid = r.rowid
            WHERE ${table} MATCH ? AND r.level = 1 AND r.role = 'tresc' AND r.type = 'pierwotne'
            ORDER BY s LIMIT 60`).all(`text : ((${subjects.join(" OR ")}) AND (${units.join(" OR ")}))`) as { id: string; src: string; body: string; s: number }[];
          statutory = toCandidates(rows.filter(row => sourceMeasureValues(measure, row.body, row.src === "sejm-eli").length === 1), sources);
        }
      }

      let head: EvidenceCandidate[] = [];
      try {
        head = toCandidates(run("head", "records_fts", `{title claim_reviewed} : (${match})`, rowLimit), sources);
      } catch {
        /* best effort */
      }
      let folded: EvidenceCandidate[] = [];
      if (foldAvailable()) {
        try {
          const fterms = [...new Set(terms.map(foldTerm))];
          folded = toCandidates(run("fold", "records_fold", fterms.join(" OR "), rowLimit), sources);
        } catch {
          /* best effort */
        }
      }
      throwIfAborted(q.signal);
      if (head.length === 0 && folded.length === 0 && statutory.length === 0) return capped(full, sources, limit);
      const fused = reciprocalRankFusion([full, head, folded, statutory], undefined, [BM25_LIST_WEIGHTS.full, BM25_LIST_WEIGHTS.head, BM25_LIST_WEIGHTS.fold, 2]);
      return capped(fused, sources, limit).map((c) => ({ ...c, via: "bm25" as const }));
    },
  };
}
