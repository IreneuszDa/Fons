/**
 * Fingerprint of the case files a result was produced from (hash + case ids per file).
 * Stored in result meta (`meta.caseSet`) so that rendering a result against a changed case file is detected.
 * Pure helpers; the files are only hashed, never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES_DIR, SUITE_FILES, parseCasesJsonl, type Suite } from "./cases";

export interface CaseFileFingerprint {
  sha256: string;
  count: number;
  ids: string[];
}
export type CaseSetFingerprint = Record<string, CaseFileFingerprint>;

export function fingerprintFile(path: string): CaseFileFingerprint {
  const raw = readFileSync(path);
  const ids = parseCasesJsonl(raw.toString("utf8"), path).map((c) => c.id);
  return { sha256: createHash("sha256").update(raw).digest("hex"), count: ids.length, ids };
}

/** Files that make up a run: the separate case file (heldout-v2) or the suite's files. */
export function caseFilesFor(suite: Suite, caseFile?: string): string[] {
  return caseFile ? [caseFile] : SUITE_FILES[suite];
}

export function fingerprintCaseFiles(files: string[], dir = CASES_DIR): CaseSetFingerprint {
  const out: CaseSetFingerprint = {};
  for (const f of files) {
    try {
      out[f] = fingerprintFile(join(dir, f));
    } catch {
      /* missing/unreadable file: left out, reported as "removed" by the comparison */
    }
  }
  return out;
}

/** Polish warnings for every file whose current hash/ids differ from the saved fingerprint (empty = unchanged). */
export function compareCaseSets(saved: CaseSetFingerprint | undefined, current: CaseSetFingerprint): string[] {
  if (!saved) return [];
  const warnings: string[] = [];
  for (const [file, was] of Object.entries(saved)) {
    const now = current[file];
    if (!now) {
      warnings.push(`plik przypadków ${file} nie istnieje lub nie daje się odczytać (wynik powstał z ${was.count} przypadków)`);
      continue;
    }
    if (now.sha256 === was.sha256) continue;
    const cur = new Set(now.ids);
    const old = new Set(was.ids);
    const removed = was.ids.filter((i) => !cur.has(i));
    const added = now.ids.filter((i) => !old.has(i));
    warnings.push(
      `plik przypadków ${file} zmienił się od czasu uruchomienia (${was.count} → ${now.count} przypadków; usunięte: ${removed.length ? removed.join(", ") : "brak"}; dodane: ${added.length ? added.join(", ") : "brak"}) — oczekiwane odpowiedzi w raporcie pochodzą z NOWEJ wersji pliku`,
    );
  }
  return warnings;
}
