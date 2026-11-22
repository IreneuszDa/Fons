import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embedCorpus } from "./embed-corpus";
import { createE5Embedder, type Embedder, type FeatureExtractor } from "./embedder";
import { manifestPathFor, readManifest } from "./embeddings-store";
import { rawTokens } from "./fts";
import { createVectorBranch } from "./vector";
import { retrieve } from "./index";
import { claim, createTestDb } from "./test-fixtures";

const DIMS = 64;

/** Deterministyczny „model”: worek słów (prefiksy 5 znaków) zhaszowany do 64 wymiarów, znormalizowany. */
function fakeEmbedder(over: Partial<{ modelId: string; hash: string; failEmbed: boolean; failHash: boolean; dims: number }> = {}) {
  const dims = over.dims ?? DIMS;
  const calls: { kind: string; texts: string[] }[] = [];
  const embedder: Embedder & { calls: typeof calls } = {
    modelId: over.modelId ?? "fake/bow-model",
    dtype: "q8",
    calls,
    async modelHash() {
      if (over.failHash) throw new Error("no model file");
      return over.hash ?? "hash-A";
    },
    async embed(texts, kind) {
      calls.push({ kind, texts });
      if (over.failEmbed) throw new Error("onnx exploded");
      return texts.map((t) => {
        const v = new Float32Array(dims);
        for (const tok of rawTokens(t)) {
          const stem = Array.from(tok).slice(0, 5).join("");
          const h = createHash("md5").update(stem).digest();
          v[h[0]! % dims]! += 1;
          v[h[1]! % dims]! += 0.5;
        }
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return embedder;
}

describe("gałąź wektorowa (fałszywy embedder)", () => {
  let dir: string;
  let manifestPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "retrieval-vec-"));
    manifestPath = manifestPathFor("fake/bow-model", dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function build(db = createTestDb(), embedder = fakeEmbedder()) {
    const manifest = await embedCorpus(db, embedder, { outDir: dir, batchSize: 7 });
    return { db, embedder, manifest };
  }

  it("embed-corpus zapisuje .bin, manifest i lustro w bazie (record_embeddings + corpus_meta)", async () => {
    const { db, manifest } = await build();
    expect(manifest).toMatchObject({ modelId: "fake/bow-model", modelHash: "hash-A", dims: DIMS, count: 20, snapshotId: "snap-1" });
    expect(readManifest(manifestPath).ids).toHaveLength(20);
    expect(readFileSync(join(dir, manifest.binFile)).byteLength).toBe(20 * DIMS * 4);
    expect((db.prepare("SELECT count(*) AS n FROM record_embeddings").get() as { n: number }).n).toBe(20);
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM corpus_meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(meta).toMatchObject({ embedding_model: "fake/bow-model", embedding_model_hash: "hash-A", snapshot_id: "snap-1" });
    const blob = (db.prepare("SELECT vector FROM record_embeddings WHERE record_id = 'r01'").get() as { vector: Buffer }).vector;
    expect(blob.byteLength).toBe(DIMS * 4);
  });

  it("używa prefiksu passage przy indeksowaniu i query przy zapytaniach", async () => {
    const { db, embedder } = await build();
    expect(embedder.calls.every((c) => c.kind === "passage")).toBe(true);
    const branch = createVectorBranch(db, { embedder, manifestPath, minScore: 0 });
    await branch.search({ claim: claim("sankcje") });
    expect(embedder.calls.some((c) => c.kind === "query" && c.texts[0] === "sankcje")).toBe(true);
  });

  it("znajduje semantycznie podobne rekordy (via=vector, malejący wynik)", async () => {
    const { db, embedder } = await build();
    const branch = createVectorBranch(db, { embedder, manifestPath, minScore: 0.2 });
    expect(branch.required).toBe(false);
    const res = await branch.search({ claim: claim("sankcjami objęto Rosję") });
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.via === "vector")).toBe(true);
    expect(["r01", "r02", "r03"]).toContain(res[0]!.recordId);
    for (let i = 1; i < res.length; i++) expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
  });

  it("minScore odcina słabe trafienia, limit ogranicza liczbę wyników", async () => {
    const { db, embedder } = await build();
    const strict = createVectorBranch(db, { embedder, manifestPath, minScore: 0.999 });
    expect(await strict.search({ claim: claim("zupełnie obce słowa xyzzy") })).toEqual([]);
    const loose = createVectorBranch(db, { embedder, manifestPath, minScore: -1 });
    expect(await loose.search({ claim: claim("sankcje"), limit: 3 })).toHaveLength(3);
  });

  it("zachowuje bliskie dopasowania semantyczne od różnych kwalifikowanych wydawców przy pełnej puli", async () => {
    const db = createTestDb();
    db.prepare("UPDATE records SET role = 'stala_rola', level = 2 WHERE id IN ('r07', 'r08')").run();
    db.prepare("UPDATE records SET source_id = 'demagog' WHERE id = 'r07'").run();
    const paraphrase = "Elektroniczne moduły są w zastrzykach";
    const weakerParaphrase = "Do iniekcji dodano układy scalone";
    const embedder = fakeEmbedder();
    embedder.embed = async (texts, kind) => {
      embedder.calls.push({ kind, texts });
      return texts.map((text) => {
        if (kind === "query") {
          if (text === "Luźny temat") return Float32Array.from([0, 1]);
          if (text === weakerParaphrase) return Float32Array.from([Math.cos(-0.15), Math.sin(-0.15)]);
          return Float32Array.from([1, 0]);
        }
        const similarity = text.includes("mikroczipy") ? 0.89 : text.includes("uchodźców") ? 0.885 : 0.95;
        return Float32Array.from([similarity, Math.sqrt(1 - similarity ** 2)]);
      });
    };
    await build(db, embedder);
    const vector = createVectorBranch(db, { embedder, manifestPath });
    const bm25 = {
      id: "bm25", required: true,
      search: async () => [
        { recordId: "r01", score: 2, via: "bm25" as const },
        { recordId: "r02", score: 1, via: "bm25" as const },
      ],
    };
    const query = { claim: claim(paraphrase), limit: 2 };
    expect((await retrieve([bm25, vector], query)).candidates.map((c) => c.recordId)).toEqual(["r01", "r02"]);
    const result = await retrieve([bm25, vector], { ...query, includeSemanticFactCheck: true });
    expect(result.candidates).toMatchObject([
      { recordId: "r01" },
      { recordId: "r07", via: "vector", semanticFactCheck: true },
    ]);
    expect(embedder.calls.filter((c) => c.kind === "query" && c.texts[0] === paraphrase)).toHaveLength(2);

    const withTwo = await retrieve([bm25, vector], { ...query, limit: 3, includeSemanticFactCheck: true });
    expect(withTwo.candidates[0]?.recordId).toBe("r01");
    expect(withTwo.candidates.filter((c) => c.semanticFactCheck).map((c) => c.recordId).sort()).toEqual(["r07", "r08"]);

    const withVariant = await vector.search({ ...query, claim: claim(weakerParaphrase), extraQueries: [paraphrase], includeSemanticFactCheck: true });
    expect(withVariant.find((c) => c.semanticFactCheck)?.recordId).toBe("r07");
    const unrelated = await vector.search({ ...query, claim: claim("Luźny temat"), extraQueries: [paraphrase], includeSemanticFactCheck: true });
    expect(unrelated.every((c) => !c.semanticFactCheck)).toBe(true);
  });

  it("pomija wektory rekordów, których nie ma już w bazie", async () => {
    const { db, embedder } = await build();
    db.prepare("DELETE FROM records WHERE id = 'r01'").run();
    const branch = createVectorBranch(db, { embedder, manifestPath, minScore: -1 });
    const res = await branch.search({ claim: claim("sankcji"), limit: 50 });
    expect(res.map((r) => r.recordId)).not.toContain("r01");
    expect(res).toHaveLength(19);
  });

  it("warmUp weryfikuje indeks i raportuje dostępność", async () => {
    const { db, embedder } = await build();
    const branch = createVectorBranch(db, { embedder, manifestPath });
    expect(branch.status()).toEqual({ available: false, reason: "not_loaded_yet" });
    expect(await branch.warmUp()).toEqual({ available: true });
    expect(branch.status()).toEqual({ available: true });
  });

  describe("niezgodności → gałąź niedostępna (nigdy nie mieszamy wektorów różnych modeli)", () => {
    async function expectUnavailable(branch: ReturnType<typeof createVectorBranch>, reason: string) {
      await expect(branch.search({ claim: claim("sankcje") })).rejects.toMatchObject({ name: "BranchUnavailableError", reason });
      expect(branch.status()).toEqual({ available: false, reason });
    }

    it("brak manifestu", async () => {
      const db = createTestDb();
      await expectUnavailable(createVectorBranch(db, { embedder: fakeEmbedder(), manifestPath }), "manifest_missing");
    });

    it("uszkodzony manifest", async () => {
      const { db, embedder } = await build();
      writeFileSync(manifestPath, "{ nie json");
      await expectUnavailable(createVectorBranch(db, { embedder, manifestPath }), "manifest_invalid");
    });

    it("inny model niż w manifeście", async () => {
      const { db } = await build();
      const other = fakeEmbedder({ modelId: "inny/model" });
      await expectUnavailable(createVectorBranch(db, { embedder: other, manifestPath }), "model_id_mismatch");
      expect(other.calls).toHaveLength(0); // żadnych zapytań do niezgodnego modelu
    });

    it("ten sam model, inny hash pliku modelu", async () => {
      const { db } = await build();
      const other = fakeEmbedder({ hash: "hash-B" });
      await expectUnavailable(createVectorBranch(db, { embedder: other, manifestPath }), "model_hash_mismatch");
      expect(other.calls).toHaveLength(0);
    });

    it("inna migawka korpusu niż w manifeście — przy allowStaleSnapshot=false gałąź niedostępna", async () => {
      const { embedder } = await build();
      const newer = createTestDb({ snapshotId: "snap-2" });
      await expectUnavailable(createVectorBranch(newer, { embedder, manifestPath, allowStaleSnapshot: false }), "snapshot_mismatch");
    });

    it("inna migawka, ten sam model: używa starych wektorów i embeduje tylko brakujące rekordy", async () => {
      const { embedder } = await build();
      const newer = createTestDb({ snapshotId: "snap-2" });
      newer
        .prepare(
          `INSERT INTO records (id, source_id, url, title, publisher, published_at, fetched_at, lang, text, role, type, level,
             independence_group, licence, claim_reviewed, rating_json, topics_json, period, origin)
           VALUES ('r21', 'src', 'https://example.org/r21', 'Szwecja w NATO', 'Test', '2024-03-07', '2025-01-01', 'pl',
             'Szwecja przystąpiła do Sojuszu Północnoatlantyckiego.', 'tresc', 'pierwotne', 1, 'g', 'CC0', NULL, NULL, '[]', NULL, 'corpus')`,
        )
        .run();
      const before = embedder.calls.length;
      const branch = createVectorBranch(newer, { embedder, manifestPath, minScore: -1 });
      expect(await branch.warmUp()).toEqual({ available: true, reason: "snapshot_stale_filled" });
      const passageCalls = embedder.calls.slice(before).filter((c) => c.kind === "passage");
      expect(passageCalls.flatMap((c) => c.texts)).toHaveLength(1); // tylko nowy rekord r21
      const res = await branch.search({ claim: claim("Szwecja przystąpiła do Sojuszu Północnoatlantyckiego"), limit: 3 });
      expect(res[0]?.recordId).toBe("r21");
    });

    it("inna migawka i za dużo brakujących rekordów → niedostępna", async () => {
      const { embedder } = await build();
      const newer = createTestDb({ snapshotId: "snap-2" });
      newer.exec("DELETE FROM records");
      newer.prepare("INSERT INTO records (id, title, text) VALUES ('x1','a','b'),('x2','c','d')").run();
      await expectUnavailable(createVectorBranch(newer, { embedder, manifestPath, maxFill: 1 }), "snapshot_mismatch");
    });

    it("brak snapshot_id w corpus_meta", async () => {
      const { embedder } = await build();
      const bare = createTestDb({ snapshotId: null });
      await expectUnavailable(createVectorBranch(bare, { embedder, manifestPath }), "snapshot_unknown");
    });

    it("corpus_meta wskazuje inny model lub hash niż manifest", async () => {
      const { db, embedder } = await build();
      db.prepare("INSERT OR REPLACE INTO corpus_meta (key, value) VALUES ('embedding_model', 'stary/model')").run();
      await expectUnavailable(createVectorBranch(db, { embedder, manifestPath }), "corpus_model_mismatch");
      db.prepare("INSERT OR REPLACE INTO corpus_meta (key, value) VALUES ('embedding_model', 'fake/bow-model')").run();
      db.prepare("INSERT OR REPLACE INTO corpus_meta (key, value) VALUES ('embedding_model_hash', 'zly')").run();
      await expectUnavailable(createVectorBranch(db, { embedder, manifestPath }), "corpus_hash_mismatch");
    });

    it("uszkodzony plik .bin", async () => {
      const { db, embedder, manifest } = await build();
      const binPath = join(dir, manifest.binFile);
      const bin = readFileSync(binPath);
      bin[10] = bin[10]! ^ 0xff;
      writeFileSync(binPath, bin);
      await expectUnavailable(createVectorBranch(db, { embedder, manifestPath }), "bin_corrupt");
    });

    it("niezgodne wymiary modelu i indeksu", async () => {
      const { db } = await build();
      await expectUnavailable(createVectorBranch(db, { embedder: fakeEmbedder({ dims: 32 }), manifestPath }), "dims_mismatch");
    });

    it("modelu nie da się załadować (hash lub embed rzuca)", async () => {
      const { db } = await build();
      await expectUnavailable(createVectorBranch(db, { embedder: fakeEmbedder({ failHash: true }), manifestPath }), "model_unavailable");
      await expectUnavailable(createVectorBranch(db, { embedder: fakeEmbedder({ failEmbed: true }), manifestPath }), "model_unavailable");
    });

    it("po niepowodzeniu ponawia próbę dopiero po retryAfterMs i wraca do działania", async () => {
      const db = createTestDb();
      const embedder = fakeEmbedder();
      let t = 1000;
      const branch = createVectorBranch(db, { embedder, manifestPath, retryAfterMs: 5000, now: () => t, minScore: -1 });
      await expect(branch.search({ claim: claim("sankcje") })).rejects.toMatchObject({ reason: "manifest_missing" });
      await build(db, embedder); // pojawia się poprawny indeks
      t += 1000;
      await expect(branch.search({ claim: claim("sankcje") })).rejects.toMatchObject({ reason: "manifest_missing" }); // jeszcze w oknie
      t += 5000;
      await expect(branch.search({ claim: claim("sankcje") })).resolves.not.toHaveLength(0);
      expect(branch.status()).toEqual({ available: true });
    });

    it("retrieve() oznacza niedostępną gałąź wektorową i zachowuje wyniki BM25 (bez requiredFailed)", async () => {
      const db = createTestDb();
      const vector = createVectorBranch(db, { embedder: fakeEmbedder(), manifestPath }); // brak manifestu
      const { createBm25Branch } = await import("./bm25");
      const res = await retrieve([createBm25Branch(db), vector], { claim: claim("sankcje Rosja") });
      expect(res.unavailable).toEqual(["vector"]);
      expect(res.requiredFailed).toBe(false);
      expect(res.candidates.length).toBeGreaterThan(0);
      expect(res.candidates.every((c) => c.via === "bm25")).toBe(true);
    });
  });
});

describe("embedder E5 (wstrzyknięty potok)", () => {
  it("dodaje prefiksy query:/passage:, żąda mean pooling + normalize i dzieli wynik na wiersze", async () => {
    const seen: { texts: string[]; options: unknown }[] = [];
    const extractor: FeatureExtractor = async (texts, options) => {
      seen.push({ texts, options });
      return { data: Float32Array.from(texts.flatMap((_, i) => [3 * (i + 1), 4 * (i + 1), 0])), dims: [texts.length, 3] };
    };
    const e = createE5Embedder({ loadPipeline: async () => extractor, modelFile: "/nonexistent" });
    expect(e.modelId).toBe("Xenova/multilingual-e5-small");
    const q = await e.embed(["a", "b"], "query");
    const p = await e.embed(["c"], "passage");
    expect(seen[0]).toEqual({ texts: ["query: a", "query: b"], options: { pooling: "mean", normalize: true } });
    expect(seen[1]!.texts).toEqual(["passage: c"]);
    expect(q).toHaveLength(2);
    expect(Array.from(q[1]!)).toEqual([0.6000000238418579, 0.800000011920929, 0]);
    expect(p).toHaveLength(1);
    expect(await e.embed([], "query")).toEqual([]);
  });

  it("ponawia ładowanie potoku po błędzie, a brak pliku modelu daje błąd hasha", async () => {
    let n = 0;
    const e = createE5Embedder({
      loadPipeline: async () => {
        if (++n === 1) throw new Error("offline");
        return async (t) => ({ data: new Float32Array(t.length * 2).fill(1), dims: [t.length, 2] });
      },
      modelFile: "/nonexistent/model.onnx",
    });
    await expect(e.embed(["x"], "query")).rejects.toThrow("offline");
    await expect(e.embed(["x"], "query")).resolves.toHaveLength(1);
    await expect(e.modelHash()).rejects.toThrow("model file not found");
  });

  it("hashuje plik modelu (SHA-256)", async () => {
    const d = mkdtempSync(join(tmpdir(), "retrieval-hash-"));
    try {
      const f = join(d, "m.onnx");
      writeFileSync(f, "abc");
      const e = createE5Embedder({ loadPipeline: async () => async () => ({ data: [], dims: [0, 1] }), modelFile: f });
      expect(await e.modelHash()).toBe(createHash("sha256").update("abc").digest("hex"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
