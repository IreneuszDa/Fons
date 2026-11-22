import { expect, it } from "vitest";
import { primarySubjectIds, subjectAliases } from "./subject";
import { createTestDb } from "./test-fixtures";

it("znajduje pierwotne źródło dla tłumaczonego podmiotu, nawet gdy twierdzenie podaje inną datę", () => {
  const db = createTestDb();
  try {
    db.exec(`UPDATE records SET title='Szwajcaria — podpisanie porozumienia w 1980 roku' WHERE id='r01';
      UPDATE records SET title='Austria — podpisanie porozumienia w 2000 roku', text='Wspomniano o Szwajcarii.' WHERE id='r02';
      UPDATE records SET title='Switzerland signed the treaty in 2000', level=2 WHERE id='r03';
      INSERT INTO records_fts(records_fts) VALUES('rebuild');`);
    const aliases = subjectAliases("Switzerland");
    expect(aliases).toContain("Szwajcaria");
    expect(primarySubjectIds(db, aliases)).toEqual(["r01"]);
    expect(primarySubjectIds(db, "Nieznana firma")).toEqual([]);
  } finally {
    db.close();
  }
});
