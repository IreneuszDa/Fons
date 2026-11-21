/**
 * Ingestia aktów prawa UE przez oficjalny interfejs Urzędu Publikacji UE (Cellar):
 *  - wersja skonsolidowana wybierana zapytaniem SPARQL po numerze CELEX (najnowsza data),
 *  - treść pobierana przez negocjację treści (Accept: application/xhtml+xml, Accept-Language: pol),
 *  - strony eur-lex.europa.eu chroni WAF (wyzwanie JavaScript, HTTP 202) — NIE próbujemy go obchodzić;
 *    w rekordzie url wskazuje stronę EUR-Lex tego samego dokumentu (ten sam CELEX), z której czytelnik zweryfikuje cytat.
 *
 * Fragmenty to artykuły (z usuniętymi znacznikami zmian ▼M..), maks. 2 kawałki po <= 1200 znaków.
 * Licencja: decyzja Komisji 2011/833/UE (ponowne wykorzystywanie z podaniem źródła).
 */
import type { CorpusRecord } from "../../shared/contracts";
import { PoliteClient, type IngestOptions, type IngestResult, baseFromCatalog, blockText, chunkText, newResult, parseHtmlPage, recordId, sourceFromCatalog, squash } from "./common";

interface EuActSpec {
  /** Podstawa CELEX bez daty konsolidacji (np. 02014R0833) albo pełny numer (np. 32024R1359). */
  celex: string;
  consolidated: boolean;
  /** Data publikacji, gdy nie wynika z numeru CELEX (np. teksty zbiorcze). */
  publishedAt?: string;
  label: string;
  topics: string[];
  /** Etykiety artykułów do wzięcia (np. "2a"); jeśli podano `include`, artykuły muszą jeszcze pasować. */
  articles?: string[];
  include?: RegExp;
  max: number;
  /** Etykiety wykluczone. */
  exclude?: string[];
  /** Wyrażenia, które MUSZĄ wystąpić w pobranym dokumencie (ochrona przed błędnym numerem CELEX → błędną etykietą rekordu). */
  expect?: RegExp[];
}

export const EU_ACTS: EuActSpec[] = [
  {
    celex: "02014R0833",
    consolidated: true,
    label: "Rozporządzenie Rady (UE) nr 833/2014 dotyczące środków ograniczających w związku z działaniami Rosji destabilizującymi sytuację na Ukrainie",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "embargo", "energia"],
    include: /ropy naftowej|węgl|stal|diament|gazu ziemnego|LNG|SWIFT|Bank\w* Centraln|banku centralnego|przestrzeni powietrznej|statk\w+ powietrzn|RT |Sputnik|nadawani|kryptoaktyw|pułap cenow|cen\w+ maksymaln/i,
    max: 30,
  },
  {
    celex: "02014R0269",
    consolidated: true,
    label: "Rozporządzenie Rady (UE) nr 269/2014 w sprawie środków ograniczających w odniesieniu do działań podważających integralność terytorialną, suwerenność i niezależność Ukrainy",
    topics: ["sankcje", "rosja", "ue", "zamrozenie-aktywow", "wojna-w-ukrainie"],
    articles: ["1", "2", "3", "4", "5", "6", "7", "8"],
    max: 9,
  },
  {
    celex: "02006R0765",
    consolidated: true,
    label: "Rozporządzenie Rady (WE) nr 765/2006 dotyczące środków ograniczających w związku z sytuacją na Białorusi i udziałem Białorusi w agresji Rosji wobec Ukrainy",
    topics: ["sankcje", "bialorus", "ue", "wojna-w-ukrainie", "embargo"],
    articles: ["1", "2", "3", "4", "5", "1a", "1b", "1c", "1d", "1e", "1f", "1g", "2a", "2b"],
    max: 12,
  },
  {
    celex: "02014D0512",
    consolidated: true,
    label: "Decyzja Rady 2014/512/WPZiB dotycząca środków ograniczających w związku z działaniami Rosji destabilizującymi sytuację na Ukrainie",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie"],
    articles: ["1", "2", "3", "4", "5"],
    max: 5,
  },
  {
    celex: "12016M/TXT",
    publishedAt: "2016-06-07",
    consolidated: false,
    label: "Traktat o Unii Europejskiej (wersja skonsolidowana, Dz.Urz. UE C 202 z 7.6.2016)",
    topics: ["ue", "traktaty", "obronnosc", "wspolna-polityka-bezpieczenstwa", "czlonkostwo-w-ue"],
    articles: ["2", "3", "4", "5", "6", "7", "42", "49", "50"],
    max: 16,
  },
  {
    celex: "32024R1359",
    consolidated: false,
    label: "Rozporządzenie (UE) 2024/1359 dotyczące sytuacji kryzysowych i siły wyższej w dziedzinie migracji i azylu",
    topics: ["migracja", "azyl", "bialorus", "granica", "instrumentalizacja-migracji", "ue"],
    include: /instrumentaliz/i,
    max: 6,
  },
  // ───── Pakiety sankcji wobec Rosji: akty zmieniające rozporządzenie 833/2014 (teksty opublikowane w Dz.Urz. UE) ─────
  {
    celex: "32022R0576",
    consolidated: false,
    publishedAt: "2022-04-08",
    label: "Rozporządzenie Rady (UE) 2022/576 z dnia 8 kwietnia 2022 r. zmieniające rozporządzenie (UE) nr 833/2014 (piąty pakiet sankcji: zakaz importu węgla z Rosji)",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "embargo", "zakaz-importu-wegla", "pakiet-5", "energia"],
    expect: [/2022\/576/, /833\/2014/, /węgl/i, /8 kwietnia 2022/],
    articles: ["3i", "3j", "3k", "3l"],
    max: 6,
  },
  {
    celex: "32022R0879",
    consolidated: false,
    publishedAt: "2022-06-03",
    label: "Rozporządzenie Rady (UE) 2022/879 z dnia 3 czerwca 2022 r. zmieniające rozporządzenie (UE) nr 833/2014 (szósty pakiet sankcji: embargo na ropę naftową z Rosji)",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "embargo", "embargo-na-rope", "pakiet-6", "energia"],
    expect: [/2022\/879/, /833\/2014/, /ropy naftowej/i, /3 czerwca 2022/],
    articles: ["3m", "3n"],
    max: 8,
  },
  {
    celex: "32022R1904",
    consolidated: false,
    publishedAt: "2022-10-06",
    label: "Rozporządzenie Rady (UE) 2022/1904 z dnia 6 października 2022 r. zmieniające rozporządzenie (UE) nr 833/2014 (ósmy pakiet sankcji: pułap cenowy na rosyjską ropę)",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "cena-maksymalna-ropy", "pakiet-8", "energia"],
    expect: [/2022\/1904/, /833\/2014/, /6 października 2022/],
    articles: ["2aa", "5n"],
    max: 6,
  },
  {
    celex: "32023R0427",
    consolidated: false,
    publishedAt: "2023-02-25",
    label: "Rozporządzenie Rady (UE) 2023/427 z dnia 25 lutego 2023 r. zmieniające rozporządzenie (UE) nr 833/2014 (dziesiąty pakiet sankcji)",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "pakiet-10"],
    expect: [/2023\/427/, /833\/2014/, /25 lutego 2023/],
    articles: ["5o", "5p"],
    max: 5,
  },
  {
    celex: "32024R1745",
    consolidated: false,
    publishedAt: "2024-06-24",
    label: "Rozporządzenie Rady (UE) 2024/1745 z dnia 24 czerwca 2024 r. zmieniające rozporządzenie (UE) nr 833/2014 (czternasty pakiet sankcji, m.in. LNG)",
    topics: ["sankcje", "rosja", "ue", "wojna-w-ukrainie", "pakiet-14", "lng", "energia"],
    expect: [/2024\/1745/, /833\/2014/, /24 czerwca 2024/],
    articles: ["3r", "3t", "3u", "3v"],
    max: 5,
  },
];

const CELLAR_SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";

async function consolidatedCelexCandidates(client: PoliteClient, base: string): Promise<string[]> {
  const q = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>\nSELECT ?celex WHERE { ?w cdm:resource_legal_id_celex ?celex . FILTER(STRSTARTS(STR(?celex), "${base}-")) } LIMIT 500`;
  const url = `${CELLAR_SPARQL}?format=${encodeURIComponent("application/sparql-results+json")}&query=${encodeURIComponent(q)}`;
  const res = await client.get(url, { accept: "application/sparql-results+json" });
  const data = JSON.parse(res.body) as { results: { bindings: { celex: { value: string } }[] } };
  const ids = data.results.bindings.map((b) => b.celex.value).filter((c) => /^\d{5}[A-Z]\d{4}-\d{8}$/.test(c));
  ids.sort().reverse();
  return ids.slice(0, 5);
}

const MARKER = /^[▼►◄]/;

export interface EuArticle {
  label: string;
  text: string;
}

export function splitEuArticles(lines: string[]): EuArticle[] {
  const out: EuArticle[] = [];
  let cur: { label: string; parts: string[] } | null = null;
  const flush = () => {
    if (cur) out.push({ label: cur.label, text: cur.parts.map(squash).join("\n") });
    cur = null;
  };
  for (const line of lines) {
    const m = /^„?Artykuł (\d+[a-z]{0,3})$/.exec(line);
    if (m) {
      flush();
      cur = { label: m[1]!, parts: [line] };
      continue;
    }
    if (/^(ZAŁĄCZNIK|DODATEK|TYTUŁ|ROZDZIAŁ|PROTOKÓŁ)\b/.test(line) && cur) {
      // koniec artykułów danej części
      flush();
      continue;
    }
    if (!cur) continue;
    if (MARKER.test(line)) continue;
    cur.parts.push(line);
  }
  flush();
  return out;
}

export async function ingestEurLex(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("eur-lex");
  const client = new PoliteClient({ refresh: opts.refresh });
  const src = sourceFromCatalog(opts.catalog, "eur-lex");
  const base = baseFromCatalog(src);

  for (const spec of EU_ACTS) {
    try {
      let celex = spec.celex;
      let res: Awaited<ReturnType<PoliteClient["get"]>> | undefined;
      const candidates = spec.consolidated ? await consolidatedCelexCandidates(client, spec.celex) : [spec.celex];
      if (candidates.length === 0) throw new Error(`brak wersji skonsolidowanej ${spec.celex} w Cellar`);
      for (const cand of candidates) {
        // Najnowsza konsolidacja bywa jeszcze niedostępna w języku polskim — bierzemy najnowszą dostępną.
        const r = await client.get(`http://publications.europa.eu/resource/celex/${encodeURIComponent(cand)}`, {
          accept: "application/xhtml+xml",
          headers: { "Accept-Language": "pol" },
        });
        if (r.status === 200) {
          res = r;
          celex = cand;
          break;
        }
      }
      if (!res) throw new Error(`brak polskiej wersji językowej dla ${candidates.join(", ")}`);
      const { document } = parseHtmlPage(res.body);
      const lines = blockText(document.body).split("\n");
      if (spec.expect && !spec.expect.every((re) => re.test(lines.join("\n")))) {
        throw new Error(`dokument CELEX ${celex} nie zawiera oczekiwanych oznaczeń aktu (${spec.expect.map(String).join(", ")}) — pominięty, by nie nadać błędnej etykiety`);
      }
      const articles = splitEuArticles(lines);
      // Pierwsze wystąpienie etykiety (dokumenty zbiorcze powtarzają numery w kolejnych częściach).
      const seenLabels = new Set<string>();
      let chosen = articles.filter((a) => (seenLabels.has(a.label) ? false : (seenLabels.add(a.label), true)));
      if (spec.articles) chosen = chosen.filter((a) => spec.articles!.includes(a.label));
      if (spec.include) chosen = chosen.filter((a) => spec.include!.test(a.text));
      if (spec.exclude) chosen = chosen.filter((a) => !spec.exclude!.includes(a.label));
      chosen = chosen.filter((a) => a.text.length >= 80);

      const consDate = /-(\d{4})(\d{2})(\d{2})$/.exec(celex);
      const publishedAt = consDate ? `${consDate[1]}-${consDate[2]}-${consDate[3]}` : (spec.publishedAt ?? null);
      const pageUrl = `https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:${celex}`;
      let n = 0;
      for (const a of chosen) {
        if (n >= spec.max) break;
        const chunks = chunkText(a.text, 1200).filter((c) => c.length >= 60).slice(0, 2);
        chunks.forEach((chunk, idx) => {
          if (n >= spec.max) return;
          const rec: CorpusRecord = {
            ...base,
            id: recordId("eur-lex", `${celex}|${a.label}|${idx}`),
            url: pageUrl,
            title: `${spec.label}${spec.consolidated ? ` (tekst skonsolidowany ${publishedAt}, dokument informacyjny)` : ""} — art. ${a.label}${idx > 0 ? ` (cz. ${idx + 1})` : ""}`,
            publishedAt,
            fetchedAt: res.fetchedAt,
            lang: "pl",
            text: chunk,
            topics: [...spec.topics, "akt-prawny", "prawo-ue", spec.consolidated ? "tekst-skonsolidowany" : "tekst-opublikowany"],
            origin: "corpus",
          };
          result.records.push(rec);
          n++;
        });
      }
      opts.log(`  EUR-Lex ${celex}: ${n} rekordów (z ${articles.length} artykułów w dokumencie)`);
      if (n === 0) result.skipped.push({ what: celex, reason: "po filtrach nie zostały żadne artykuły" });
    } catch (e) {
      result.skipped.push({ what: spec.celex, reason: (e as Error).message });
    }
  }
  result.requests = client.requests;
  result.notes.push(
    "Treść pobrana przez Cellar (publications.europa.eu, negocjacja treści po CELEX); adres w rekordzie to strona EUR-Lex tego samego dokumentu. Wersje skonsolidowane to dokumenty informacyjne bez mocy prawnej.",
  );
  return result;
}
