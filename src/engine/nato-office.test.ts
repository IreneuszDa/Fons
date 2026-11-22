import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openDatabase, ensureCorpusLoaded } from "../corpus/store";
import { loadConfig } from "../server/config";
import { NATO_SECRETARIES_URL } from "../corpus/ingest/nato-office-list";
import { currentNatoOfficeQuestion } from "./nato-office";
import { createEngineDeps, verifyInput, type EngineDeps } from "./verify";

describe("oficjalny wykaz sekretarzy generalnych NATO", () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-11-23T12:00:00Z");
  let deps: EngineDeps;
  beforeAll(() => {
    ensureCorpusLoaded(db);
    deps = { ...createEngineDeps(db, loadConfig({dbPath: ":memory:", liveSearch: false})), now: () => now };
  });
  afterAll(() => db.close());
  it.each([
    ["Kto jest sekretarzem generalnym NATO?", null, 0, "Mark Rutte"],
    ["Sekretarzem generalnym NATO jest Jens Stoltenberg.", "WPROWADZAJACE", 4, "2014–2024"],
    ["Czy Anders Fogh Rasmussen jest obecnie sekretarzem generalnym NATO?", "WPROWADZAJACE", 4, "2009–2014"],
    ["Javier Solana pełni funkcję sekretarza generalnego NATO.", "WPROWADZAJACE", 4, "1995–1999"],
    ["Czy funkcję sekretarza generalnego NATO pełni teraz Mark Rutte?", "POTWIERDZONE", 7, "Mark Rutte"],
    ["Mark Rutte nie jest sekretarzem generalnym NATO.", "FALSZYWE", 8, "Mark Rutte"],
    ["Javier Solana nie jest sekretarzem generalnym NATO.", "POTWIERDZONE", 7, "Mark Rutte"],
    ["Czy Emmanuel Macron jest sekretarzem generalnym NATO?", "FALSZYWE", 8, "Mark Rutte"],
  ] as const)("%s", async (text, expected, rule, value) => {
    const result = await verifyInput({channel: "eval", kind: "text", text, receivedAt: now.toISOString()}, deps);
    expect(result.status).toBe("OK");
    expect(result.mainVerdict).toBe(expected);
    expect(result.models).toHaveLength(0);
    const verdict = result.verdicts[0];
    expect(verdict?.ruleApplied ?? 0).toBe(rule);
    expect(verdict?.reasonPl ?? result.answer?.answerPl).toContain(value);
    const evidence = verdict?.evidence ?? result.answer!.evidence;
    expect(evidence).toHaveLength(rule === 4 ? 2 : 1);
    for (const item of evidence) {
      expect(item.url).toBe(NATO_SECRETARIES_URL);
      expect(deps.store.get(item.recordId)?.text).toContain(item.quote);
    }
  });
  it("zostawia daty, inne funkcje i warunki do osobnego sprawdzenia", () => {
    for (const text of [
      "Czy Mark Rutte jest zastępcą sekretarza generalnego NATO?",
      "Kto był sekretarzem generalnym NATO w 2011 roku?",
      "Jens Stoltenberg był sekretarzem generalnym NATO.",
      "Czy Mark Rutte jest sekretarzem generalnym NATO od 2022 roku?",
      "Czy Mark Rutte zostanie sekretarzem generalnym NATO?",
      "Sekretarzem generalnym NATO jest albo Mark Rutte, albo inny polityk.",
    ]) expect(currentNatoOfficeQuestion(text)).toBeUndefined();
  });
});
