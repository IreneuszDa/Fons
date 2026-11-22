import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { loadConfig } from "../server/config";
import { createEngineDeps, verifyInput, type EngineDeps } from "./verify";

describe("klub parlamentarny w rejestrze Sejmu i imiennej liście głosowania", () => {
  const db = openDatabase(":memory:");
  let deps: EngineDeps;
  const now = new Date("2026-11-23T12:00:00Z");
  beforeAll(() => {
    ensureCorpusLoaded(db);
    deps = { ...createEngineDeps(db, loadConfig({dbPath: ":memory:", liveSearch: false})), now: () => now };
  });
  afterAll(() => db.close());

  it.each([
    ["Czy Mateusz Morawiecki należy do klubu PiS?", "WPROWADZAJACE", 4, ["PiS", "RozwojPlus"]],
    ["Czy Mateusz Morawiecki należy do klubu Rozwój Plus?", "POTWIERDZONE", 7, ["RozwojPlus"]],
    ["Czy Mateusz Morawiecki należy do klubu Lewica?", "FALSZYWE", 8, ["RozwojPlus"]],
    ["Czy Ryszard Petru należy do klubu Polska 2050?", "WPROWADZAJACE", 4, ["Polska2050", "Centrum"]],
    ["Czy Joanna Mucha należy do klubu Polska 2050?", "WPROWADZAJACE", 4, ["Polska2050", "niezrzeszon"]],
    ["Czy Marcin Horała nie należy do klubu PiS?", "POTWIERDZONE", 7, ["RozwojPlus"]],
  ] as const)("%s", async (text, verdict, rule, clubs) => {
    const report = await verifyInput({channel: "eval", kind: "text", text, receivedAt: now.toISOString()}, deps);
    expect(report.mainVerdict).toBe(verdict);
    expect(report.models).toHaveLength(0);
    const main = report.verdicts[0]!;
    expect(main.ruleApplied).toBe(rule);
    expect(main.evidence).toHaveLength(clubs.length);
    main.evidence.forEach((e, i) => {
      expect(e.usedForVerdict).toBe(true);
      expect(e.quote).toContain(clubs[i]);
      expect(deps.store.get(e.recordId)?.text).toContain(e.quote);
      expect(new URL(e.url).host).toBe("api.sejm.gov.pl");
    });
    if (rule === 4) expect(main.evidence[0]!.quote).toContain("2025-11-05");
  });
});
