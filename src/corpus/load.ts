/**
 * npm run corpus:load — ładuje data/corpus/*.jsonl i data/incidents/*.jsonl do bazy SQLite
 * (ścieżka z loadConfig().dbPath) i wypisuje liczby rekordów wg źródła i typu.
 */
import { loadConfig } from "../server/config";
import { ensureCorpusLoaded, openDatabase } from "./store";

export function main(): void {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  const t0 = Date.now();
  const res = ensureCorpusLoaded(db);
  console.log(`Baza: ${cfg.dbPath}`);
  console.log(`Migawka korpusu: ${res.snapshotId}`);
  console.log(`Rekordów: ${res.records} (${Date.now() - t0} ms)`);
  const bySource = db.prepare("SELECT source_id AS k, COUNT(*) AS n FROM records GROUP BY source_id ORDER BY n DESC").all() as { k: string; n: number }[];
  const byType = db.prepare("SELECT type AS k, COUNT(*) AS n FROM records GROUP BY type ORDER BY n DESC").all() as { k: string; n: number }[];
  const byRole = db.prepare("SELECT role AS k, COUNT(*) AS n FROM records GROUP BY role").all() as { k: string; n: number }[];
  const incidents = (db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n;
  console.log("\nWg źródła:");
  for (const r of bySource) console.log(`  ${r.k.padEnd(20)} ${r.n}`);
  console.log("\nWg typu:");
  for (const r of byType) console.log(`  ${r.k.padEnd(20)} ${r.n}`);
  console.log("\nWg roli:");
  for (const r of byRole) console.log(`  ${r.k.padEnd(20)} ${r.n}`);
  console.log(`\nIncydentów: ${incidents}`);
  db.close();
}

const isMain = process.argv[1] && /load\.(ts|js)$/.test(process.argv[1]);
if (isMain) main();
