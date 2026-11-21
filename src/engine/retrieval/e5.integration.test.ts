/**
 * Test z prawdziwym modelem multilingual-e5-small. Wymaga sieci przy pierwszym uruchomieniu (pobranie ~120 MB)
 * albo modelu w cache transformers.js, dlatego jest wyłączony domyślnie:
 *   RUN_E5_TESTS=1 npx vitest run src/engine/retrieval/e5.integration.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { embedCorpus } from "./embed-corpus";
import { createE5Embedder, E5_MODEL_ID } from "./embedder";
import { manifestPathFor } from "./embeddings-store";
import { createVectorBranch } from "./vector";
import { claim, createTestDb } from "./test-fixtures";

describe.skipIf(!process.env.RUN_E5_TESTS)("multilingual-e5-small (prawdziwy model)", () => {
  it("indeksuje, weryfikuje hash i znajduje polskie odmiany semantycznie", { timeout: 300_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-e5-"));
    try {
      const db = createTestDb();
      const embedder = createE5Embedder();
      const manifest = await embedCorpus(db, embedder, { outDir: dir });
      expect(manifest.modelId).toBe(E5_MODEL_ID);
      expect(manifest.dims).toBe(384);
      expect(manifest.modelHash).toMatch(/^[0-9a-f]{64}$/);

      const branch = createVectorBranch(db, { embedder, manifestPath: manifestPathFor(E5_MODEL_ID, dir), minScore: 0 });
      expect(await branch.warmUp()).toEqual({ available: true });

      const res = await branch.search({ claim: claim("Czy w szczepionkach są mikroczipy do inwigilacji?"), limit: 5 });
      expect(res.map((r) => r.recordId)).toContain("r07");
      const top = await branch.search({ claim: claim("Jak wzrosło PKB Polski w zeszłym roku?"), limit: 3 });
      expect(top.map((r) => r.recordId)).toContain("r05");
      if (process.env.E5_DEBUG) console.log(res.map((r) => `${r.recordId}:${r.score.toFixed(3)}`), top.map((r) => `${r.recordId}:${r.score.toFixed(3)}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
