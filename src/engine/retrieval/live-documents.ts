import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { resolveRelativeDates } from "../../security/dates";
import { splitSentences } from "../../security/text";
import { CorpusRecord, type CatalogSource, type RetrievalQuery } from "../../shared/contracts";
import { asksAboutPresent } from "../answer";
import { buildMatchQuery } from "./fts";
import { foldToken, queryStems, scorePassages } from "./live-score";

const MAX_AGE_MS = 48 * 3_600_000;
const EXCERPT_CHARS = 300;
const StoredDocument = z.object({
  finalUrl: z.string().url(),
  title: z.string(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string().datetime(),
  passages: z.array(z.string().min(1)).min(1),
  reviews: z.array(CorpusRecord),
  lang: z.string().optional(),
  isExcerpt: z.boolean().optional(),
});
export type LiveDocument = z.infer<typeof StoredDocument>;

const currentLanguage = /\b(?:ostatni\w*|niedawno|dzis(?:iaj)?|wczoraj|przedwczoraj|jutro|pojutrze|teraz|obecn\w*|aktualn\w*|biezac\w*|najnowsz\w*|w (?:tym|przyszlym|ubieglym|zeszlym) (?:tygodniu|miesiacu|roku)|na ten moment|kto (?:jest|pelni|kieruje)|czy nadal|dzisiej\w*|wczorajsz\w*|today|yesterday|tomorrow|current\w*|now|recent\w*|latest|last (?:week|month)|this (?:week|month|year))\b/u;

/** Relative references and undated states need fresh discovery and a new read of the publication. */
export function requiresFreshDocument(q: RetrievalQuery): boolean {
  const { temporal } = q.claim;
  if (q.recentPrimaryOnly || (temporal.kind === "stan" && !temporal.asOf)) return true;
  const now = q.asOf && Number.isFinite(Date.parse(q.asOf)) ? new Date(q.asOf) : new Date();
  const text = foldToken([q.claim.text, ...(q.extraQueries ?? [])].join(" "));
  if (currentLanguage.test(text)) return true;
  if (!temporal.asOf && !temporal.date && !/\b\d{4}\b/u.test(text) && asksAboutPresent(q.claim.text, false)) return true;
  // The normalizer may already have replaced "yesterday" with a calendar date.
  if (/\d/u.test(text)) {
    const calendar = resolveRelativeDates("przedwczoraj|wczoraj|dziś|jutro|pojutrze|w tym tygodniu", now);
    if (calendar.split("|").some(day => text.includes(foldToken(day)))) return true;
  }
  return [temporal.date, temporal.asOf, temporal.publishedBy].some(value => {
    if (!value) return false;
    const day = Date.parse(value);
    return Number.isFinite(day) && day >= now.getTime() - 3 * 86_400_000;
  });
}

// External-content FTS keeps one copy of the passages. The triggers update the index in the writer's transaction.
const initialized = new WeakSet<Database>();
function ensureStore(db: Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_documents (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, title TEXT NOT NULL,
      passages TEXT NOT NULL, metadata TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS live_documents_expiry ON live_documents(expires_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS live_documents_fts USING fts5(
      title, passages, content='live_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS live_documents_insert AFTER INSERT ON live_documents BEGIN
      INSERT INTO live_documents_fts(rowid, title, passages) VALUES(new.id, new.title, new.passages);
    END;
    CREATE TRIGGER IF NOT EXISTS live_documents_delete AFTER DELETE ON live_documents BEGIN
      INSERT INTO live_documents_fts(live_documents_fts, rowid, title, passages) VALUES('delete', old.id, old.title, old.passages);
    END;
    CREATE TRIGGER IF NOT EXISTS live_documents_update AFTER UPDATE ON live_documents BEGIN
      INSERT INTO live_documents_fts(live_documents_fts, rowid, title, passages) VALUES('delete', old.id, old.title, old.passages);
      INSERT INTO live_documents_fts(rowid, title, passages) VALUES(new.id, new.title, new.passages);
    END;
  `);
  initialized.add(db);
}

function sourcePolicy(source: CatalogSource): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** Choose a verbatim sentence for limited licences, preserving its attribution through URL and catalogue id. */
function excerptFor(doc: LiveDocument, query?: string): string {
  const sentences = doc.passages.flatMap(p => splitSentences(p).map(s => s.text.trim())).filter(Boolean);
  const terms = queryStems(query ? [query] : []);
  const best = scorePassages(sentences.map((text, i) => ({ key: String(i), title: "", text })), terms)[0];
  const excerpt = sentences[best ? Number(best.key) : 0] ?? "";
  if (excerpt.length <= EXCERPT_CHARS) return excerpt;
  const cut = excerpt.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}

/** Only store source text that has passed the live fetch, source and injection checks. Reads never extend the TTL. */
export function saveLiveDocument(db: Database, doc: LiveDocument, source: CatalogSource, ttlMs = MAX_AGE_MS, query?: string): void {
  if (!source.liveSearch || !source.liveDocumentCache || doc.isExcerpt || !(ttlMs > 0)) return;
  try {
    ensureStore(db);
    const isExcerpt = source.liveDocumentCache === "excerpt";
    const passages = isExcerpt ? [excerptFor(doc, query)] : doc.passages;
    if (!passages[0]) return;
    const metadata = { lang: doc.lang, publishedAt: doc.publishedAt, reviews: isExcerpt ? [] : doc.reviews, isExcerpt };
    const expires = new Date(Date.parse(doc.fetchedAt) + Math.min(ttlMs, MAX_AGE_MS)).toISOString();
    db.transaction(() => {
      db.prepare("DELETE FROM live_documents WHERE expires_at <= ?").run(doc.fetchedAt);
      db.prepare(`INSERT INTO live_documents(url, policy, title, passages, metadata, fetched_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET policy=excluded.policy, title=excluded.title,
        passages=excluded.passages, metadata=excluded.metadata, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at
        WHERE excluded.fetched_at >= live_documents.fetched_at`).run(doc.finalUrl, sourcePolicy(source), doc.title,
        JSON.stringify(passages), JSON.stringify(metadata), doc.fetchedAt, expires);
    })();
  } catch { /* Caching is optional, including on read-only databases. */ }
}

export function invalidateLiveDocument(db: Database, url: string): void {
  try { db.prepare("DELETE FROM live_documents WHERE url = ?").run(url); } catch { /* Store absent or unavailable. */ }
}

export function getLiveDocument(db: Database, url: string, now: Date, source: CatalogSource): LiveDocument | undefined {
  if (!source.liveSearch || !source.liveDocumentCache) return;
  try {
    const at = now.toISOString();
    const row = db.prepare(`SELECT title, passages, metadata, fetched_at FROM live_documents
      WHERE url = ? AND policy = ? AND fetched_at <= ? AND expires_at > ?`).get(url, sourcePolicy(source), at, at) as
      { title: string; passages: string; metadata: string; fetched_at: string } | undefined;
    if (!row) return;
    const doc = StoredDocument.parse({ ...JSON.parse(row.metadata), finalUrl: url, title: row.title,
      fetchedAt: row.fetched_at, passages: JSON.parse(row.passages) });
    if (source.liveDocumentCache === "excerpt" && (!doc.isExcerpt || doc.passages.length !== 1 || doc.passages[0]!.length > EXCERPT_CHARS || doc.reviews.length)) return;
    return doc;
  } catch { return; }
}

/** Preliminary matches only. The caller rechecks catalogue membership, policy and the evidence for this claim. */
export function findLiveDocuments(db: Database, query: string, now: Date): string[] {
  const match = buildMatchQuery([query], 24);
  if (!match) return [];
  try {
    const at = now.toISOString();
    const rows = db.prepare(`SELECT d.url FROM live_documents_fts JOIN live_documents d ON d.id = live_documents_fts.rowid
      WHERE live_documents_fts MATCH ? AND d.fetched_at <= ? AND d.expires_at > ?
      ORDER BY rank LIMIT 12`).all(match, at, at) as { url: string }[];
    return rows.map(row => row.url);
  } catch { return []; }
}
