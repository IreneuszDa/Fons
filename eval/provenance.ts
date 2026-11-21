/**
 * Provenance of an eval run: which commit produced the numbers and whether the working tree had uncommitted
 * changes. Stored in result meta so a published figure can be tied to a commit (and a dirty run is visible).
 * Paths written into results are made repo-relative, so result files carry no machine layout or user names.
 */
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, relative } from "node:path";

export interface GitProvenance {
  /** `git rev-parse HEAD`, or "no-git" (no repository, no commits yet, git missing). */
  gitSha: string;
  /** true when `git status --porcelain` lists anything; null when unknown. */
  gitDirty: boolean | null;
}

type Exec = (args: string[]) => string;

const defaultExec =
  (cwd: string): Exec =>
  (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });

export function gitProvenance(cwd = process.cwd(), exec: Exec = defaultExec(cwd)): GitProvenance {
  let gitSha = "no-git";
  try {
    const sha = exec(["rev-parse", "HEAD"]).trim();
    if (/^[0-9a-f]{7,64}$/.test(sha)) gitSha = sha;
  } catch {
    /* no repository or no commits yet */
  }
  let gitDirty: boolean | null = null;
  try {
    gitDirty = exec(["status", "--porcelain"]).trim().length > 0;
  } catch {
    /* git unavailable */
  }
  return { gitSha, gitDirty };
}

/** Path safe to publish: relative to the repo when inside it, otherwise only the file name. */
export function displayPath(p: string, root = process.cwd()): string {
  const rel = relative(root, p);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  return `<poza repozytorium>/${basename(p)}`;
}

/** One line for reports: "abc1234 (niezatwierdzone zmiany)". */
export function provenanceLabel(p: Partial<GitProvenance>): string {
  if (!p.gitSha) return "nieznany (wynik sprzed zapisu commita)";
  const sha = p.gitSha === "no-git" ? "brak commita" : p.gitSha.slice(0, 12);
  const dirty = p.gitDirty === true ? " (niezatwierdzone zmiany w drzewie roboczym)" : p.gitDirty === null ? " (stan drzewa nieznany)" : "";
  return `${sha}${dirty}`;
}
