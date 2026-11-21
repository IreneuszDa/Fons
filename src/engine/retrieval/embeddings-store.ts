/**
 * Format plików z embeddingami korpusu (commitowane do repo, żeby runtime nie liczył ich od nowa):
 *   data/embeddings/<slug>.bin            — Float32 little-endian, wiersz po wierszu (count × dims), L2-znormalizowane
 *   data/embeddings/<slug>.manifest.json  — id rekordów (kolejność wierszy), wymiary, model, hash pliku modelu,
 *                                           identyfikator migawki korpusu, hash pliku .bin
 * Manifest pozwala wykryć wektory z innego modelu / innej migawki i nie mieszać ich z zapytaniami.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const EmbeddingManifest = z.object({
  format: z.literal(1),
  modelId: z.string().min(1),
  modelHash: z.string().min(1),
  dtype: z.string(),
  dims: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  snapshotId: z.string().min(1),
  createdAt: z.string(),
  binFile: z.string().min(1),
  binSha256: z.string().length(64),
  ids: z.array(z.string()),
});
export type EmbeddingManifest = z.infer<typeof EmbeddingManifest>;

/** Wektory w pamięci: macierz count × dims, wiersze w kolejności `ids`. */
export interface EmbeddingMatrix {
  ids: string[];
  dims: number;
  matrix: Float32Array;
}

export function modelSlug(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Katalog data/embeddings w repozytorium (src/engine/retrieval → ../../../data/embeddings). */
export function defaultEmbeddingsDir(): string {
  return fileURLToPath(new URL("../../../data/embeddings/", import.meta.url));
}

export function manifestPathFor(modelId: string, dir: string = defaultEmbeddingsDir()): string {
  return join(dir, `${modelSlug(modelId)}.manifest.json`);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

export function dot(a: Float32Array, aOffset: number, b: Float32Array, dims: number): number {
  let s = 0;
  for (let i = 0; i < dims; i++) s += a[aOffset + i]! * b[i]!;
  return s;
}

function writeFileAtomic(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function floatsToBuffer(vectors: Float32Array[], dims: number): Buffer {
  const out = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((v, row) => {
    if (v.length !== dims) throw new Error(`vector has ${v.length} dims, expected ${dims}`);
    for (let i = 0; i < dims; i++) out.writeFloatLE(v[i]!, (row * dims + i) * 4);
  });
  return out;
}

/** Zapisuje .bin i manifest (atomowo: najpierw .bin, potem manifest). Zwraca manifest. */
export function writeEmbeddingFiles(
  dir: string,
  info: { modelId: string; modelHash: string; dtype: string; snapshotId: string },
  ids: string[],
  vectors: Float32Array[],
  dims: number,
): EmbeddingManifest {
  if (ids.length !== vectors.length) throw new Error("ids/vectors length mismatch");
  const slug = modelSlug(info.modelId);
  const binFile = `${slug}.bin`;
  const bin = floatsToBuffer(vectors, dims);
  const manifest: EmbeddingManifest = {
    format: 1,
    modelId: info.modelId,
    modelHash: info.modelHash,
    dtype: info.dtype,
    dims,
    count: ids.length,
    snapshotId: info.snapshotId,
    createdAt: new Date().toISOString(),
    binFile,
    binSha256: sha256Hex(bin),
    ids,
  };
  writeFileAtomic(join(dir, binFile), bin);
  writeFileAtomic(join(dir, `${slug}.manifest.json`), JSON.stringify(manifest) + "\n");
  return manifest;
}

export class EmbeddingFilesError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "EmbeddingFilesError";
  }
}

export function readManifest(manifestPath: string): EmbeddingManifest {
  if (!existsSync(manifestPath)) throw new EmbeddingFilesError("manifest_missing");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new EmbeddingFilesError("manifest_invalid");
  }
  const parsed = EmbeddingManifest.safeParse(json);
  if (!parsed.success) throw new EmbeddingFilesError("manifest_invalid");
  const m = parsed.data;
  if (m.ids.length !== m.count) throw new EmbeddingFilesError("manifest_invalid");
  return m;
}

/** Wczytuje .bin wskazany przez manifest; sprawdza rozmiar i sumę SHA-256. Wiersze są normalizowane L2 (idempotentnie). */
export function readEmbeddingMatrix(manifestPath: string, manifest: EmbeddingManifest): EmbeddingMatrix {
  const binPath = join(dirname(manifestPath), manifest.binFile);
  if (!existsSync(binPath)) throw new EmbeddingFilesError("bin_missing");
  const buf = readFileSync(binPath);
  if (buf.byteLength !== manifest.count * manifest.dims * 4) throw new EmbeddingFilesError("bin_corrupt");
  if (sha256Hex(buf) !== manifest.binSha256) throw new EmbeddingFilesError("bin_corrupt");
  const matrix = new Float32Array(manifest.count * manifest.dims);
  for (let i = 0; i < matrix.length; i++) matrix[i] = buf.readFloatLE(i * 4);
  for (let row = 0; row < manifest.count; row++) {
    const start = row * manifest.dims;
    const normed = l2normalize(matrix.subarray(start, start + manifest.dims));
    matrix.set(normed, start);
  }
  return { ids: manifest.ids, dims: manifest.dims, matrix };
}
