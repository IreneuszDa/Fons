/** Validates the evaluation data itself: schema, coverage requirements, twins, canaries and fixtures. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedInputMode, fixtureFileFor, fixturePath, loadBenignTexts, loadSuite, parseCasesJsonl, type EvalCaseX } from "./cases";
import { canaryKey } from "./metrics";

const main = loadSuite("main");
const red = loadSuite("redteam");
const demo = loadSuite("demo");
const all = [...main, ...red, ...demo];
const byId = new Map(all.map((c) => [c.id, c]));
const v = (c: EvalCaseX) => c.expected.verdict;
const has = (c: EvalCaseX, tag: string) => c.tags?.includes(tag) ?? false;

describe("main suite (dev + heldout)", () => {
  it("has ≥ 70 cases with unique ids and a ~55/45 split", () => {
    expect(main.length).toBeGreaterThanOrEqual(70);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    const dev = main.filter((c) => c.split === "dev").length / main.length;
    expect(dev).toBeGreaterThan(0.5);
    expect(dev).toBeLessThan(0.65);
  });

  it("covers every scenario except the optional F, plus X", () => {
    const sc = new Set(main.map((c) => c.scenario));
    for (const s of ["A", "B", "C", "D", "E", "G", "H", "I", "J", "X"]) expect(sc, s).toContain(s);
  });

  it("meets the per-class and per-kind minimums", () => {
    const count = (f: (c: EvalCaseX) => boolean) => main.filter(f).length;
    expect(count((c) => v(c) === "WPROWADZAJACE")).toBeGreaterThanOrEqual(10);
    expect(count((c) => v(c) === "WPROWADZAJACE" && has(c, "outdated"))).toBeGreaterThanOrEqual(4);
    expect(count((c) => v(c) === "WPROWADZAJACE" && has(c, "wrong_context"))).toBeGreaterThanOrEqual(3);
    expect(count((c) => has(c, "negation"))).toBeGreaterThanOrEqual(5);
    expect(count((c) => c.scenario === "D" && v(c) === "BRAK_DOWODOW")).toBeGreaterThanOrEqual(8);
    expect(count((c) => v(c) === "NIE_PODLEGA")).toBeGreaterThanOrEqual(6);
    expect(count((c) => c.scenario === "C")).toBeGreaterThanOrEqual(4);
    expect(count((c) => c.scenario === "I")).toBeGreaterThanOrEqual(4);
    expect(count((c) => c.scenario === "J" && !!c.fault)).toBeGreaterThanOrEqual(4);
    for (const cls of ["POTWIERDZONE", "FALSZYWE", "WPROWADZAJACE", "BRAK_DOWODOW", "NIE_PODLEGA"]) {
      expect(main.filter((c) => c.split === "heldout" && v(c) === cls).length, `heldout ${cls}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("every case has notes with the real-world basis", () => {
    for (const c of main) expect((c.notes ?? "").length, c.id).toBeGreaterThan(15);
  });

  it("status-only expectations never carry a verdict; faults use the known fault names", () => {
    for (const c of main) {
      const answerMode = (c.expected.answerContains?.length ?? 0) > 0;
      if (c.expected.status !== "OK" || answerMode) expect(v(c), c.id).toBeNull();
      else expect(v(c), c.id).not.toBeNull();
      if (c.fault) expect(["llm_down", "corpus_down", "live_down", "ocr_down"]).toContain(c.fault);
    }
  });

  it("repeat groups (H) have at least two cases each", () => {
    const groups = new Map<string, number>();
    for (const c of main) if (c.checks?.repeatGroup) groups.set(c.checks.repeatGroup, (groups.get(c.checks.repeatGroup) ?? 0) + 1);
    expect(groups.size).toBeGreaterThanOrEqual(1);
    for (const [g, n] of groups) expect(n, g).toBeGreaterThanOrEqual(2);
  });
});

describe("new case families (politicians, links, rated claims)", () => {
  const fam = (tag: string) => main.filter((c) => has(c, tag));
  const isNew = (c: EvalCaseX) => /^[PLR]\d\d$/.test(c.id);

  it("≥ 10 politician/official questions, yes/no and open, each verified against an official page with a date", () => {
    const qs = main.filter((c) => /^P\d\d$/.test(c.id));
    expect(qs.length).toBeGreaterThanOrEqual(10);
    expect(qs.filter((c) => expectedInputMode(c) === "question_yesno").length).toBeGreaterThanOrEqual(4);
    expect(qs.filter((c) => expectedInputMode(c) === "question_open").length).toBeGreaterThanOrEqual(4);
    for (const c of qs) {
      expect(c.expected.inputMode, c.id).toBeDefined();
      expect(c.notes, c.id).toMatch(/Sprawdzone 20\d\d-\d\d-\d\d/);
      expect(c.notes, c.id).toMatch(/https:\/\/[^ ]*(gov\.pl|sejm\.gov\.pl|senat\.gov\.pl|prezydent\.pl|nato\.int|europa\.eu)/);
    }
  });

  it("open questions carry answer fragments and no verdict; other cases carry no fragments", () => {
    for (const c of main) {
      const open = expectedInputMode(c) === "question_open";
      if (open) {
        expect(c.expected.answerContains?.length, c.id).toBeGreaterThan(0);
        for (const f of c.expected.answerContains!) expect(f.trim().length, c.id).toBeGreaterThan(3);
      } else expect(c.expected.answerContains, c.id).toBeUndefined();
    }
  });

  it("≥ 8 link cases: real official URLs served from snapshots and disinformation pages on the fixture host", () => {
    const links = fam("link");
    expect(links.length).toBeGreaterThanOrEqual(8);
    const official = links.filter((c) => has(c, "official_link"));
    const disinfo = links.filter((c) => has(c, "disinfo_page"));
    expect(official.length).toBeGreaterThanOrEqual(4);
    expect(disinfo.length).toBeGreaterThanOrEqual(3);
    for (const c of official) {
      expect(new URL(c.input.url!).hostname, c.id).toMatch(/(^|\.)(gov\.pl|nato\.int|europa\.eu)$/);
      expect(c.checks?.fixture, c.id).toMatch(/^official_/);
    }
    for (const c of disinfo) {
      expect(new URL(c.input.url!).hostname, c.id).toBe("fixture.prawdowid.test");
      expect(v(c), c.id).toBe("FALSZYWE");
    }
    expect(links.filter((c) => c.input.text).length).toBeGreaterThanOrEqual(6); // question/claim + link
  });

  it("≥ 4 statements rated by IFCN/EFCSN fact-checkers, citing the rated record", () => {
    const rated = main.filter((c) => /^R\d\d$/.test(c.id));
    expect(rated.length).toBeGreaterThanOrEqual(4);
    for (const c of rated) {
      expect(has(c, "rated_claim"), c.id).toBe(true);
      expect(c.notes, c.id).toMatch(/FactCheck\.org|PolitiFact|dpa|DW/);
    }
  });

  it("new cases keep an honest dev/heldout split (~55/45) and every class stays in heldout", () => {
    const fresh = main.filter(isNew);
    const dev = fresh.filter((c) => c.split === "dev").length / fresh.length;
    expect(dev).toBeGreaterThanOrEqual(0.5);
    expect(dev).toBeLessThanOrEqual(0.6);
    expect(fresh.filter((c) => c.split === "heldout" && expectedInputMode(c) === "question_open").length).toBeGreaterThanOrEqual(2);
  });
});

describe("demo suite", () => {
  it("has 10 demo cases in story order, all dev, never duplicated into dev/heldout ids", () => {
    expect(demo).toHaveLength(10);
    for (const c of demo) {
      expect(c.demo, c.id).toBe(true);
      expect(c.split, c.id).toBe("dev");
      expect((c.notes ?? "").length, c.id).toBeGreaterThan(15);
    }
    const kinds = demo.map((c) => {
      if (c.expected.attack) return "injection";
      if (c.input.kind === "url") return has(c, "disinfo_page") ? "link_disinfo" : "link_official";
      const m = expectedInputMode(c);
      if (m !== "claim") return m;
      return v(c);
    });
    expect(kinds).toEqual([
      "question_open",
      "question_yesno",
      "POTWIERDZONE",
      "FALSZYWE",
      "WPROWADZAJACE",
      "BRAK_DOWODOW",
      "NIE_PODLEGA",
      "link_official",
      "link_disinfo",
      "injection",
    ]);
    const atk = demo[9]!;
    expect(demo.find((c) => c.id === atk.expected.attack!.twinCaseId)?.expected.attack).toBeUndefined();
  });
});

describe("red-team suite", () => {
  const attacks = red.filter((c) => c.expected.attack);

  it("has ≥ 40 attacks, each with goal, twin and the twin's verdict", () => {
    expect(attacks.length).toBeGreaterThanOrEqual(40);
    for (const a of attacks) {
      const twin = byId.get(a.expected.attack!.twinCaseId ?? "");
      expect(twin, a.id).toBeDefined();
      expect(twin!.expected.attack, `${a.id} twin must be clean`).toBeUndefined();
      expect(v(a), a.id).toBe(v(twin!));
    }
  });

  it("main-suite and demo E cases also reference existing clean twins", () => {
    for (const c of [...main, ...demo].filter((x) => x.expected.attack)) {
      const twin = byId.get(c.expected.attack!.twinCaseId ?? "");
      expect(twin, c.id).toBeDefined();
      expect(v(c)).toBe(v(twin!));
    }
  });

  it("canaries are unique and (except link canaries that must be in the payload) not literally in the input", () => {
    const withCanary = all.filter((c) => c.expected.attack?.canary);
    const keys = withCanary.map((c) => canaryKey(c.expected.attack!.canary!));
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of withCanary) {
      if (c.expected.attack!.canary === "phish.example") continue;
      const key = canaryKey(c.expected.attack!.canary!);
      const inputText = c.input.text ?? readFileSync(fixturePath(fixtureFileFor(c.input.url!, c)!), "utf8");
      expect(canaryKey(inputText).includes(key), `${c.id} canary appears literally`).toBe(false);
    }
  });

  it("covers the required payload locations and techniques", () => {
    const notes = attacks.map((a) => a.notes ?? "").join("\n");
    for (const loc of ["user_message", "fetched_page:hidden_display_none", "fetched_page:hidden_white_text", "fetched_page:img_alt", "fetched_page:meta", "fetched_page:html_comment", "fetched_page:base64", "fetched_page:zero_width", "fetched_page:homoglyph", "fetched_page:ru", "fetched_page:aria_hidden", "fetched_page:quote_bait", "fetched_page:split", "fetched_page:delimiter", "fetched_page:json_closing", "fetched_page:router_intent", "fetched_page:link", "fetched_page:prompt_leak"]) {
      expect(notes, loc).toContain(`[${loc}]`);
    }
    const goals = new Set(attacks.map((a) => a.expected.attack!.goal));
    for (const g of ["verdict_flip", "canary", "side_effect", "link", "prompt_leak", "suppress_log"]) expect(goals, g).toContain(g);
    const texts = attacks.map((a) => a.input.text ?? "").join("\n");
    expect(texts).toMatch(/[Ѐ-ӿ]/); // RU/UA
    expect(texts).toContain("​"); // zero-width
    expect(texts).toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // base64
  });
});

describe("fixtures", () => {
  it("every URL case resolves to an existing fixture page", () => {
    for (const c of all.filter((x) => x.input.kind === "url")) {
      const f = fixtureFileFor(c.input.url!, c);
      expect(f, c.id).toBeDefined();
      expect(existsSync(fixturePath(f!)), `${c.id} → ${f}`).toBe(true);
    }
  });

  it("has ≥ 30 benign texts, including debunks quoting imperative disinformation", () => {
    const benign = loadBenignTexts();
    expect(benign.length).toBeGreaterThanOrEqual(30);
    expect(benign.filter((b) => /debunk/.test(b.id)).length).toBeGreaterThanOrEqual(8);
  });
});

describe("selection", () => {
  it("--ids filters after --split", async () => {
    const { selectCases } = await import("./cases");
    expect(selectCases(main, { split: "all", ids: ["P01", "P02", "nope"] }).map((c) => c.id)).toEqual(["P01", "P02"]);
    expect(selectCases(main, { split: "dev", ids: ["P01", "P02"] }).map((c) => c.id)).toEqual(["P01"]);
  });
});

describe("parser", () => {
  it("reports the line number of invalid entries", () => {
    expect(() => parseCasesJsonl('{"id":"x"}\n', "f.jsonl")).toThrow(/f\.jsonl:1/);
    expect(() => parseCasesJsonl("\n{bad", "g.jsonl")).toThrow(/g\.jsonl:2: niepoprawny JSON/);
  });
});
