/**
 * Liczy embeddingi wszystkich rekordów korpusu (multilingual-e5-small, prefiks „passage: ”) i zapisuje je:
 *   - w tabeli record_embeddings (BLOB Float32 LE) + klucze corpus_meta (embedding_model, embedding_model_hash),
 *   - w commitowanych plikach data/embeddings/<slug>.bin + <slug>.manifest.json (runtime nie liczy ich od nowa).
 *
 * Uruchomienie:  npx tsx src/engine/retrieval/embed-corpus.ts [--db var/prawdowid.db] [--out data/embeddings]
 * Wymaga załadowanego korpusu (corpus_meta.snapshot_id) — skrypt próbuje go załadować przez src/corpus/store.
 * Pierwsze uruchomienie pobiera model (~120 MB) do cache transformers.js.
 */
import "dotenv/config";
import type { Database } from "better-sqlite3";
import { ensureCorpusLoaded, openDatabase } from "../../corpus/store";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createE5Embedder, type Embedder } from "./embedder";
import { defaultEmbeddingsDir, floatsToBuffer, writeEmbeddingFiles, type EmbeddingManifest } from "./embeddings-store";

/** Maks. liczba znaków tekstu rekordu w pasażu (model i tak obcina do 512 tokenów). */
const MAX_PASSAGE_CHARS = 2000;

export interface EmbedCorpusOptions {
  /** Katalog docelowy plików (domyślnie data/embeddings). */
  outDir?: string;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

interface RecordRow {
  id: string;
  title: string | null;
  text: string | null;
  claim_reviewed: string | null;
}

export function passageText(r: RecordRow): string {
  const parts = [r.title ?? "", r.claim_reviewed ?? "", r.text ?? ""].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").slice(0, MAX_PASSAGE_CHARS);
}

export async function embedCorpus(
  db: Database,
  embedder: Embedder,
  opts: EmbedCorpusOptions = {},
): Promise<EmbeddingManifest> {
  const outDir = opts.outDir ?? defaultEmbeddingsDir();
  const batchSize = Math.max(1, opts.batchSize ?? 16);

  const snap = db.prepare("SELECT value FROM corpus_meta WHERE key = 'snapshot_id'").get() as
    | { value: string }
    | undefined;
  if (!snap?.value) throw new Error("corpus_meta.snapshot_id is missing — load the corpus first");
  const snapshotId = snap.value;

  const rows = db.prepare("SELECT id, title, text, claim_reviewed FROM records ORDER BY id").all() as RecordRow[];
  if (rows.length === 0) throw new Error("corpus has no records");

  const modelHash = await embedder.modelHash();
  const vectors: Float32Array[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const out = await embedder.embed(batch.map(passageText), "passage");
    if (out.length !== batch.length) throw new Error("embedder returned a wrong number of vectors");
    vectors.push(...out);
    opts.onProgress?.(Math.min(i + batchSize, rows.length), rows.length);
  }
  const dims = vectors[0]!.length;

  const manifest = writeEmbeddingFiles(
    outDir,
    { modelId: embedder.modelId, modelHash, dtype: embedder.dtype, snapshotId },
    rows.map((r) => r.id),
    vectors,
    dims,
  );

  // Lustro w bazie: ta sama zawartość co plik .bin.
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS record_embeddings (record_id TEXT PRIMARY KEY, vector BLOB);
  `);
  const insert = db.prepare("INSERT OR REPLACE INTO record_embeddings (record_id, vector) VALUES (?, ?)");
  const setMeta = db.prepare("INSERT OR REPLACE INTO corpus_meta (key, value) VALUES (?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM record_embeddings").run();
    rows.forEach((r, i) => insert.run(r.id, floatsToBuffer([vectors[i]!], dims)));
    setMeta.run("embedding_model", embedder.modelId);
    setMeta.run("embedding_model_hash", modelHash);
    setMeta.run("embedding_snapshot_id", snapshotId);
  })();

  return manifest;
}

// ───────────────────────────── CLI ─────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dbPath = arg("--db") ?? process.env.DB_PATH ?? "var/prawdowid.db";
  const outDir = arg("--out");
  const db = openDatabase(dbPath);
  const info = ensureCorpusLoaded(db);
  console.log(`corpus: ${info.records} records, snapshot ${info.snapshotId}`);
  const embedder = createE5Embedder();
  const t0 = Date.now();
  const manifest = await embedCorpus(db, embedder, {
    outDir,
    onProgress: (done, total) => {
      if (done === total || done % 64 === 0) console.log(`embedded ${done}/${total}`);
    },
  });
  console.log(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${manifest.count} vectors x ${manifest.dims}, ` +
      `model ${manifest.modelId} (${manifest.modelHash.slice(0, 12)}…), snapshot ${manifest.snapshotId}`,
  );
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
