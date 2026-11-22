/**
 * Uruchomienie weryfikacji dla klienta MCP: ta sama ścieżka co kanał WWW (verifyInput), plus zabezpieczenia
 * serwera, o ile istnieją jego tabele: dobowy bezpiecznik budżetu tokenów, zapis raportu pod własnym tokenem
 * (strona /w/{token}), dziennik audytu i zdarzenia bezpieczeństwa. Każdy zapis jest „best effort” — jego awaria
 * nie psuje odpowiedzi (raport zwracamy bez resultUrl i mówimy o tym wprost).
 *
 * Pomija cache obliczeń i pętlę informacji (sprawy moderatora): MCP to kanał dla analityków, nie obywateli.
 */
import { maskPii, pseudonymize } from "../security/pii";
import { PIPELINE_VERSION, verifyInput, type EngineDeps, type VerifyRequest } from "../engine/verify";
import { runWithLiveScope, withLiveUsage } from "../engine/retrieval/live";
import { reportEvidence, VerdictReport } from "../shared/contracts";
import type { AppConfig } from "../server/config";
import { appendRun } from "../server/audit";
import { addTokens, budgetExceeded } from "../server/budget";
import { migrate } from "../server/db";
import { saveReport } from "../server/reports";
import { newRequestId, newToken } from "../server/util";
import type { Database } from "better-sqlite3";

export type McpCfg = Pick<AppConfig, "publicBaseUrl" | "userIdPepper" | "dailyTokenBudget">;

export interface McpVerifyOutcome {
  report: VerdictReport;
  /** Adres strony wyniku; undefined, gdy raportu nie udało się zapisać. */
  resultUrl?: string;
  persisted: boolean;
}

export interface McpVerifyOptions {
  db: Database;
  deps: EngineDeps;
  cfg: McpCfg;
  principalId: string;
  /** Zamiennik wywołania silnika (atrapa w testach albo opakowanie serwera z cache). */
  verify?: (req: VerifyRequest) => Promise<VerdictReport>;
  now?: () => Date;
}

export function resultUrlFor(cfg: Pick<AppConfig, "publicBaseUrl">, token: string): string {
  return `${cfg.publicBaseUrl.replace(/\/+$/, "")}/w/${token}`;
}

export class McpBudgetError extends Error {
  constructor() {
    super("budget");
    this.name = "McpBudgetError";
  }
}

/** Tworzy tabele serwera (idempotentnie), jeśli ich jeszcze nie ma. Nigdy nie rzuca. */
export function ensureServerTables(db: Database): boolean {
  try {
    migrate(db);
    return true;
  } catch {
    return false;
  }
}

export async function verifyForMcp(
  input: { text?: string; url?: string },
  opts: McpVerifyOptions,
): Promise<McpVerifyOutcome> {
  const now = opts.now ?? (() => new Date());
  const t0 = performance.now();
  const started = now();
  const req: VerifyRequest = input.url
    ? { kind: "url", url: input.url, channel: "mcp", receivedAt: started.toISOString() }
    : { kind: "text", text: input.text ?? "", channel: "mcp", receivedAt: started.toISOString() };

  let tablesOk = true;
  try {
    if (budgetExceeded(opts.db, opts.cfg, started)) throw new McpBudgetError();
  } catch (e) {
    if (e instanceof McpBudgetError) throw e;
    tablesOk = false; // brak tabeli token_usage: bezpiecznik niedostępny, ale nie blokujemy
  }

  const requestId = newRequestId();
  // Zakres przebiegu: koszt wyszukiwania na żywo trafia do report.models/costUsd (i do bezpiecznika tokenów).
  const raw = await runWithLiveScope({ requestId }, async () =>
    withLiveUsage(await (opts.verify ?? ((r) => verifyInput(r, opts.deps)))(req)),
  );
  const parsed = VerdictReport.parse(raw);
  const report: VerdictReport = {
    ...parsed,
    id: requestId,
    token: newToken(),
    createdAt: started.toISOString(),
    cacheHit: false,
    moderatorCase: undefined,
  };
  if (report.status !== "OK") {
    report.mainVerdict = null; // status techniczny nigdy nie jest werdyktem
    report.verdicts = [];
  }

  let persisted = false;
  const senderId = pseudonymize(`mcp:${opts.principalId}`, opts.cfg.userIdPepper);
  if (tablesOk) {
    try {
      saveReport(opts.db, report, { senderId }, started);
      persisted = true;
    } catch {
      persisted = false;
    }
    try {
      appendRun(opts.db, {
        requestId,
        createdAt: started.toISOString(),
        channel: "mcp",
        inputKind: req.kind,
        inputMasked: report.inputEchoMasked.slice(0, 1000),
        senderId,
        status: report.status,
        verdict: report.mainVerdict,
        recordIds: reportEvidence(report).map(e => e.recordId),
        models: report.models,
        timingsMs: report.timingsMs,
        costUsd: report.costUsd,
        latencyMs: performance.now() - t0,
        cacheHit: false,
        securityEventCount: report.securityEvents.length,
        unavailable: report.unavailableBranches,
        pipelineVersion: PIPELINE_VERSION,
        snapshotId: report.corpusSnapshot,
      });
    } catch {
      /* dziennik niedostępny — nie psuje odpowiedzi */
    }
    try {
      const ins = opts.db.prepare(
        `INSERT INTO security_events (request_id, sender_id, session_id, created_at, source, location, record_id, pattern, excerpt, severity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ev of report.securityEvents) {
        ins.run(requestId, senderId, null, started.toISOString(), "mcp", ev.location, ev.recordId ?? null, ev.pattern, maskPii(ev.excerpt).text, ev.severity);
      }
    } catch {
      /* jw. */
    }
    try {
      addTokens(opts.db, started, report.models.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0));
    } catch {
      /* jw. */
    }
  }
  return { report, ...(persisted ? { resultUrl: resultUrlFor(opts.cfg, report.token) } : {}), persisted };
}
