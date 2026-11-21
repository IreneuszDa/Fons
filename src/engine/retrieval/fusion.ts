import type { EvidenceCandidate, RetrievalVia } from "../../shared/contracts";

export const RRF_K = 60;

/** Zachowuje oznaczone dopasowania w limicie i zostawia pierwsze miejsce zwykłemu rankingowi. */
export function limitWithSemanticFactChecks(ranked: EvidenceCandidate[], limit: number): EvidenceCandidate[] {
  const out = ranked.slice(0, limit);
  for (const candidate of ranked.slice(limit)) {
    if (!candidate.semanticFactCheck) continue;
    const replace = out.findLastIndex((entry) => !entry.semanticFactCheck);
    if (replace <= 0) break;
    out.splice(replace, 1);
    out.push(candidate);
  }
  return out;
}

/** Przy remisie rangi „najlepsza” ścieżka to ta bardziej informatywna (incydent → treść → wektory → reszta). */
const VIA_PRIORITY: Record<RetrievalVia, number> = { incident: 0, bm25: 1, vector: 2, connector: 3, live: 4 };

interface Acc {
  recordId: string;
  rrf: number;
  bestRank: number;
  via: RetrievalVia;
  semanticFactCheck?: true;
}

/**
 * Reciprocal Rank Fusion. Każda lista jest porządkowana malejąco po `score` (stabilnie), ranga zaczyna się od 1.
 * Wynik rekordu = Σ 1/(k + ranga) po gałęziach; duplikaty w obrębie jednej gałęzi liczą się raz (najlepsza ranga).
 * `via` rekordu = ścieżka, w której rekord miał najlepszą rangę. Zwraca posortowane malejąco po wyniku RRF.
 * Opcjonalne `weights[i]` mnoży wkład listy i (domyślnie 1).
 */
export function reciprocalRankFusion(lists: EvidenceCandidate[][], k: number = RRF_K, weights?: number[]): EvidenceCandidate[] {
  const acc = new Map<string, Acc>();
  for (const [li, list] of lists.entries()) {
    const w = weights?.[li] ?? 1;
    const ordered = list
      .filter((c) => c && typeof c.recordId === "string" && c.recordId !== "" && Number.isFinite(c.score))
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.score - a.c.score || a.i - b.i);
    const seenInList = new Set<string>();
    let rank = 0;
    for (const { c } of ordered) {
      if (seenInList.has(c.recordId)) continue;
      seenInList.add(c.recordId);
      rank++;
      const contribution = w / (k + rank);
      const cur = acc.get(c.recordId);
      if (!cur) {
        acc.set(c.recordId, { recordId: c.recordId, rrf: contribution, bestRank: rank, via: c.via, semanticFactCheck: c.semanticFactCheck });
        continue;
      }
      cur.rrf += contribution;
      if (c.semanticFactCheck) cur.semanticFactCheck = true;
      if (rank < cur.bestRank || (rank === cur.bestRank && VIA_PRIORITY[c.via] < VIA_PRIORITY[cur.via])) {
        cur.bestRank = rank;
        cur.via = c.via;
      }
    }
  }
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf || a.bestRank - b.bestRank || (a.recordId < b.recordId ? -1 : 1))
    .map((a) => ({ recordId: a.recordId, score: a.rrf, via: a.via, ...(a.semanticFactCheck ? { semanticFactCheck: true as const } : {}) }));
}

/** Wagi gałęzi w fuzji (po `via` pierwszego kandydata listy). Dobrane na zbiorze dev (docs/QUALITY-LOG.md). */
export const VIA_WEIGHTS: Record<RetrievalVia, number> = { bm25: 1, vector: 1, incident: 0.5, connector: 1, live: 0.8 };

export function weightsFor(lists: EvidenceCandidate[][]): number[] {
  return lists.map((l) => (l[0] ? VIA_WEIGHTS[l[0].via] ?? 1 : 1));
}
