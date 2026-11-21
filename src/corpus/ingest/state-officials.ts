/**
 * Ingestia stron urzędowych o głowie państwa i Prezydium Senatu (pytania „Kto jest Prezydentem / Marszałkiem Senatu?”):
 *   - https://www.prezydent.pl/prezydent/biografia  (Oficjalna strona Prezydenta RP),
 *   - https://www.senat.gov.pl/sklad/senatorowie/prezydium.html (Prezydium Senatu: Marszałek i wicemarszałkowie).
 * Tekst rekordu jest dosłowny (po normalizacji białych znaków): dla Prezydenta — tytuł strony (nagłówek h1) i zdania o objęciu
 * urzędu; dla Senatu — „imię i nazwisko” + „funkcja” tak, jak stoją obok siebie na liście Prezydium. Cytaty <= 300 znaków.
 * publishedAt: prezydent.pl podaje metadane og:article:modified_time / published_time (bierzemy ostatnią modyfikację);
 * senat.gov.pl nie podaje daty — publishedAt = null.
 */
import type { CorpusRecord } from "../../shared/contracts";
import {
  MAX_QUOTE_CHARS,
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  clipVerbatim,
  newResult,
  parseHtmlPage,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

export const PRESIDENT_URL = "https://www.prezydent.pl/prezydent/biografia";
export const SENATE_PRESIDIUM_URL = "https://www.senat.gov.pl/sklad/senatorowie/prezydium.html";

// ───────────────────────────── Prezydent RP ─────────────────────────────

export interface PresidentPage {
  /** Dosłowny nagłówek strony, np. „Dr Karol Nawrocki – Prezydent Rzeczypospolitej Polskiej”. */
  heading: string;
  /** Zdania o objęciu urzędu (dosłowne): najpierw samo objęcie urzędu, potem (jeśli jest) zdanie o wyborze. */
  officeSentences: string[];
  /** Data (RRRR-MM-DD) z og:article:modified_time, a gdy brak — og:article:published_time; inaczej null. */
  date: string | null;
}

function metaDate(meta: Record<string, string>): string | null {
  for (const k of ["og:article:modified_time", "article:modified_time", "og:article:published_time", "article:published_time"]) {
    const v = meta[k];
    const m = v ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null;
    if (m) return m[1]!;
  }
  return null;
}

export function parsePresidentPage(html: string): PresidentPage | null {
  const parsed = parseHtmlPage(html);
  const lines = parsed.text.split("\n");
  // Nagłówek h1 bywa w <header> (usuwanym przy czytaniu treści), więc czytamy go osobnym przebiegiem.
  const heading = parseHtmlPage(html, "h1")
    .text.split("\n")
    .find((l) => /Prezydent Rzeczypospolitej Polskiej$/.test(l) && l.length < 120 && / [–-] /.test(l));
  if (!heading) return null;
  const sentences: string[] = [];
  for (const line of lines) {
    if (!/(Urząd ten objął|objął urząd|złożył przysięgę|składając przysięgę)/.test(line)) continue;
    const parts = line.split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9„"(])/);
    // zdanie o objęciu urzędu + poprzednie (wybór w wyborach), jeśli jest
    const idx = parts.findIndex((p) => /(Urząd ten objął|objął urząd)/.test(p));
    if (idx >= 0) {
      sentences.push(parts[idx]!.trim());
      if (idx > 0 && /wybor/i.test(parts[idx - 1]!)) sentences.push(parts[idx - 1]!.trim());
      break;
    }
  }
  return { heading: squash(heading), officeSentences: sentences, date: metaDate(parsed.meta) };
}

export function presidentText(p: PresidentPage): string {
  const chosen = [p.heading];
  let len = p.heading.length;
  for (const s of p.officeSentences) {
    if (len + 1 + s.length <= MAX_QUOTE_CHARS) {
      chosen.push(s);
      len += 1 + s.length;
    }
  }
  if (chosen.length === 1 && p.officeSentences.length) {
    const room = MAX_QUOTE_CHARS - len - 1;
    const clipped = room > 60 ? clipVerbatim(p.officeSentences[p.officeSentences.length - 1]!, room) : "";
    if (clipped) chosen.push(clipped);
  }
  return chosen.join("\n");
}

// ───────────────────────────── Prezydium Senatu ─────────────────────────────

export interface SenatePresidiumMember {
  name: string;
  role: string;
  href: string;
}

/** Lista Prezydium z kafelków `.senator-kontener`: link (imię i nazwisko) + `span` (funkcja). */
export function parseSenatePresidium(html: string): SenatePresidiumMember[] {
  const { document } = parseHtmlPage(html);
  const out: SenatePresidiumMember[] = [];
  for (const box of Array.from(document.querySelectorAll(".senator-kontener"))) {
    const a = box.querySelector("a[href*='senator,']");
    const role = squash(box.querySelector("a + span, span")?.textContent ?? "");
    const name = squash(a?.textContent ?? "");
    const href = a?.getAttribute("href") ?? "";
    if (name && role && href && /^(Marszałek|Wicemarszałek)/.test(role)) out.push({ name, role, href });
  }
  return out;
}

/** „Marszałek” → „Marszałek Senatu”, „Wicemarszałek” → „Wicemarszałek Senatu” (tylko do tytułu rekordu). */
export function senateRoleLabel(role: string): string {
  return /Senatu$/.test(role) ? role : `${role} Senatu`;
}

// ───────────────────────────── Ingestia ─────────────────────────────

export async function ingestStateOfficials(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("state-officials");
  const client = new PoliteClient({ refresh: opts.refresh });

  // Prezydent RP
  try {
    const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "prezydent-pl"));
    const res = await client.get(PRESIDENT_URL);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const page = parsePresidentPage(res.body);
    if (!page) throw new Error("nie znaleziono nagłówka z urzędem Prezydenta (zmiana układu strony?)");
    const rec: CorpusRecord = {
      ...base,
      id: recordId("prezydent-pl", `${PRESIDENT_URL}|prezydent`),
      url: res.finalUrl,
      title: `Prezydent Rzeczypospolitej Polskiej: ${page.heading}`,
      publishedAt: page.date,
      fetchedAt: res.fetchedAt,
      lang: "pl",
      text: presidentText(page),
      topics: ["kto-jest", "funkcja-publiczna", "urzednicy", "prezydent", "glowa-panstwa", "kprp"],
      origin: "corpus",
    };
    result.records.push(rec);
    opts.log(`  Prezydent RP: „${page.heading}” (data strony: ${page.date ?? "brak"})`);
  } catch (e) {
    result.skipped.push({ what: PRESIDENT_URL, reason: (e as Error).message });
  }

  // Prezydium Senatu
  try {
    const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "senat-pl"));
    const res = await client.get(SENATE_PRESIDIUM_URL);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const members = parseSenatePresidium(res.body);
    if (members.length === 0) throw new Error("lista Prezydium Senatu jest pusta (zmiana układu strony?)");
    for (const m of members) {
      const rec: CorpusRecord = {
        ...base,
        id: recordId("senat-pl", `${SENATE_PRESIDIUM_URL}|${m.name}|${m.role}`),
        url: res.finalUrl,
        title: `Prezydium Senatu RP: ${m.name} - ${senateRoleLabel(m.role)}`,
        publishedAt: null,
        fetchedAt: res.fetchedAt,
        lang: "pl",
        text: `${m.name} ${m.role}`,
        topics: ["kto-jest", "funkcja-publiczna", "urzednicy", "senat", "prezydium-senatu", m.role.startsWith("Wice") ? "wicemarszalek-senatu" : "marszalek-senatu"],
        origin: "corpus",
      };
      result.records.push(rec);
    }
    opts.log(`  Prezydium Senatu: ${members.map((m) => `${m.name} (${m.role})`).join(", ")}`);
  } catch (e) {
    result.skipped.push({ what: SENATE_PRESIDIUM_URL, reason: (e as Error).message });
  }

  result.requests = client.requests;
  result.notes.push(
    "Prezydent RP: nagłówek strony biografii + zdania o objęciu urzędu (dosłownie, <= 300 zn.); data z metadanych og:article:modified_time. " +
      "Prezydium Senatu: „imię i nazwisko” + „funkcja” z kafelków listy (publishedAt = null — strona nie podaje daty).",
  );
  return result;
}
