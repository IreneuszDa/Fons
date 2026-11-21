import { describe, expect, it } from "vitest";
import { displayPath, gitProvenance, provenanceLabel } from "./provenance";

describe("gitProvenance", () => {
  it("reads sha and dirty flag", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const p = gitProvenance("/repo", (args) => (args[0] === "rev-parse" ? `${sha}\n` : " M README.md\n"));
    expect(p).toEqual({ gitSha: sha, gitDirty: true });
  });

  it("clean tree", () => {
    const p = gitProvenance("/repo", (args) => (args[0] === "rev-parse" ? "abcdef1\n" : ""));
    expect(p).toEqual({ gitSha: "abcdef1", gitDirty: false });
  });

  it("no commits yet / no git → no-git, dirty unknown", () => {
    const p = gitProvenance("/repo", () => {
      throw new Error("fatal: your current branch does not have any commits yet");
    });
    expect(p).toEqual({ gitSha: "no-git", gitDirty: null });
  });

  it("garbage output is not taken as a sha", () => {
    const p = gitProvenance("/repo", (args) => (args[0] === "rev-parse" ? "HEAD\n" : ""));
    expect(p.gitSha).toBe("no-git");
  });
});

describe("displayPath", () => {
  it("repo-relative inside the repo", () => {
    expect(displayPath("/home/someone/Fons/var/eval.db", "/home/someone/Fons")).toBe("var/eval.db");
  });
  it("outside the repo only the file name", () => {
    expect(displayPath("/tmp/x/eval-real.db", "/home/someone/Fons")).toBe("<poza repozytorium>/eval-real.db");
  });
});

describe("provenanceLabel", () => {
  it("formats", () => {
    expect(provenanceLabel({})).toMatch(/nieznany/);
    expect(provenanceLabel({ gitSha: "no-git", gitDirty: null })).toMatch(/brak commita/);
    expect(provenanceLabel({ gitSha: "0123456789abcdef", gitDirty: true })).toBe("0123456789ab (niezatwierdzone zmiany w drzewie roboczym)");
    expect(provenanceLabel({ gitSha: "0123456789abcdef", gitDirty: false })).toBe("0123456789ab");
  });
});
