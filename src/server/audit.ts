/**
 * Dziennik audytu przebiegów: tabela append-only z łańcuchem SHA-256 (PLAN §3 krok 9).
 *
 * hash = SHA-256(prev_hash | JSON(pola nieosobowe + personal_digest)).
 * personal_digest = SHA-256(sól | JSON(zamaskowane wejście, nadawca, sesja, id rekordów)).
 * „Usuń moje dane” zeruje pola osobowe i sól (erased=1) — wiersz i skróty zostają, więc łańcuch
 * nadal się weryfikuje, a po usuniętej treści nie zostaje ślad możliwy do odgadnięcia.
 */
import { randomBytes } from "node:crypto";
import type { ModelUsage } from "../shared/contracts";
import type { Db } from "./context";
import { sha256Hex } from "./util";

export const GENESIS_HASH = "0".repeat(64);

export interface RunInput {
  requestId: string;
  createdAt: string;
  channel: string;
  inputKind: string;
  inputMasked: string;
  senderId?: string;
  sessionId?: string;
  status: string;
  verdict: string | null;
  recordIds: string[];
  models: ModelUsage[];
  timingsMs: Record<string, number>;
  costUsd: number;
  latencyMs: number;
  cacheHit: boolean;
  securityEventCount: number;
  unavailable: string[];
  pipelineVersion: string;
  snapshotId: string;
}

interface RunRow {
  seq: number;
  request_id: string;
  created_at: string;
  channel: string;
  input_kind: string;
  status: string;
  verdict: string | null;
  models_json: string;
  timings_json: string;
  cost_usd: number;
  latency_ms: number;
  cache_hit: number;
  security_event_count: number;
  unavailable_json: string;
  pipeline_version: string;
  snapshot_id: string;
  input_masked: string;
  sender_id: string | null;
  session_id: string | null;
  record_ids_json: string;
  salt: string;
  erased: number;
  personal_digest: string;
  prev_hash: string;
  hash: string;
}

function personalDigest(salt: string, r: { input: string; sender: string | null; session: string | null; recordIds: string }): string {
  return sha256Hex(`${salt}|${JSON.stringify([r.input, r.sender, r.session, r.recordIds])}`);
}

function rowHash(prev: string, r: RunRow): string {
  const fields = [
    r.request_id, r.created_at, r.channel, r.input_kind, r.status, r.verdict, r.models_json, r.timings_json,
    r.cost_usd, r.latency_ms, r.cache_hit, r.security_event_count, r.unavailable_json, r.pipeline_version,
    r.snapshot_id, r.personal_digest,
  ];
  return sha256Hex(`${prev}|${JSON.stringify(fields)}`);
}

/** Dopisuje przebieg do dziennika. Zwraca skrót nowego wiersza. */
export function appendRun(db: Db, input: RunInput): string {
  const tx = db.transaction((): string => {
    const last = db.prepare("SELECT hash FROM runs ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const prev = last?.hash ?? GENESIS_HASH;
    const salt = randomBytes(16).toString("hex");
    const recordIdsJson = JSON.stringify(input.recordIds);
    const row: RunRow = {
      seq: 0,
      request_id: input.requestId,
      created_at: input.createdAt,
      channel: input.channel,
      input_kind: input.inputKind,
      status: input.status,
      verdict: input.verdict,
      models_json: JSON.stringify(input.models),
      timings_json: JSON.stringify(input.timingsMs),
      cost_usd: input.costUsd,
      latency_ms: Math.round(input.latencyMs),
      cache_hit: input.cacheHit ? 1 : 0,
      security_event_count: input.securityEventCount,
      unavailable_json: JSON.stringify(input.unavailable),
      pipeline_version: input.pipelineVersion,
      snapshot_id: input.snapshotId,
      input_masked: input.inputMasked,
      sender_id: input.senderId ?? null,
      session_id: input.sessionId ?? null,
      record_ids_json: recordIdsJson,
      salt,
      erased: 0,
      personal_digest: "",
      prev_hash: prev,
      hash: "",
    };
    row.personal_digest = personalDigest(salt, {
      input: row.input_masked,
      sender: row.sender_id,
      session: row.session_id,
      recordIds: recordIdsJson,
    });
    row.hash = rowHash(prev, row);
    const { seq: _seq, ...params } = row;
    db.prepare(
      `INSERT INTO runs (request_id, created_at, channel, input_kind, status, verdict, models_json, timings_json,
        cost_usd, latency_ms, cache_hit, security_event_count, unavailable_json, pipeline_version, snapshot_id,
        input_masked, sender_id, session_id, record_ids_json, salt, erased, personal_digest, prev_hash, hash)
       VALUES (@request_id, @created_at, @channel, @input_kind, @status, @verdict, @models_json, @timings_json,
        @cost_usd, @latency_ms, @cache_hit, @security_event_count, @unavailable_json, @pipeline_version, @snapshot_id,
        @input_masked, @sender_id, @session_id, @record_ids_json, @salt, @erased, @personal_digest, @prev_hash, @hash)`,
    ).run(params);
    return row.hash;
  });
  return tx();
}

export interface ChainResult {
  ok: boolean;
  checked: number;
  brokenSeq?: number;
  reason?: string;
}

/**
 * Sprawdza łańcuch: ciągłość prev_hash → hash oraz zgodność treści z zapisanymi skrótami.
 * Pierwszy wiersz w tabeli jest kotwicą (retencja usuwa najstarsze wiersze).
 * Ograniczenie: obcięcie końca dziennika nie jest wykrywalne bez zewnętrznej kotwicy.
 */
export function verifyChain(db: Db): ChainResult {
  const rows = db.prepare("SELECT * FROM runs ORDER BY seq ASC").iterate() as IterableIterator<RunRow>;
  let prevHash: string | undefined;
  let checked = 0;
  for (const r of rows) {
    if (prevHash !== undefined && r.prev_hash !== prevHash) {
      return { ok: false, checked, brokenSeq: r.seq, reason: "prev_hash_mismatch" };
    }
    if (!r.erased) {
      const pd = personalDigest(r.salt, {
        input: r.input_masked,
        sender: r.sender_id,
        session: r.session_id,
        recordIds: r.record_ids_json,
      });
      if (pd !== r.personal_digest) return { ok: false, checked, brokenSeq: r.seq, reason: "personal_digest_mismatch" };
    }
    if (rowHash(r.prev_hash, r) !== r.hash) return { ok: false, checked, brokenSeq: r.seq, reason: "hash_mismatch" };
    prevHash = r.hash;
    checked++;
  }
  return { ok: true, checked };
}

/** Czyści pola osobowe przebiegów nadawcy (wiersze i skróty zostają — patrz nagłówek pliku). */
export function eraseRunsForSender(db: Db, senderId: string): number {
  return db
    .prepare(
      `UPDATE runs SET input_masked = '', sender_id = NULL, session_id = NULL, record_ids_json = '[]',
         salt = '', erased = 1 WHERE sender_id = ? AND erased = 0`,
    )
    .run(senderId).changes;
}
