import type { Database } from "better-sqlite3";
import type { EvidenceCandidate, RetrievalQuery } from "../../shared/contracts";
import { DEFAULT_BRANCH_LIMIT, queryTexts } from "./bm25";
import { createE5Embedder, type Embedder } from "./embedder";
import {
  EmbeddingFilesError,
  dot,
  l2normalize,
  manifestPathFor,
  readEmbeddingMatrix,
  readManifest,
  type EmbeddingMatrix,
} from "./embeddings-store";
import { BranchUnavailableError, skipLookup, throwIfAborted, type BranchStatus, type WarmableBranch } from "./errors";
import { stripPiiPlaceholders } from "./fts";
import { limitWithSemanticFactChecks } from "./fusion";

export interface VectorBranchOptions {
  /** Embedder zapytań (domyślnie multilingual-e5-small). Testy wstrzykują fałszywy. */
  embedder?: Embedder;
  /** Ścieżka manifestu (domyślnie data/embeddings/<slug>.manifest.json). */
  manifestPath?: string;
  /** Po jakim czasie ponowić próbę po niepowodzeniu weryfikacji/ładowania modelu. */
  retryAfterMs?: number;
  /** Dolny próg podobieństwa kosinusowego; niższe trafienia są pomijane. */
  minScore?: number;
  /** Maks. liczba zapytań (claim + dodatkowe) embedowanych na wyszukiwanie. */
  maxQueries?: number;
  /**
   * Inna migawka korpusu niż w manifeście, ale TEN SAM model (id + hash): używamy wektorów rekordów, które
   * nadal są w bazie (id rekordu zależy od treści), a brakujące rekordy embedujemy przy ładowaniu.
   * Domyślnie włączone; false = dawne zachowanie (gałąź niedostępna, „snapshot_mismatch”).
   */
  allowStaleSnapshot?: boolean;
  /** Maks. liczba brakujących rekordów embedowanych przy ładowaniu (powyżej — gałąź niedostępna). */
  maxFill?: number;
  now?: () => number;
}

/**
 * Domyślny próg podobieństwa. multilingual-e5 daje skompresowany zakres kosinusów (nawet niezwiązane
 * teksty mają ok. 0.70–0.76; trafne polskie zapytania na próbce syntetycznej 0.80–0.88), więc próg odcina tylko wyraźny szum; właściwe filtrowanie robi RRF + ocena dowodów.
 */
export const DEFAULT_MIN_VECTOR_SCORE = 0.78;
/** Dodatkowi kandydaci wymagają zgodności z pełnym twierdzeniem i trafienia mocniejszego niż zwykły próg gałęzi. */
const FACT_CHECK_MIN_CLAIM_SCORE = 0.83;
const FACT_CHECK_MIN_SCORE = 0.84;
const FACT_CHECK_MAX_SCORE_GAP = 0.02;
const FACT_CHECK_MAX_RESULTS = 2;
/** Mocno dopasowany wariant pozwala na niższy próg dla pełnego twierdzenia sformułowanego innymi słowami. */
const FACT_CHECK_PARAPHRASE_MIN_CLAIM_SCORE = 0.81;
const FACT_CHECK_PARAPHRASE_MIN_SCORE = 0.87;
export const DEFAULT_MAX_FILL = 3000;
const FILL_BATCH = 16;
const MAX_PASSAGE_CHARS = 2000;

export interface VectorBranch extends WarmableBranch {
  status(): BranchStatus;
}

function readMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM corpus_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? undefined;
}

/**
 * Gałąź wektorowa (opcjonalna). Przy pierwszym użyciu (albo w warmUp()) weryfikuje:
 *   id modelu + hash pliku modelu + identyfikator migawki korpusu  (manifest ↔ embedder ↔ corpus_meta),
 *   sumę SHA-256 i rozmiar pliku .bin, wymiary wektora zapytania.
 * Przy jakiejkolwiek niezgodzie lub gdy modelu nie da się załadować gałąź jest NIEDOSTĘPNA (rzuca
 * BranchUnavailableError) — nigdy nie porównujemy zapytań z wektorami innego modelu. Silnik wraca do BM25
 * z jawną adnotacją (retrieve() → unavailable: ["vector"]).
 */
export function createVectorBranch(db: Database, opts: VectorBranchOptions = {}): VectorBranch {
  const embedder = opts.embedder ?? createE5Embedder();
  const manifestPath = opts.manifestPath ?? manifestPathFor(embedder.modelId);
  const retryAfterMs = opts.retryAfterMs ?? 60_000;
  const minScore = opts.minScore ?? DEFAULT_MIN_VECTOR_SCORE;
  const maxQueries = opts.maxQueries ?? 4;
  const allowStale = opts.allowStaleSnapshot ?? true;
  const maxFill = opts.maxFill ?? DEFAULT_MAX_FILL;
  let stale = false;
  const now = opts.now ?? Date.now;

  let ready: EmbeddingMatrix | undefined;
  let failure: { reason: string; at: number } | undefined;
  let loading: Promise<EmbeddingMatrix> | undefined;

  const fail = (reason: string): never => {
    throw new BranchUnavailableError("vector", reason);
  };

  async function verifyAndLoad(): Promise<EmbeddingMatrix> {
    let manifest;
    try {
      manifest = readManifest(manifestPath);
    } catch (err) {
      return fail(err instanceof EmbeddingFilesError ? err.reason : "manifest_invalid");
    }
    if (manifest.modelId !== embedder.modelId) return fail("model_id_mismatch");

    let snapshot: string | undefined;
    let metaModel: string | undefined;
    let metaHash: string | undefined;
    try {
      snapshot = readMeta(db, "snapshot_id");
      metaModel = readMeta(db, "embedding_model");
      metaHash = readMeta(db, "embedding_model_hash");
    } catch {
      return fail("corpus_meta_unreadable");
    }
    if (!snapshot) return fail("snapshot_unknown");
    stale = snapshot !== manifest.snapshotId;
    if (stale && !allowStale) return fail("snapshot_mismatch");
    if (metaModel !== undefined && metaModel !== embedder.modelId) return fail("corpus_model_mismatch");
    if (metaHash !== undefined && metaHash !== manifest.modelHash) return fail("corpus_hash_mismatch");

    let hash: string;
    try {
      hash = await embedder.modelHash(); // ładuje model; rzuca, gdy się nie da
    } catch {
      return fail("model_unavailable");
    }
    if (hash !== manifest.modelHash) return fail("model_hash_mismatch");

    let matrix: EmbeddingMatrix;
    try {
      matrix = readEmbeddingMatrix(manifestPath, manifest);
    } catch (err) {
      return fail(err instanceof EmbeddingFilesError ? err.reason : "bin_corrupt");
    }

    // Próbne zapytanie: potwierdza, że model faktycznie działa i ma te same wymiary co indeks.
    try {
      const [probe] = await embedder.embed(["test"], "query");
      if (!probe || probe.length !== manifest.dims) return fail("dims_mismatch");
    } catch (err) {
      if (err instanceof BranchUnavailableError) throw err;
      return fail("model_unavailable");
    }
    return stale ? fillMissing(matrix) : matrix;
  }

  /** Dla nieaktualnej migawki: dokłada wektory rekordów, których nie ma w manifeście (ten sam model). */
  async function fillMissing(matrix: EmbeddingMatrix): Promise<EmbeddingMatrix> {
    let rows: { id: string; title: string | null; text: string | null; claim_reviewed: string | null }[];
    try {
      rows = db.prepare("SELECT id, title, text, claim_reviewed FROM records ORDER BY id").all() as typeof rows;
    } catch {
      return fail("corpus_unreadable");
    }
    const known = new Set(matrix.ids);
    const missing = rows.filter((r) => !known.has(r.id));
    if (missing.length === 0) return matrix;
    if (missing.length > maxFill) return fail("snapshot_mismatch");
    const vecs: Float32Array[] = [];
    try {
      for (let i = 0; i < missing.length; i += FILL_BATCH) {
        const batch = missing.slice(i, i + FILL_BATCH).map((r) =>
          [r.title ?? "", r.claim_reviewed ?? "", r.text ?? ""].map((x) => x.trim()).filter(Boolean).join("\n").slice(0, MAX_PASSAGE_CHARS),
        );
        vecs.push(...(await embedder.embed(batch, "passage")).map((v) => l2normalize(v)));
      }
    } catch {
      return fail("model_unavailable");
    }
    if (vecs.some((v) => v.length !== matrix.dims)) return fail("dims_mismatch");
    const out = new Float32Array(matrix.matrix.length + vecs.length * matrix.dims);
    out.set(matrix.matrix, 0);
    vecs.forEach((v, i) => out.set(v, matrix.matrix.length + i * matrix.dims));
    return { ids: [...matrix.ids, ...missing.map((r) => r.id)], dims: matrix.dims, matrix: out };
  }

  function ensureReady(): Promise<EmbeddingMatrix> {
    if (ready) return Promise.resolve(ready);
    if (failure && now() - failure.at < retryAfterMs) {
      return Promise.reject(new BranchUnavailableError("vector", failure.reason));
    }
    if (!loading) {
      loading = verifyAndLoad().then(
        (m) => {
          ready = m;
          failure = undefined;
          loading = undefined;
          return m;
        },
        (err) => {
          failure = { reason: err instanceof BranchUnavailableError ? err.reason : "load_failed", at: now() };
          loading = undefined;
          throw err instanceof BranchUnavailableError ? err : new BranchUnavailableError("vector", "load_failed");
        },
      );
    }
    return loading;
  }

  const existsStmtCache = new Map<number, import("better-sqlite3").Statement>();
  let factCheckStmt: import("better-sqlite3").Statement | undefined;
  function existingIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    let stmt = existsStmtCache.get(ids.length);
    if (!stmt) {
      stmt = db.prepare(`SELECT id FROM records WHERE id IN (${ids.map(() => "?").join(",")})`);
      existsStmtCache.set(ids.length, stmt);
    }
    return new Set((stmt.all(...ids) as { id: string }[]).map((r) => r.id));
  }

  function status(): BranchStatus {
    if (ready) return stale ? { available: true, reason: "snapshot_stale_filled" } : { available: true };
    return { available: false, reason: failure?.reason ?? "not_loaded_yet" };
  }

  return {
    id: "vector",
    required: false,

    status,

    async warmUp(): Promise<BranchStatus> {
      try {
        await ensureReady();
      } catch {
        /* stan w status() */
      }
      return status();
    },

    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      throwIfAborted(q.signal);
      const index = await ensureReady();
      throwIfAborted(q.signal);
      const texts = queryTexts(q).slice(0, maxQueries);
      if (texts.length === 0) return skipLookup(q);

      let queryVecs: Float32Array[];
      try {
        queryVecs = (await embedder.embed(texts, "query")).map((v) => l2normalize(v));
      } catch {
        throw new BranchUnavailableError("vector", "model_unavailable");
      }
      throwIfAborted(q.signal);
      if (queryVecs.length !== texts.length || queryVecs.some((v) => v.length !== index.dims)) {
        throw new BranchUnavailableError("vector", "dims_mismatch");
      }

      const limit = q.limit ?? DEFAULT_BRANCH_LIMIT;
      const factCheckThreshold = Math.max(minScore, FACT_CHECK_MIN_SCORE);
      let factCheckIds: Set<string> | undefined;
      if (q.includeSemanticFactCheck && limit > 1 && texts[0] === stripPiiPlaceholders(q.claim.text)) {
        factCheckStmt ??= db.prepare(
          "SELECT id FROM records WHERE source_id = 'demagog' AND role = 'stala_rola' AND claim_reviewed IS NOT NULL",
        );
        const rows = factCheckStmt.all() as { id: string }[];
        factCheckIds = new Set(rows.map((r) => r.id));
      }

      const n = index.ids.length;
      const scores = new Float32Array(n);
      const factChecks: { id: string; score: number }[] = [];
      for (let row = 0; row < n; row++) {
        const offset = row * index.dims;
        const claimScore = dot(index.matrix, offset, queryVecs[0]!, index.dims);
        let best = claimScore;
        for (let i = 1; i < queryVecs.length; i++) {
          const s = dot(index.matrix, offset, queryVecs[i]!, index.dims);
          if (s > best) best = s;
        }
        scores[row] = best;
        // Warianty pomagają odnaleźć parafrazę, ale same ogólne słowa kluczowe nie rezerwują miejsca.
        const id = index.ids[row]!;
        const strongMatch = claimScore >= FACT_CHECK_MIN_CLAIM_SCORE
          || (claimScore >= FACT_CHECK_PARAPHRASE_MIN_CLAIM_SCORE && best >= FACT_CHECK_PARAPHRASE_MIN_SCORE);
        if (factCheckIds?.has(id) && strongMatch && best >= factCheckThreshold) factChecks.push({ id, score: best });
      }
      const bestFactChecks = factChecks.sort((a, b) => b.score - a.score).slice(0, Math.min(FACT_CHECK_MAX_RESULTS, limit - 1));
      const minFactCheckScore = (bestFactChecks[0]?.score ?? 0) - FACT_CHECK_MAX_SCORE_GAP;
      const selectedFactChecks = bestFactChecks.filter(({ score }) => score >= minFactCheckScore);
      const selectedFactCheckIds = new Set(selectedFactChecks.map(({ id }) => id));
      const order = Array.from({ length: n }, (_, i) => i)
        .filter((i) => scores[i]! >= minScore)
        .sort((a, b) => scores[b]! - scores[a]! || (index.ids[a]! < index.ids[b]! ? -1 : 1))
        .slice(0, limit * 2);
      const present = existingIds(order.map((i) => index.ids[i]!));
      const out: EvidenceCandidate[] = [];
      for (const i of order) {
        const id = index.ids[i]!;
        if (!present.has(id)) continue; // wektor dla rekordu, którego już nie ma w bazie
        out.push({
          recordId: id, score: scores[i]!, via: "vector",
          ...(selectedFactCheckIds.has(id) ? { semanticFactCheck: true } : {}),
        });
        if (out.length >= limit) break;
      }
      for (const { id, score } of selectedFactChecks) {
        if (!out.some((c) => c.recordId === id)) out.push({ recordId: id, score, via: "vector", semanticFactCheck: true });
      }
      return limitWithSemanticFactChecks(out, limit);
    },
  };
}
