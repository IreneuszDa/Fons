/**
 * Test z prawdziwym modelem multilingual-e5-small. Wymaga sieci przy pierwszym uruchomieniu (pobranie ~120 MB)
 * albo modelu w cache transformers.js, dlatego jest wyłączony domyślnie:
 *   RUN_E5_TESTS=1 npx vitest run src/engine/retrieval/e5.integration.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCorpusStore, ensureCorpusLoaded, openDatabase } from "../../corpus/store";
import { embedCorpus } from "./embed-corpus";
import { createE5Embedder, E5_MODEL_ID } from "./embedder";
import { manifestPathFor } from "./embeddings-store";
import { createVectorBranch } from "./vector";
import { reviewExplanation } from "../reviewed-verdict";
import { claim, createTestDb } from "./test-fixtures";

describe.skipIf(!process.env.RUN_E5_TESTS)("multilingual-e5-small (prawdziwy model)", () => {
  it("od polskich pytań prowadzi do angielskiej publikacji NATO i niemieckiej publikacji dpa", { timeout: 300_000 }, async () => {
    const db = openDatabase(":memory:");
    try {
      ensureCorpusLoaded(db);
      const store = createCorpusStore(db);
      const branch = createVectorBranch(db, { embedder: createE5Embedder({ offline: true }), allowStaleSnapshot: false });
      expect(await branch.warmUp()).toEqual({ available: true });
      for (const [question, variant, source, lang, expected] of [
        ["Na czym polega zasada zbiorowej obrony z artykułu 5 Traktatu Północnoatlantyckiego?", "What is collective defence under Article 5 of the North Atlantic Treaty?", "nato", "en", /collective defence/i],
        ["Czy Unia Europejska może przywrócić karę śmierci w czasie wojny lub powstania?", "", "dpa-factchecking", "de", /Todesstrafe/],
      ] as const) {
        const hits = await branch.search({ claim: claim(question), extraQueries: variant ? [variant] : [], limit: 8 });
        const records = store.getMany(hits.map(h => h.recordId));
        expect(records.some(r => r.sourceId === source && r.lang === lang && expected.test(r.text))).toBe(true);
      }
    } finally { db.close(); }
  });

  it("rezerwuje miejsce dla publikacji zagranicznej i zachowuje rzeczywiste uzasadnienie wydawcy", { timeout: 300_000 }, async () => {
    const db = openDatabase(":memory:");
    try {
      ensureCorpusLoaded(db);
      const store = createCorpusStore(db);
      const branch = createVectorBranch(db);
      const article = store.get("dpa-factchecking:ee8fdefa177f")!;
      const ranked = await branch.search({ claim: claim(article.claimReviewed!), includeSemanticFactCheck: true, limit: 6 });
      expect(ranked.find(c => c.recordId === article.id)?.semanticFactCheck).toBe(true);
      const finding = reviewExplanation(article, article.text, article.claimReviewed);
      expect(finding).toMatch(/^Baerbock bringt den russischen Angriff/u);
      expect(article.text).toBe(article.claimReviewed + "\n" + finding);
      expect(reviewExplanation(article, article.claimReviewed!, article.claimReviewed)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("wyszukuje bliski semantycznie, aktualny fragment urzędowy w prawdziwym korpusie", { timeout: 300_000 }, async () => {
    const db = openDatabase(":memory:");
    try {
      ensureCorpusLoaded(db);
      const store = createCorpusStore(db);
      const branch = createVectorBranch(db);
      const query = { claim: claim("Wojsko Polskie oficjalnie walczy na froncie w Ukrainie."), recentPrimaryOnly: true, limit: 2 };
      const result = await branch.search({ ...query, asOf: "2026-11-22" });
      const passages = store.getMany(result.map(c => c.recordId));
      expect(passages.length).toBeGreaterThan(0);
      expect(passages.every(r => r.level === 1 && r.role === "tresc" && r.publishedAt && r.publishedAt >= "2025-11-22")).toBe(true);
      expect(passages.some(r => r.text.includes("polscy żołnierze nie pojawią się na terytorium Ukrainy"))).toBe(true);
      const old = await branch.search({ ...query, asOf: "2025-01-01" });
      expect(store.getMany(old.map(c => c.recordId)).every(r => r.publishedAt!.slice(0, 10) <= "2025-01-01")).toBe(true);
    } finally {
      db.close();
    }
  });

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
