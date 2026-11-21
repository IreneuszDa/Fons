/**
 * Dziennik działań administratorów: kto (login, rola), co (akcja), na czym (cel), kiedy.
 * Tabela append-only z łańcuchem SHA-256: hash = SHA-256(prev_hash | JSON(ts, actor, role, action, target, detail)).
 * Zmiana lub usunięcie wiersza w środku zrywa łańcuch. Ograniczenie: obcięcie końca dziennika nie jest
 * wykrywalne bez zewnętrznej kotwicy — dlatego verify() zwraca headHash, który można zapisać poza bazą.
 * Nie zapisujemy treści wiadomości użytkowników ani haseł; w `detail` trafiają tylko nazwy pól i statusy.
 */
import type { Db } from "../context";
import { sha256Hex } from "../util";

export const ADMIN_GENESIS = "0".repeat(64);

export interface AdminLogEntry {
  seq: number;
  ts: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  detail: string;
}

export interface AdminLogVerify {
  ok: boolean;
  checked: number;
  headHash: string;
  brokenSeq?: number;
  reason?: string;
}

interface Row extends AdminLogEntry {
  prev_hash: string;
  hash: string;
}

function rowHash(prev: string, r: Pick<AdminLogEntry, "ts" | "actor" | "role" | "action" | "target" | "detail">): string {
  return sha256Hex(`${prev}|${JSON.stringify([r.ts, r.actor, r.role, r.action, r.target, r.detail])}`);
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

export interface AdminLog {
  append(e: { actor: string; role: string; action: string; target?: string; detail?: string }): void;
  list(limit?: number): AdminLogEntry[];
  verify(): AdminLogVerify;
}

export function createAdminLog(db: Db, now: () => Date = () => new Date()): AdminLog {
  const tx = db.transaction((e: Parameters<AdminLog["append"]>[0]) => {
    const last = db.prepare("SELECT hash FROM admin_audit ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const prev = last?.hash ?? ADMIN_GENESIS;
    const row = {
      ts: now().toISOString(),
      actor: clip(e.actor, 80),
      role: clip(e.role, 20),
      action: clip(e.action, 60),
      target: clip(e.target ?? "", 120),
      detail: clip(e.detail ?? "", 300),
    };
    db.prepare(
      "INSERT INTO admin_audit (ts, actor, role, action, target, detail, prev_hash, hash) VALUES (@ts, @actor, @role, @action, @target, @detail, @prev, @hash)",
    ).run({ ...row, prev, hash: rowHash(prev, row) });
  });

  return {
    append: (e) => void tx(e),
    list(limit = 200) {
      const rows = db
        .prepare("SELECT seq, ts, actor, role, action, target, detail FROM admin_audit ORDER BY seq DESC LIMIT ?")
        .all(Math.max(1, Math.min(1000, limit))) as AdminLogEntry[];
      return rows;
    },
    verify() {
      let prev: string | undefined;
      let checked = 0;
      let head = ADMIN_GENESIS;
      for (const r of db.prepare("SELECT * FROM admin_audit ORDER BY seq ASC").iterate() as IterableIterator<Row>) {
        // Dziennik nie podlega retencji, więc pierwszy wiersz musi wskazywać na genesis (usunięcie początku = błąd).
        if (r.prev_hash !== (prev ?? ADMIN_GENESIS)) {
          return { ok: false, checked, headHash: head, brokenSeq: r.seq, reason: "prev_hash_mismatch" };
        }
        if (rowHash(r.prev_hash, r) !== r.hash) {
          return { ok: false, checked, headHash: head, brokenSeq: r.seq, reason: "hash_mismatch" };
        }
        prev = r.hash;
        head = r.hash;
        checked++;
      }
      return { ok: true, checked, headHash: head };
    },
  };
}
