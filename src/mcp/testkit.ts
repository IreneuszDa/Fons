/** Wspólne atrapy do testów serwera MCP (bez sieci i bez klucza). Nie jest używane w kodzie produkcyjnym. */
import type { Database } from "better-sqlite3";
import { createBm25Branch } from "../engine/retrieval/bm25";
import { createCorpusStore } from "../corpus/store";
import { FakeLlmProvider } from "../engine/llm/fake";
import { createTestDb } from "../engine/retrieval/test-fixtures";
import type { EngineDeps, VerifyRequest } from "../engine/verify";
import { VerdictReport } from "../shared/contracts";
import type { McpCfg } from "./runner";

export const TEST_CFG: McpCfg = {
  publicBaseUrl: "https://fons.test",
  userIdPepper: "test-pepper",
  dailyTokenBudget: 1_000_000,
};

export function makeTestDeps(db: Database): EngineDeps {
  const llm = new FakeLlmProvider();
  return {
    llm,
    verifier: llm,
    singleKey: true,
    store: createCorpusStore(db),
    db,
    branches: [createBm25Branch(db)],
    fetchPage: (async () => {
      throw new Error("no fetch");
    }) as never,
    now: () => new Date("2026-11-21T12:00:00Z"),
    verdictMode: "rules",
  };
}

export function makeTestDb(): Database {
  return createTestDb();
}

export function fakeReport(over: Partial<VerdictReport> = {}): VerdictReport {
  return VerdictReport.parse({
    id: "req_stub",
    token: "stubtoken0000000000000",
    createdAt: "2026-11-21T12:00:00.000Z",
    pipelineVersion: "test",
    corpusSnapshot: "snap-1",
    verdictMode: "rules",
    status: "OK",
    inputKind: "text",
    inputEchoMasked: "PKB Polski wzrósł w 2024 roku o 2,9 proc.",
    claims: [
      { id: "c1", text: "PKB Polski wzrósł w 2024 roku o 2,9 proc.", type: "fakt", isMain: true, temporal: { kind: "jednorazowe" }, inputOverlap: 1 },
    ],
    verdicts: [
      {
        claimId: "c1",
        verdict: "POTWIERDZONE",
        ruleApplied: 7,
        strength: {
          level: "mocna",
          primarySources: 1,
          independentPublishers: 1,
          newestEvidenceAt: "2025-01-01",
          archivalWarning: false,
          verifierAgreement: "zgoda",
          notes: [],
        },
        reasonPl: "Źródło urzędowe potwierdza twierdzenie.",
        evidence: [
          {
            recordId: "r05",
            title: "PKB Polski w 2024 roku",
            publisher: "GUS",
            publishedAt: "2025-01-01",
            fetchedAt: "2025-02-01",
            url: "https://example.org/r05",
            quote: "Produkt krajowy brutto Polski wzrósł w 2024 roku o 2,9 proc.",
            relation: "WSPIERA",
            aspect: "sedno",
            sourceType: "pierwotne",
            level: 1,
            role: "tresc",
            group: "wspierajace",
          },
        ],
      },
    ],
    mainVerdict: "POTWIERDZONE",
    summaryPl: "Twierdzenie jest potwierdzone przez źródło urzędowe.",
    warnings: [],
    transparencyPl: "Kod sprawdził obecność cytatu w źródle z katalogu.",
    models: [{ purpose: "assess", provider: "fake", model: "fake", inputTokens: 100, outputTokens: 20, latencyMs: 5, costUsd: 0 }],
    timingsMs: { total: 10 },
    costUsd: 0,
    unavailableBranches: [],
    ...over,
  });
}

export function stubVerify(report: VerdictReport = fakeReport()): ((req: VerifyRequest) => Promise<VerdictReport>) & { calls: VerifyRequest[] } {
  const calls: VerifyRequest[] = [];
  const fn = async (req: VerifyRequest) => {
    calls.push(req);
    return report;
  };
  return Object.assign(fn, { calls });
}
