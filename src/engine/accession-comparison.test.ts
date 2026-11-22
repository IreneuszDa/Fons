import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCorpusLoaded, openDatabase } from "../corpus/store";
import { loadConfig } from "../server/config";
import { accessionComparison, accessionEntry } from "./accession-comparison";
import { createEngineDeps, verifyInput, type EngineDeps } from "./verify";

describe("porównanie dat akcesji w opublikowanych wykazach UE i NATO", () => {
  const db = openDatabase(":memory:");
  const now = new Date("2026-11-23T00:00:00Z");
  let deps: EngineDeps;
  beforeAll(() => {
    ensureCorpusLoaded(db);
    deps = { ...createEngineDeps(db, loadConfig({ dbPath: ":memory:", liveSearch: false })), now: () => now };
  });
  afterAll(() => db.close());

  it.each([
    ["Estonia i Łotwa wprowadziły euro w tym samym roku.", "FALSZYWE", ["2011", "2014"]],
    ["Czy Malta i Cypr w tym samym roku przyjęły euro?", "POTWIERDZONE", ["2008", "2008"]],
    ["Portugalia i Francja przystąpiły do UE w różnych latach.", "POTWIERDZONE", ["1986", "1958"]],
    ["Polska oraz Węgry przystąpiły do NATO w tym samym roku.", "POTWIERDZONE", ["1999", "1999"]],
    ["Estonia i Łotwa weszły do strefy Schengen w różnych latach.", "FALSZYWE", ["2007", "2007"]],
  ] as const)("%s", async (text, verdict, years) => {
    const report = await verifyInput({ text, channel: "eval", kind: "text", receivedAt: now.toISOString() }, deps);
    expect(report.mainVerdict).toBe(verdict);
    expect(report.models).toHaveLength(0);
    const evidence = report.verdicts[0]!.evidence;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]!.recordId).not.toBe(evidence[1]!.recordId);
    evidence.forEach((e, i) => {
      expect(e.quote).toContain(years[i]);
      expect(deps.store.get(e.recordId)?.text).toContain(e.quote);
      expect(e.usedForVerdict).toBe(true);
    });
  });

  it.each([
    ["Litwa, Łotwa i Estonia przystąpiły do NATO w 2004 roku.", "POTWIERDZONE", [2004, 2004, 2004], ["WSPIERA", "WSPIERA", "WSPIERA"]],
    ["Polska i Litwa wstąpiły do NATO w 1999 roku.", "WPROWADZAJACE", [1999, 2004], ["WSPIERA", "OBALA"]],
    ["Polska weszła do strefy Schengen razem z przystąpieniem do UE w 2004 roku.", "WPROWADZAJACE", [2007, 2004], ["OBALA", "WSPIERA"]],
    ["Czy Chorwacja i Albania dołączyły do NATO w 2009 roku?", "POTWIERDZONE", [2009, 2009], ["WSPIERA", "WSPIERA"]],
    ["Czy Szwecja i Finlandia przystąpiły do NATO w 2022 roku?", "FALSZYWE", [2024, 2023], ["OBALA", "OBALA"]],
    ["Estonia przystąpiła do UE i do strefy Schengen w 2007 roku.", "WPROWADZAJACE", [2004, 2007], ["OBALA", "WSPIERA"]],
    ["Słowenia i Cypr w 2008 roku przyjęły euro.", "WPROWADZAJACE", [2007, 2008], ["OBALA", "WSPIERA"]],
  ] as const)("%s", async (text, verdict, years, relations) => {
    const report = await verifyInput({ text, channel: "eval", kind: "text", receivedAt: now.toISOString() }, deps);
    expect(report.mainVerdict).toBe(verdict);
    expect(report.status).toBe("OK");
    expect(report.models).toHaveLength(0);
    const main = report.verdicts[0]!;
    expect(main.parts?.map(part => part.verdict)).toEqual(relations.map(r => r === "WSPIERA" ? "POTWIERDZONE" : "FALSZYWE"));
    expect(main.evidence.map(e => e.relation)).toEqual(relations);
    expect(main.parts?.map(part => part.evidence?.[0])).toEqual(main.evidence);
    main.evidence.forEach((e, i) => {
      expect(e.quote).toContain(String(years[i]));
      expect(main.reasonPl).toContain(String(years[i]));
      expect(deps.store.get(e.recordId)?.text).toContain(e.quote);
      expect(e.usedForVerdict).toBe(true);
    });
  });

  it("przekazuje szerszy zakres i niedostępne daty do zwykłej analizy", () => {
    for (const text of [
      "Czy Litwa i Litwa wprowadziły euro w tym samym roku?",
      "Malta i Cypr wprowadziły banknoty euro w tym samym roku.",
      "Czy Grecja i Cypr wprowadziły euro w tym samym roku przed reformą?",
      "Szwecja i Finlandia nie przystąpiły do NATO w 2022 roku.",
      "Estonia i Łotwa przystąpiły do NATO przed 2004 rokiem.",
      "Polska i Czechy przystąpiły do NATO w marcu 1999 roku.",
    ]) expect(accessionComparison(text)).toBeUndefined();
    expect(accessionEntry(deps.store, "Poland", "euro", +now)).toBeUndefined();
    expect(accessionEntry(deps.store, "Estonia", "euro", +new Date("2000-01-01"))).toBeUndefined();
  });
});
