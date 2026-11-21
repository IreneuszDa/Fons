import { VerdictReport } from "../shared/contracts";
import type { Db } from "./context";

export const REPORT_RETENTION_MS = 30 * 86_400_000;
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function saveReport(
  db: Db,
  report: VerdictReport,
  owner: { senderId: string; sessionId?: string },
  now: Date,
): void {
  db.prepare(
    `INSERT INTO reports (token, report_id, sender_id, session_id, report_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.token,
    report.id,
    owner.senderId,
    owner.sessionId ?? null,
    JSON.stringify(report),
    now.toISOString(),
    new Date(now.getTime() + REPORT_RETENTION_MS).toISOString(),
  );
}

export function getReportByToken(db: Db, token: string, now: Date): VerdictReport | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  const row = db.prepare("SELECT report_json, expires_at FROM reports WHERE token = ?").get(token) as
    | { report_json: string; expires_at: string }
    | undefined;
  if (!row || row.expires_at <= now.toISOString()) return undefined;
  try {
    return VerdictReport.parse(JSON.parse(row.report_json));
  } catch {
    return undefined;
  }
}

/** Raport tylko jeśli należy do danego nadawcy (do „źródła”/„dlaczego”/„zgłoś”). */
export function getReportForSender(db: Db, token: string, senderId: string, now: Date): VerdictReport | undefined {
  const row = db.prepare("SELECT report_json, expires_at FROM reports WHERE token = ? AND sender_id = ?").get(token, senderId) as
    | { report_json: string; expires_at: string }
    | undefined;
  if (!row || row.expires_at <= now.toISOString()) return undefined;
  try {
    return VerdictReport.parse(JSON.parse(row.report_json));
  } catch {
    return undefined;
  }
}
