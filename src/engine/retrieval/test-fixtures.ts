/** Wspólne dane testowe modułu wyszukiwania: schemat z docs/MODULES.md + ~20 syntetycznych polskich rekordów. */
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { Claim } from "../../shared/contracts";

export const SCHEMA = `
CREATE TABLE records(
  id TEXT PRIMARY KEY, source_id TEXT, url TEXT, title TEXT, publisher TEXT, published_at TEXT, fetched_at TEXT,
  lang TEXT, text TEXT, role TEXT, type TEXT, level INTEGER, independence_group TEXT, licence TEXT,
  claim_reviewed TEXT, rating_json TEXT, topics_json TEXT, period TEXT, origin TEXT
);
CREATE VIRTUAL TABLE records_fts USING fts5(
  title, text, claim_reviewed, content='records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE incidents(
  id TEXT PRIMARY KEY, title TEXT, summary TEXT, url TEXT, domains_json TEXT, published_at TEXT, record_id TEXT
);
CREATE VIRTUAL TABLE incidents_fts USING fts5(
  title, summary, content='incidents', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE corpus_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE record_embeddings(record_id TEXT PRIMARY KEY, vector BLOB);
`;

export interface FixtureRecord {
  id: string;
  title: string;
  text: string;
  claim_reviewed?: string;
}

export const RECORDS: FixtureRecord[] = [
  { id: "r01", title: "Rada UE przyjęła kolejny pakiet sankcji wobec Rosji", text: "Rada Unii Europejskiej przyjęła pakiet sankcji obejmujący zakaz importu stali oraz zamrożenie aktywów." },
  { id: "r02", title: "Rozporządzenie w sprawie środków ograniczających", text: "Unia nałożyła sankcje na osoby i podmioty. Wykaz osób objętych sankcjami jest publikowany w Dzienniku Urzędowym UE." },
  { id: "r03", title: "Komunikat o handlu", text: "Firmy łamiące sankcjami objęte zakazy eksportu mogą zostać ukarane. Kontrola celna została zaostrzona." },
  { id: "r04", title: "Ustawa o ochronie ludności", text: "Ustawa określa zasady ochrony ludności i obrony cywilnej w czasie kryzysu." },
  { id: "r05", title: "PKB Polski w 2024 roku", text: "Produkt krajowy brutto Polski wzrósł w 2024 roku o 2,9 proc. według wstępnych danych GUS." },
  { id: "r06", title: "Inflacja w Polsce w październiku", text: "Wskaźnik cen towarów i usług konsumpcyjnych wyniósł 4,9 proc. rok do roku." },
  { id: "r07", title: "Fałszywa informacja o szczepionkach", text: "Wpis twierdzący, że szczepionki zawierają mikroczipy, jest nieprawdziwy.", claim_reviewed: "Szczepionki zawierają mikroczipy do śledzenia ludzi" },
  { id: "r08", title: "Manipulacja dotycząca uchodźców", text: "Zdjęcie wykorzystano poza kontekstem; pochodzi z 2015 roku, nie z obecnego kryzysu.", claim_reviewed: "Uchodźcy zniszczyli miasto na zdjęciu" },
  { id: "r09", title: "Granica polsko-białoruska", text: "Straż Graniczna informuje o liczbie prób nielegalnego przekroczenia granicy w ostatnim miesiącu." },
  { id: "r10", title: "NATO wzmacnia wschodnią flankę", text: "Sojusz Północnoatlantycki zwiększa obecność wojsk w państwach wschodniej flanki." },
  { id: "r11", title: "Budżet państwa na 2025 rok", text: "Projekt ustawy budżetowej zakłada deficyt w wysokości 289 mld zł oraz wzrost wydatków na obronność." },
  { id: "r12", title: "Eurostat: bezrobocie w strefie euro", text: "Stopa bezrobocia w strefie euro wyniosła 6,3 proc. w sierpniu." },
  { id: "r13", title: "Zakaz sprzedaży samochodów spalinowych", text: "Parlament Europejski przyjął rozporządzenie o normach emisji CO2 dla nowych samochodów od 2035 roku." },
  { id: "r14", title: "Zdrowie: szczepienia ochronne dzieci", text: "Program szczepień ochronnych obejmuje obowiązkowe szczepienia dzieci zgodnie z kalendarzem." },
  { id: "r15", title: "Dezinformacja w mediach społecznościowych", text: "Analiza kampanii dezinformacyjnych pokazuje wzrost liczby fałszywych kont rozpowszechniających narrację o wojnie." },
  { id: "r16", title: "Energia: ceny gazu w Europie", text: "Ceny gazu na giełdzie TTF spadły o 12 proc. w porównaniu z poprzednim kwartałem." },
  { id: "r17", title: "Mistrzostwa świata w piłce nożnej", text: "Reprezentacja Polski zakwalifikowała się do turnieju po wygranym meczu barażowym." },
  { id: "r18", title: "Kodeks wyborczy", text: "Kodeks wyborczy reguluje zasady przeprowadzania wyborów prezydenckich i parlamentarnych w Polsce." },
  { id: "r19", title: "Pomoc humanitarna dla Ukrainy", text: "Polska przekazała pomoc humanitarną o wartości kilkuset milionów złotych uchodźcom z Ukrainy." },
  { id: "r20", title: "Raport o cyberbezpieczeństwie", text: "NASK opublikował raport o incydentach cyberbezpieczeństwa zgłoszonych w ubiegłym roku." },
];

export interface FixtureIncident {
  id: string;
  title: string;
  summary: string;
  url: string;
  domains: string[];
  record_id: string | null;
}

export const INCIDENTS: FixtureIncident[] = [
  { id: "i01", title: "Kampania o mikroczipach w szczepionkach", summary: "Fałszywe wpisy o mikroczipach rozpowszechniane przez sieć kont.", url: "https://example.org/incident/1", domains: ["zla-strona.pl", "https://dezinfo.example.com/news"], record_id: "r07" },
  { id: "i02", title: "Manipulowane zdjęcia z granicy", summary: "Zdjęcia sprzed lat podawane jako aktualne wydarzenia na granicy.", url: "https://example.org/incident/2", domains: ["fake-news.example.net"], record_id: "r08" },
  { id: "i03", title: "Incydent bez rekordu", summary: "Incydent dotyczący sankcji, bez powiązanego rekordu korpusu.", url: "https://example.org/incident/3", domains: ["brak-rekordu.pl"], record_id: null },
  { id: "i04", title: "Incydent z nieistniejącym rekordem", summary: "Incydent o sankcjach z martwym odwołaniem.", url: "https://example.org/incident/4", domains: ["martwy.pl"], record_id: "r999" },
];

export function createTestDb(opts: { snapshotId?: string | null } = {}): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO records (id, source_id, url, title, publisher, published_at, fetched_at, lang, text, role, type, level,
       independence_group, licence, claim_reviewed, rating_json, topics_json, period, origin)
     VALUES (@id, 'src', 'https://example.org/' || @id, @title, 'Test', '2024-01-01', '2025-01-01', 'pl', @text, 'tresc',
       'pierwotne', 1, 'g', 'CC0', @claim_reviewed, NULL, '[]', NULL, 'corpus')`,
  );
  for (const r of RECORDS) ins.run({ claim_reviewed: null, ...r });
  db.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
  const insInc = db.prepare(
    `INSERT INTO incidents (id, title, summary, url, domains_json, published_at, record_id)
     VALUES (@id, @title, @summary, @url, @domains_json, '2025-01-01', @record_id)`,
  );
  for (const i of INCIDENTS) insInc.run({ ...i, domains_json: JSON.stringify(i.domains) });
  db.exec("INSERT INTO incidents_fts(incidents_fts) VALUES('rebuild')");
  if (opts.snapshotId !== null) {
    db.prepare("INSERT INTO corpus_meta (key, value) VALUES ('snapshot_id', ?)").run(opts.snapshotId ?? "snap-1");
  }
  return db;
}

export function claim(text: string, id = "c1"): Claim {
  return { id, text, type: "fakt", isMain: true, temporal: { kind: "brak" }, inputOverlap: 1 };
}
