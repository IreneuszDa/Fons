/**
 * Ingestia aktów prawnych z API ELI Sejmu (api.sejm.gov.pl/eli) — Dz.U. i M.P.
 *
 * Akty prawne nie podlegają ochronie prawa autorskiego (art. 4 pkt 1 ustawy o prawie autorskim),
 * więc zapisujemy pełne fragmenty (artykuły, dzielone na kawałki <= 1200 znaków).
 *
 * Wybór tekstu:
 *  1. jeśli akt ma tekst ujednolicony (typ "U", PDF) — bierzemy go (aktualny stan prawny),
 *  2. w przeciwnym razie tekst HTML ogłoszony (typ "H"),
 *  3. w przeciwnym razie PDF z tekstem ogłoszonym (typ "O").
 * PDF zamieniamy na tekst narzędziem `pdftotext` (poppler); gdy go brak, akt jest pomijany z adnotacją.
 */
import { execFile } from "node:child_process";
import type { CorpusRecord } from "../../shared/contracts";
import {
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  blockText,
  chunkText,
  newResult,
  parseHtmlPage,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

export interface ActSpec {
  eli: string;
  topics: string[];
  /** Maksymalna liczba rekordów z aktu (kolejne artykuły od początku, jeśli nie podano `articles`). */
  maxRecords?: number;
  /** Tylko te artykuły (etykiety, np. "5", "116", "3a"). */
  articles?: string[];
  /** Pomiń artykuły, w których tekst pasuje do wyrażenia (np. przepisy zmieniające). */
  skipIfMatches?: RegExp;
  /** Ile kawałków (po <= 1200 znaków) bierzemy z artykułu (domyślnie 2). */
  chunksPerArticle?: number;
  /** Odcina z końca artykułu nagłówki rozdziałów/działów, które pdftotext dokleja do poprzedniego artykułu (Konstytucja). */
  trimHeadings?: boolean;
  /** Dodaje preambułę (tekst przed pierwszym rozdziałem; Konstytucja RP). */
  preamble?: boolean;
  /** Minimalna długość rekordu w znakach (domyślnie 60; Konstytucja: krótkie artykuły, np. art. 3, też są pełnoprawne). */
  minChars?: number;
  /** Obcina tekst aktu bez artykułów przed pierwszym dopasowaniem (np. podpis i załączniki-tabele obwieszczeń PKW). */
  stopAt?: RegExp;
}

export const ACTS: ActSpec[] = [
  // Konstytucja RP w całości (art. 1-243 + preambuła): jeden rekord na artykuł (dłuższe artykuły: kolejne kawałki), tekst ujednolicony.
  { eli: "DU/1997/483", topics: ["konstytucja", "ustroj-panstwa", "prawo-konstytucyjne", "obronnosc", "polityka-zagraniczna", "umowy-miedzynarodowe"], maxRecords: 600, chunksPerArticle: 3, trimHeadings: true, preamble: true, minChars: 30 },
  { eli: "DU/2022/583", topics: ["ukraina", "uchodzcy", "migracja", "wojna-w-ukrainie", "cudzoziemcy"], maxRecords: 14 },
  { eli: "DU/2022/835", topics: ["sankcje", "rosja", "bialorus", "wojna-w-ukrainie", "bezpieczenstwo-narodowe"], maxRecords: 22 },
  { eli: "DU/2022/655", topics: ["obronnosc", "silyzbrojne", "nato", "wojsko"], maxRecords: 14 },
  { eli: "DU/2013/1650", topics: ["cudzoziemcy", "migracja", "wizy", "granica"], maxRecords: 12 },
  { eli: "DU/2003/1176", topics: ["azyl", "ochrona-miedzynarodowa", "migracja", "uchodzcy"], maxRecords: 12 },
  { eli: "DU/1990/461", topics: ["granica", "ochrona-granicy", "bialorus", "bezpieczenstwo"], maxRecords: 10 },
  { eli: "DU/1990/462", topics: ["straz-graniczna", "granica", "bezpieczenstwo"], maxRecords: 6 },
  { eli: "DU/2011/112", topics: ["wybory", "kodeks-wyborczy", "integralnosc-wyborow"], maxRecords: 12 },
  { eli: "DU/2022/1543", topics: ["nato", "finlandia", "akcesja", "ratyfikacja"], maxRecords: 3 },
  { eli: "DU/2022/1544", topics: ["nato", "szwecja", "akcesja", "ratyfikacja"], maxRecords: 3 },
  { eli: "DU/2024/482", topics: ["nato", "szwecja", "akcesja", "traktat-polnocnoatlantycki"], maxRecords: 4 },
  { eli: "DU/2023/938", topics: ["nato", "finlandia", "akcesja", "traktat-polnocnoatlantycki"], maxRecords: 4 },
  { eli: "DU/2020/2153", topics: ["obronnosc", "usa", "wojska-amerykanskie", "umowa-miedzynarodowa"], maxRecords: 10 },
  { eli: "DU/2025/1841", topics: ["obronnosc", "usa", "ratyfikacja"], maxRecords: 3 },
  // Oficjalne wyniki wyborów (obwieszczenia PKW w Dz.U.): prezydent 2025 (I tura, ponowne głosowanie), Sejm 2023.
  { eli: "DU/2025/652", topics: ["wybory", "wybory-prezydenckie-2025", "wyniki-wyborow", "pkw", "prezydent"], maxRecords: 6, stopAt: /Przewodniczący Państwowej Komisji Wyborczej/ },
  { eli: "DU/2025/714", topics: ["wybory", "wybory-prezydenckie-2025", "wyniki-wyborow", "pkw", "prezydent"], maxRecords: 6, stopAt: /Przewodniczący Państwowej Komisji Wyborczej/ },
  // Sejm 2023 (Senat pominięty: obwieszczenie to głównie spis okręgów): tylko dane zbiorcze w skali kraju (Dział I) - dalej są wyniki okręgów (setki list kandydatów), które pomijamy.
  { eli: "DU/2023/2234", topics: ["wybory", "wybory-parlamentarne-2023", "wyniki-wyborow", "pkw", "sejm", "mandaty"], maxRecords: 7, stopAt: /Dział II\.(?! -)/ },
  { eli: "MP/2022/284", topics: ["rosja", "ukraina", "agresja", "sejm"], maxRecords: 3 },
  { eli: "MP/2022/122", topics: ["nato", "rosja", "ukraina", "sejm"], maxRecords: 3 },
  { eli: "MP/2026/961", topics: ["dezinformacja", "centrum-walki-z-dezinformacja", "bezpieczenstwo"], maxRecords: 4 },
  // Rozporządzenia graniczne i azylowe — najnowsze, wyszukane po tytule (patrz SEARCHES).
];

/** Wyszukiwania po tytule: bierzemy `take` najnowszych aktów o statusie innym niż uchylony. */
export const SEARCHES: { title: string; type?: string; take: number; topics: string[]; maxRecords: number }[] = [
  { title: "czasowego ograniczenia prawa do złożenia wniosku o udzielenie ochrony międzynarodowej", take: 3, topics: ["azyl", "granica", "bialorus", "migracja", "ochrona-miedzynarodowa"], maxRecords: 4 },
  { title: "czasowego zakazu przebywania na określonym obszarze w strefie nadgranicznej", take: 3, topics: ["granica", "strefa-nadgraniczna", "bialorus", "bezpieczenstwo"], maxRecords: 4 },
  { title: "w sprawie wprowadzenia czasowego przywrócenia kontroli granicznej", take: 2, topics: ["granica", "kontrola-graniczna", "schengen", "niemcy", "litwa"], maxRecords: 4 },
  { title: "o zmianie ustawy o cudzoziemcach", type: "Ustawa", take: 2, topics: ["cudzoziemcy", "migracja", "wizy"], maxRecords: 6 },
];

interface ActMeta {
  ELI: string;
  title: string;
  displayAddress: string;
  announcementDate: string;
  status: string;
  inForce?: string;
  type: string;
  texts?: { fileName: string; type: string }[];
  references?: Record<string, { id: string }[]>;
}

const BASE = "https://api.sejm.gov.pl/eli/acts";
const PREAMBLE_LABEL = "preambula";

export async function pdfToText(buf: Buffer): Promise<string> {
  const child = execFile("pdftotext", ["-enc", "UTF-8", "-", "-"], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`pdftotext zakończył się kodem ${code}`))));
    child.stdin?.on("error", () => {});
    child.stdin?.end(buf);
  });
}

/** Usuwa nagłówki/stopki stron PDF Kancelarii Sejmu, zachowując treść. */
export function cleanPdfText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\f/g, "").trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (/^©\s*Kancelaria Sejmu$/i.test(t)) return false;
      if (/^s\.\s*\d+\s*\/\s*\d+$/.test(t)) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
      return true;
    })
    .join("\n");
}

function labelOrder(label: string): [number, string] {
  const m = /^(\d+)([a-z]*)$/.exec(label);
  return m ? [Number(m[1]), m[2] ?? ""] : [0, label];
}

function isNextLabel(prev: string | null, next: string): boolean {
  if (prev === null) return true;
  const [pn, ps] = labelOrder(prev);
  const [nn, ns] = labelOrder(next);
  return nn > pn || (nn === pn && ns > ps);
}

export interface ArticleText {
  label: string;
  text: string;
}

/** Dzieli tekst aktu (z PDF) na artykuły po liniach zaczynających się od "Art. N." */
/** Czy wiersz kończy się jak koniec zdania (a nie jak nagłówek rozdziału/sekcji). */
function endsLikeSentence(line: string): boolean {
  return /[.;:?!)"”…]\s*$/.test(line);
}

export function splitArticles(clean: string, opts: { trimHeadings?: boolean } = {}): ArticleText[] {
  const lines = clean.split("\n");
  const out: ArticleText[] = [];
  let cur: { label: string; lines: string[] } | null = null;
  let prev: string | null = null;
  for (const line of lines) {
    const m = /^Art\.\s*(\d+[a-z]{0,3})\.(?:\s|$)/.exec(line);
    if (m && isNextLabel(prev, m[1]!)) {
      if (cur) {
        let ls = cur.lines;
        if (opts.trimHeadings) {
          // Nagłówki ("Rozdział II", "WOLNOŚCI, PRAWA...", "Zasady ogólne") kończą się bez znaku interpunkcyjnego.
          ls = ls.filter((l) => l.trim() !== "");
          while (ls.length > 1 && (!endsLikeSentence(ls[ls.length - 1]!) || /^Rozdział [IVXLC]+\s*$/.test(ls[ls.length - 1]!.trim()))) ls = ls.slice(0, -1);
        }
        out.push({ label: cur.label, text: squash(ls.join(" ")) });
      }
      cur = { label: m[1]!, lines: [line] };
      prev = m[1]!;
    } else if (cur) cur.lines.push(line);
  }
  if (cur) {
    let ls = cur.lines;
    if (opts.trimHeadings) {
      ls = ls.filter((l) => l.trim() !== "");
      while (ls.length > 1 && !endsLikeSentence(ls[ls.length - 1]!)) ls = ls.slice(0, -1);
    }
    out.push({ label: cur.label, text: squash(ls.join(" ")) });
  }
  return out;
}

/**
 * Preambuła Konstytucji RP z tekstu ujednoliconego (pdftotext): fragment od "W trosce o byt" do pierwszego rozdziału.
 * W PDF w środek preambuły wpada ramka "Opracowano na podstawie: Dz. U. ..." — dzielimy preambułę na dwie części
 * (przed i po ramce), żeby każda była ciągłym fragmentem źródła.
 */
export function constitutionPreamble(clean: string): string[] {
  const start = clean.indexOf("W trosce o byt");
  const end = clean.search(/^Rozdział I\s*$/m);
  if (start < 0 || end < 0 || end < start) return [];
  const body = clean.slice(start, end);
  const box = /Opracowano na\s+podstawie:[\s\S]*?poz\.\s*946\.\s*/.exec(body);
  const parts = box ? [body.slice(0, box.index), body.slice(box.index + box[0].length)] : [body];
  return parts.map(squash).filter((t) => t.length >= 60);
}

function htmlArticles(html: string): ArticleText[] {
  const { document } = parseHtmlPage(html);
  const out: ArticleText[] = [];
  const all = Array.from(document.querySelectorAll(".unit_arti"));
  for (const el of all) {
    if (el.parentElement?.closest(".unit_arti")) continue;
    const id = el.getAttribute("id") ?? "";
    const m = /^arti_(\d+[a-z]{0,3})$/.exec(id);
    if (!m) continue;
    out.push({ label: m[1]!, text: squash(blockText(el).replace(/\n/g, " ")) });
  }
  return out;
}

async function fetchMeta(client: PoliteClient, eli: string): Promise<ActMeta | null> {
  try {
    const { data } = await client.getJson<ActMeta>(`${BASE}/${eli}`);
    return data;
  } catch {
    return null;
  }
}

interface ActText {
  url: string;
  fetchedAt: string;
  kind: "U" | "H" | "O";
  /** Tekst całego aktu do podziału na artykuły (PDF/HTML). */
  articles: ArticleText[];
  /** Cały czysty tekst (dla aktów bez artykułów). */
  fullText: string;
  publishedAt: string | null;
  note?: string;
}

async function loadActText(client: PoliteClient, meta: ActMeta, result: IngestResult, spec: { trimHeadings?: boolean } = {}): Promise<ActText | null> {
  const types = new Map((meta.texts ?? []).map((t) => [t.type, t.fileName]));
  const wantsConsolidated = types.has("U");
  let publishedAt: string | null = meta.announcementDate ?? null;

  const tryPdf = async (kind: "U" | "O"): Promise<ActText | null> => {
    const file = types.get(kind);
    if (!file) return null;
    const url = `${BASE}/${meta.ELI}/text/${kind}/${file}`;
    try {
      const bin = await client.getBinary(url, { accept: "*/*" });
      const raw = await pdfToText(bin.data);
      let clean = cleanPdfText(raw);
      if (kind === "O") {
        // Odetnij nagłówek publikatora (do linii "z dnia ..." włącznie z rodzajem aktu).
        const m = /^z dnia .*$/m.exec(clean);
        if (m && m.index < 600) clean = clean.slice(m.index);
      }
      let pub = publishedAt;
      if (kind === "U") {
        // Data ogłoszenia najnowszego tekstu jednolitego (jeśli akt go ma).
        const tj = meta.references?.["Inf. o tekście jednolitym"]?.[0]?.id;
        if (tj) {
          const m2 = await fetchMeta(client, tj);
          if (m2?.announcementDate) pub = m2.announcementDate;
        }
      }
      return { url, fetchedAt: bin.fetchedAt, kind, articles: splitArticles(clean, { trimHeadings: spec.trimHeadings }), fullText: clean, publishedAt: pub };
    } catch (e) {
      result.skipped.push({ what: `${meta.ELI} (PDF ${kind})`, reason: (e as Error).message });
      return null;
    }
  };

  if (wantsConsolidated) {
    const u = await tryPdf("U");
    if (u) return u;
  }
  if (types.has("H")) {
    const url = `${BASE}/${meta.ELI}/text.html`;
    try {
      const res = await client.get(url);
      if (res.status === 200) {
        const { document } = parseHtmlPage(res.body);
        const body = document.querySelector("body");
        const fullText = body ? blockText(body) : "";
        const arts = htmlArticles(res.body);
        // Samo "podaje do wiadomości" bez treści (umowy publikowane jako PDF) — użyj PDF.
        if (arts.length === 0 && fullText.length < 2500 && types.has("O")) {
          const o = await tryPdf("O");
          if (o) return o;
        }
        return { url, fetchedAt: res.fetchedAt, kind: "H", articles: arts, fullText, publishedAt };
      }
    } catch (e) {
      result.skipped.push({ what: `${meta.ELI} (HTML)`, reason: (e as Error).message });
    }
  }
  return await tryPdf("O");
}

function shortTitle(title: string): string {
  const t = squash(title);
  return t.length > 170 ? t.slice(0, 167) + "..." : t;
}

function emit(
  result: IngestResult,
  opts: IngestOptions,
  meta: ActMeta,
  act: ActText,
  spec: { topics: string[]; maxRecords?: number; articles?: string[]; skipIfMatches?: RegExp; chunksPerArticle?: number; preamble?: boolean; minChars?: number; stopAt?: RegExp },
): number {
  const src = sourceFromCatalog(opts.catalog, "sejm-eli");
  const base = baseFromCatalog(src);
  let produced = 0;
  const max = spec.maxRecords ?? 1000;
  const status = meta.inForce === "IN_FORCE" ? "obowiazuje" : (meta.status ?? "").toLowerCase();
  const topicsCommon = [...spec.topics, "akt-prawny", act.kind === "U" ? "tekst-ujednolicony" : "tekst-ogloszony", status].filter(Boolean);

  const push = (label: string | null, chunk: string, idx: number) => {
    const text = chunk.trim();
    if (text.length < (spec.minChars ?? 60)) return;
    if (/^Art\.\s*\d+[a-z]*\.\s*\(uchylony\)\.?$/.test(text)) return;
    const labelPart = label === PREAMBLE_LABEL ? ` — preambuła${idx > 0 ? ` (cz. ${idx + 1})` : ""}` : label ? ` — art. ${label}${idx > 0 ? ` (cz. ${idx + 1})` : ""}` : idx > 0 ? ` (cz. ${idx + 1})` : "";
    const rec: CorpusRecord = {
      ...base,
      id: recordId("sejm-eli", `${meta.ELI}|${act.kind}|${label ?? "tekst"}|${idx}`),
      url: act.kind === "H" && label && label !== PREAMBLE_LABEL ? `${act.url}#arti_${label}` : act.url,
      title: `${shortTitle(meta.title)} (${meta.displayAddress}${act.kind === "U" ? ", tekst ujednolicony" : ""})${labelPart}`,
      publishedAt: act.publishedAt,
      fetchedAt: act.fetchedAt,
      lang: "pl",
      text,
      topics: topicsCommon,
      origin: "corpus",
    };
    result.records.push(rec);
    produced++;
  };

  if (spec.preamble) {
    constitutionPreamble(act.fullText).forEach((part, i) => push(PREAMBLE_LABEL, part, i));
  }
  const arts = spec.articles
    ? act.articles.filter((a) => spec.articles!.includes(a.label))
    : act.articles;
  if (arts.length === 0) {
    // Akt bez artykułów (uchwała, oświadczenie, zarządzenie) albo rozbiór się nie powiódł — cały tekst.
    let full = act.fullText;
    if (spec.stopAt) {
      const cut = full.search(spec.stopAt);
      if (cut > 0) full = full.slice(0, cut);
    }
    const chunks = chunkText(full, 1200);
    for (let i = 0; i < chunks.length && produced < max; i++) push(null, chunks[i]!, i);
    return produced;
  }
  for (const a of arts) {
    if (produced >= max) break;
    if (spec.skipIfMatches?.test(a.text)) continue;
    const chunks = chunkText(a.text, 1200);
    // Kilka pierwszych kawałków artykułu wystarcza (długie artykuły to głównie wyliczenia).
    for (let i = 0; i < Math.min(chunks.length, spec.chunksPerArticle ?? 2) && produced < max; i++) push(a.label, chunks[i]!, i);
  }
  return produced;
}

export async function ingestEli(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("sejm-eli");
  const client = new PoliteClient({ refresh: opts.refresh });
  const specs: { eli: string; spec: Omit<ActSpec, "eli"> }[] = ACTS.map((a) => ({ eli: a.eli, spec: a }));

  for (const s of SEARCHES) {
    const url = `${BASE}/search?title=${encodeURIComponent(s.title)}&limit=12${s.type ? `&type=${encodeURIComponent(s.type)}` : ""}`;
    try {
      const { data } = await client.getJson<{ items: ActMeta[] }>(url);
      const picked = data.items.filter((i) => !/uchylon|wygaśnięcie/i.test(i.status ?? "")).slice(0, s.take);
      for (const it of picked) specs.push({ eli: it.ELI, spec: { topics: s.topics, maxRecords: s.maxRecords } });
    } catch (e) {
      result.skipped.push({ what: `wyszukiwanie ELI: ${s.title}`, reason: (e as Error).message });
    }
  }

  const seen = new Set<string>();
  for (const { eli, spec } of specs) {
    if (seen.has(eli)) continue;
    seen.add(eli);
    if (opts.limit && result.records.length >= opts.limit) break;
    const meta = await fetchMeta(client, eli);
    if (!meta) {
      result.skipped.push({ what: eli, reason: "brak metadanych w ELI (404 lub błąd)" });
      continue;
    }
    if (meta.inForce === "NOT_IN_FORCE") {
      result.skipped.push({ what: eli, reason: `akt uchylony/nieobowiązujący (${meta.status})` });
      continue;
    }
    const text = await loadActText(client, meta, result, spec);
    if (!text) {
      result.skipped.push({ what: eli, reason: "brak dostępnego tekstu (HTML/PDF) lub brak pdftotext" });
      continue;
    }
    const n = emit(result, opts, meta, text, spec);
    opts.log(`  ELI ${eli}: ${n} rekordów (${text.kind}, ${meta.displayAddress})`);
    if (n === 0) result.skipped.push({ what: eli, reason: "po filtrach nie zostały żadne fragmenty" });
  }
  result.requests = client.requests;
  result.notes.push(
    "Teksty ujednolicone (PDF 'U') zamieniane na tekst narzędziem pdftotext; usunięto nagłówki i stopki stron. Rekord = artykuł (max 2 kawałki po 1200 znaków).",
  );
  return result;
}
