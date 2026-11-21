import { describe, expect, it, vi } from "vitest";
import type { EvidenceCandidate, RetrievalBranch, RetrievalQuery } from "../../shared/contracts";
import { createBm25Branch } from "./bm25";
import { reciprocalRankFusion } from "./fusion";
import { createRetrievalBranches, retrieve, warmUp } from "./index";
import { claim, createTestDb } from "./test-fixtures";

function fake(
  id: string,
  required: boolean,
  impl: (q: RetrievalQuery) => Promise<EvidenceCandidate[]> | EvidenceCandidate[],
): RetrievalBranch {
  return { id, required, search: async (q) => impl(q) };
}
const c = (recordId: string, score: number, via: EvidenceCandidate["via"]): EvidenceCandidate => ({ recordId, score, via });
const q: RetrievalQuery = { claim: claim("cokolwiek") };

describe("reciprocalRankFusion", () => {
  it("sumuje 1/(60+ranga) po gałęziach i porządkuje malejąco", () => {
    const fused = reciprocalRankFusion([
      [c("a", 9, "bm25"), c("b", 8, "bm25"), c("c", 7, "bm25")],
      [c("c", 0.9, "vector"), c("a", 0.8, "vector"), c("d", 0.7, "vector")],
    ]);
    expect(fused.map((x) => x.recordId)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[1]!.score).toBeCloseTo(1 / 63 + 1 / 61, 10);
  });

  it("porządkuje wewnątrz gałęzi po score, nie po kolejności tablicy", () => {
    const fused = reciprocalRankFusion([[c("x", 1, "bm25"), c("y", 5, "bm25")]]);
    expect(fused.map((r) => r.recordId)).toEqual(["y", "x"]);
  });

  it("dedupe po recordId zachowuje via z najlepszą rangą; przy remisie preferuje incident > bm25 > vector", () => {
    const fused = reciprocalRankFusion([
      [c("z", 1, "bm25"), c("a", 0.5, "bm25")],
      [c("a", 1, "vector")],
      [c("a", 3, "incident")],
    ]);
    const a = fused.find((r) => r.recordId === "a")!;
    expect(a.via).toBe("incident"); // ranga 1 w incident i vector → incident wygrywa remis
    expect(fused.filter((r) => r.recordId === "a")).toHaveLength(1);
    expect(fused.find((r) => r.recordId === "z")!.via).toBe("bm25");
  });

  it("duplikaty w obrębie jednej gałęzi liczą się raz", () => {
    const fused = reciprocalRankFusion([[c("a", 3, "bm25"), c("a", 2, "bm25"), c("b", 1, "bm25")]]);
    expect(fused.map((r) => r.recordId)).toEqual(["a", "b"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 10);
    expect(fused[1]!.score).toBeCloseTo(1 / 62, 10);
  });

  it("ignoruje niepoprawnych kandydatów", () => {
    const fused = reciprocalRankFusion([[c("", 1, "bm25"), c("a", NaN, "bm25"), c("b", 1, "bm25")]]);
    expect(fused.map((r) => r.recordId)).toEqual(["b"]);
  });
});

describe("retrieve()", () => {
  it("reports completed, inapplicable and failed lookups before fusion", async () => {
    const onBranchResult = vi.fn();
    const hit = c("A", 5, "bm25");
    await retrieve([
      fake("bm25", true, () => [hit]),
      fake("official", false, query => { query.onCoverage?.("skipped"); return []; }),
      fake("incident", false, () => []),
      fake("live", false, () => { throw new Error("provider failed"); }),
    ], q, { onBranchResult });
    expect(onBranchResult.mock.calls).toEqual([
      ["bm25", "completed", [hit]],
      ["official", "skipped", []],
      ["incident", "completed", []],
      ["live", "unavailable", []],
    ]);
  });

  it("łączy gałęzie, zwraca via najlepszej ścieżki i nie zgłasza awarii", async () => {
    const res = await retrieve(
      [
        fake("bm25", true, () => [c("a", 5, "bm25"), c("b", 4, "bm25")]),
        fake("vector", false, () => [c("b", 0.95, "vector"), c("c", 0.9, "vector")]),
      ],
      q,
    );
    expect(res.unavailable).toEqual([]);
    expect(res.requiredFailed).toBe(false);
    expect(res.candidates.map((x) => x.recordId)).toEqual(["b", "a", "c"]);
    expect(res.candidates.find((x) => x.recordId === "b")!.via).toBe("vector");
  });

  it("ogranicza liczbę wyników (domyślnie 24, opcja maxResults, q.limit)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => c(`r${i}`, 100 - i, "bm25"));
    const branches = [fake("bm25", true, () => many)];
    expect((await retrieve(branches, q)).candidates).toHaveLength(24);
    expect((await retrieve(branches, q, { maxResults: 5 })).candidates).toHaveLength(5);
    expect((await retrieve(branches, { ...q, limit: 7 })).candidates).toHaveLength(7);
  });

  it("przekroczenie limitu czasu oznacza gałąź opcjonalną jako niedostępną, reszta działa", async () => {
    let sawAbort = false;
    const slow = fake("vector", false, (qq) =>
      new Promise<EvidenceCandidate[]>((resolve) => {
        qq.signal?.addEventListener("abort", () => (sawAbort = true));
        setTimeout(() => resolve([c("zzz", 1, "vector")]), 500);
      }),
    );
    const t0 = Date.now();
    const res = await retrieve([fake("bm25", true, () => [c("a", 1, "bm25")]), slow], q, { perBranchTimeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(res.unavailable).toEqual(["vector"]);
    expect(res.requiredFailed).toBe(false);
    expect(res.candidates.map((x) => x.recordId)).toEqual(["a"]);
    expect(sawAbort).toBe(true);
  });

  it("limit czasu dotyczy każdej gałęzi osobno, a gałęzie działają równolegle", async () => {
    const delay = (ms: number, id: string) => fake(id, false, () => new Promise((r) => setTimeout(() => r([c(id, 1, "bm25")]), ms)));
    const t0 = Date.now();
    const res = await retrieve([delay(80, "x"), delay(80, "y"), delay(80, "z")], q, { perBranchTimeoutMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(220); // równolegle, nie 240 ms
    expect(res.unavailable).toEqual([]);
    expect(res.candidates).toHaveLength(3);
  });

  it("wyjątek gałęzi opcjonalnej → niedostępna; gałęzi koniecznej → requiredFailed", async () => {
    const boom = () => {
      throw new Error("SQLITE_ERROR: tajny szczegół");
    };
    const optional = await retrieve([fake("bm25", true, () => [c("a", 1, "bm25")]), fake("incident", false, boom)], q);
    expect(optional.unavailable).toEqual(["incident"]);
    expect(optional.requiredFailed).toBe(false);

    const required = await retrieve([fake("bm25", true, boom), fake("vector", false, () => [c("v", 1, "vector")])], q);
    expect(required.unavailable).toEqual(["bm25"]);
    expect(required.requiredFailed).toBe(true);
    expect(required.candidates.map((x) => x.recordId)).toEqual(["v"]); // wyniki opcjonalne są nadal zwracane
  });

  it("limit czasu gałęzi koniecznej → requiredFailed", async () => {
    const hang = fake("bm25", true, () => new Promise<EvidenceCandidate[]>(() => {}));
    const res = await retrieve([hang], q, { perBranchTimeoutMs: 30 });
    expect(res.unavailable).toEqual(["bm25"]);
    expect(res.requiredFailed).toBe(true);
    expect(res.candidates).toEqual([]);
  });

  it("brak gałęzi albo awaria wszystkich gałęzi → requiredFailed", async () => {
    expect((await retrieve([], q)).requiredFailed).toBe(true);
    const all = await retrieve(
      [fake("a", false, () => Promise.reject(new Error("x"))), fake("b", false, () => Promise.reject(new Error("y")))],
      q,
    );
    expect(all.unavailable).toEqual(["a", "b"]);
    expect(all.requiredFailed).toBe(true);
  });

  it("pusty wynik gałęzi to nie awaria", async () => {
    const res = await retrieve([fake("bm25", true, () => [])], q);
    expect(res).toEqual({ candidates: [], unavailable: [], requiredFailed: false });
  });

  it("sygnał wywołującego przerywa gałęzie", async () => {
    const ac = new AbortController();
    const hang = fake("vector", false, (qq) => new Promise<EvidenceCandidate[]>((_, rej) => qq.signal!.addEventListener("abort", () => rej(new Error("abort")))));
    const p = retrieve([hang], { ...q, signal: ac.signal }, { perBranchTimeoutMs: 5000 });
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    const res = await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.unavailable).toEqual(["vector"]);
  });

  it("działa end-to-end na bazie SQLite z BM25", async () => {
    const db = createTestDb();
    const res = await retrieve([createBm25Branch(db)], { claim: claim("Unia nałożyła nowe sankcje na Rosję") });
    expect(res.requiredFailed).toBe(false);
    expect(res.candidates[0]!.recordId).toMatch(/^r0[123]$/);
    expect(res.candidates.every((x) => x.via === "bm25")).toBe(true);
  });
});

describe("createRetrievalBranches", () => {
  const db = createTestDb();

  it("liveSearch=false → gałąź live nie jest tworzona", () => {
    const ids = createRetrievalBranches(db, { liveSearch: false }).map((b) => b.id);
    expect(ids).toEqual(["bm25", "vector", "incident"]);
  });

  it("liveSearch=true bez dostawcy → gałąź live istnieje i zgłasza niedostępność", async () => {
    const branches = createRetrievalBranches(db, { liveSearch: true, vector: false });
    expect(branches.map((b) => b.id)).toEqual(["bm25", "incident", "official", "live"]);
    const res = await retrieve(branches, { claim: claim("sankcje Rosja") });
    expect(res.unavailable).toEqual(["live"]);
    expect(res.requiredFailed).toBe(false);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it("gałęzie mają właściwe flagi required", () => {
    const b = Object.fromEntries(createRetrievalBranches(db, { liveSearch: true }).map((x) => [x.id, x.required]));
    expect(b).toEqual({ bm25: true, vector: false, incident: false, official: false, live: false });
  });

  it("warmUp nie rzuca i raportuje stan gałęzi wektorowej (brak manifestu → niedostępna)", async () => {
    const branches = createRetrievalBranches(db, { liveSearch: false, manifestPath: "/nonexistent/x.manifest.json", embedder: stubEmbedder() });
    const status = await warmUp(branches);
    expect(status).toEqual({ vector: { available: false, reason: "manifest_missing" } });
  });
});

function stubEmbedder() {
  return {
    modelId: "stub/model",
    dtype: "q8",
    modelHash: async () => "h",
    embed: async (t: string[]) => t.map(() => new Float32Array([1, 0])),
  };
}
