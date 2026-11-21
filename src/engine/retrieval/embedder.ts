/**
 * Embedder wektorowy — multilingual-e5-small (ONNX, kwantyzowany) przez @huggingface/transformers.
 * Mean pooling + normalizacja L2; prefiksy „query: ” / „passage: ” wymagane przez rodzinę E5.
 * Model ładowany leniwie (pierwsze użycie może pobrać ~120 MB do cache); błąd ładowania nie jest zapamiętywany
 * na stałe — kolejna próba ponowi ładowanie (ograniczanie częstotliwości robi gałąź wektorowa).
 */
import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { l2normalize } from "./embeddings-store";

export const E5_MODEL_ID = "Xenova/multilingual-e5-small";
export const E5_DTYPE = "q8";
/** Plik wag dla dtype "q8" w repozytorium modelu. */
export const E5_ONNX_FILE = "onnx/model_quantized.onnx";

export interface Embedder {
  readonly modelId: string;
  readonly dtype: string;
  /** SHA-256 pliku wag modelu (hex). Rzuca, gdy pliku nie da się odczytać. */
  modelHash(): Promise<string>;
  /** Zwraca wektory L2-znormalizowane, po jednym na tekst. Prefiksy modelu dodaje implementacja. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

/** Minimalny kształt potoku feature-extraction z transformers.js. */
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

export interface E5EmbedderOptions {
  modelId?: string;
  dtype?: string;
  /** Wstrzyknięcie potoku (testy). Domyślnie ładuje prawdziwy model. */
  loadPipeline?: () => Promise<FeatureExtractor>;
  /** Ścieżka pliku wag (do hasha). Domyślnie `<env.cacheDir>/<modelId>/onnx/model_quantized.onnx`. */
  modelFile?: string;
  /** Zakaz pobierania modelu z sieci (tylko lokalny cache). */
  offline?: boolean;
}

export function prefixFor(kind: "query" | "passage"): string {
  return kind === "query" ? "query: " : "passage: ";
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export function createE5Embedder(opts: E5EmbedderOptions = {}): Embedder {
  const modelId = opts.modelId ?? E5_MODEL_ID;
  const dtype = opts.dtype ?? E5_DTYPE;
  let extractor: Promise<FeatureExtractor> | undefined;
  let cacheDirResolved: string | undefined;
  let hashPromise: Promise<string> | undefined;

  async function defaultLoad(): Promise<FeatureExtractor> {
    const tf = await import("@huggingface/transformers");
    if (opts.offline) tf.env.allowRemoteModels = false;
    cacheDirResolved = tf.env.cacheDir ?? undefined;
    const pipelineFn = tf.pipeline as unknown as (
      task: string,
      model: string,
      options: Record<string, unknown>,
    ) => Promise<FeatureExtractor>;
    return pipelineFn("feature-extraction", modelId, { dtype });
  }

  function load(): Promise<FeatureExtractor> {
    if (!extractor) {
      extractor = (opts.loadPipeline ?? defaultLoad)().catch((err) => {
        extractor = undefined; // pozwól na ponowną próbę
        throw err;
      });
    }
    return extractor;
  }

  return {
    modelId,
    dtype,
    async modelHash(): Promise<string> {
      if (!hashPromise) {
        hashPromise = (async () => {
          await load(); // po załadowaniu plik wag jest w cache
          const file = opts.modelFile ?? (cacheDirResolved ? join(cacheDirResolved, modelId, E5_ONNX_FILE) : undefined);
          if (!file || !existsSync(file)) throw new Error("model file not found");
          return hashFile(file);
        })().catch((err) => {
          hashPromise = undefined;
          throw err;
        });
      }
      return hashPromise;
    },
    async embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const run = await load();
      const prefix = prefixFor(kind);
      const out = await run(
        texts.map((t) => prefix + t),
        { pooling: "mean", normalize: true },
      );
      const n = texts.length;
      const dims = out.dims[out.dims.length - 1] ?? 0;
      if (dims <= 0 || out.data.length !== n * dims) throw new Error("unexpected embedding output shape");
      const vectors: Float32Array[] = [];
      for (let i = 0; i < n; i++) {
        const v = new Float32Array(dims);
        for (let j = 0; j < dims; j++) v[j] = out.data[i * dims + j]!;
        vectors.push(l2normalize(v));
      }
      return vectors;
    },
  };
}
