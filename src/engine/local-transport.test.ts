import { describe, expect, it } from "vitest";
import { openDatabase } from "../corpus/store";
import { findLocalTransportRecords, localTransportQuestion, unresolvedQuestion } from "./local-transport";
import type { CorpusRecord } from "../shared/contracts";

const tickets = "Czy od wczoraj w Pcimiu bilety autobusowe można kupić tylko przez aplikację?";
const ban = "Czy od przyszłego tygodnia diesle nie będą mogły wjechać do centrum Pcimia?";

describe("lokalne przepisy transportowe", () => {
  it("wyjaśnia brak właściwego dokumentu dla obu pytań po przeszukaniu korpusu", () => {
    const db = openDatabase(":memory:");
    try {
      const sale = localTransportQuestion(tickets)!;
      const zone = localTransportQuestion(ban)!;
      expect(sale.place).toBe("Pcimiu");
      expect(zone.place).toBe("Pcimia");
      expect(localTransportQuestion("czy pcim wprowadza zakaz wjazdu diesli do centrum?")?.placeStem).toBe("pcim");
      expect(localTransportQuestion(tickets.toLowerCase())?.placeStem).toBe("pcim");
      expect(findLocalTransportRecords(db, sale)).toEqual([]);
      expect(unresolvedQuestion(sale.claim, ["korpus"]).verdicts[0]!.triedPl).toBe("korpus");
      expect(unresolvedQuestion(sale.claim, ["korpus"], sale.neededEvidencePl).summaryPl).toContain("sposoby zakupu i datę zmiany");
      const unresolved = unresolvedQuestion(zone.claim, ["korpus"], zone.neededEvidencePl);
      for (const detail of ["uchwała rady gminy", "granic strefy", "pojazdów", "datą"]) {
        expect(unresolved.summaryPl).toContain(detail);
        expect(unresolved.verdicts[0]!.missingContext).toContain(detail);
      }
    } finally {
      db.close();
    }
  });
  it("nowy lokalny dokument trafia do oceny, niezależnie od liczby ogólnopolskich trafień", () => {
    const db = openDatabase(":memory:");
    try {
      const record = { title: "Pcim – rozkład i taryfa", text: "Bilety autobusowe można kupić także u kierowcy.", url: "https://example.org/taryfa" } as CorpusRecord;
      const local = localTransportQuestion(tickets)!;
      const insert = db.prepare(`INSERT INTO records (id,source_id,url,title,publisher,fetched_at,lang,text,role,type,level,independence_group,licence)
        VALUES (?, 'gmina', ?, ?, 'Gmina', '2026-11-22', 'pl', ?, 'tresc', 'pierwotne', 1, 'gmina', 'info')`);
      const rowid = insert.run("T", record.url, record.title, record.text).lastInsertRowid;
      db.prepare("INSERT INTO records_fold(rowid,title,text) VALUES(?,?,?)").run(rowid, record.title, record.text);
      expect(findLocalTransportRecords(db, local)).toEqual(["T"]);
      expect(local.mayAddress(record)).toBe(true);
      expect(local.mayAddress({ ...record, title: "Kraków – taryfa" })).toBe(false);
      expect(localTransportQuestion("Czy we Wrocławiu jeździ się za darmo?")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
