import type { Database } from "better-sqlite3";
import type { CorpusRecord, EvidenceAssessment, EvidenceCandidate, ReportWarning, RetrievalBranch, RetrievalQuery } from "../../shared/contracts";
import { detectInjection } from "../../security/detector";
import { DEFAULT_BRANCH_LIMIT, queryTexts } from "./bm25";
import { skipLookup, throwIfAborted } from "./errors";
import { buildMatchQuery } from "./fts";

const INCIDENT_LIMIT = 10;

/**
 * Gałąź incydentów (opcjonalna): przeszukuje incidents_fts treścią twierdzenia i zwraca rekordy korpusu
 * powiązane z incydentami (incidents.record_id). Zwracane są tylko rekordy, które istnieją w `records`,
 * więc kandydat zawsze wskazuje realny dowód.
 */
export function createIncidentBranch(db: Database): RetrievalBranch {
  let stmt: import("better-sqlite3").Statement | undefined;
  return {
    id: "incident",
    required: false,
    async search(q: RetrievalQuery): Promise<EvidenceCandidate[]> {
      throwIfAborted(q.signal);
      const match = buildMatchQuery(queryTexts(q));
      if (!match) return skipLookup(q);
      stmt ??= db.prepare(
        `SELECT i.record_id AS id, bm25(incidents_fts) AS s
           FROM incidents_fts
           JOIN incidents i ON i.rowid = incidents_fts.rowid
          WHERE incidents_fts MATCH ?
            AND i.record_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM records r WHERE r.id = i.record_id)
          ORDER BY s
          LIMIT ?`,
      );
      const rows = stmt.all(match, Math.min(q.limit ?? DEFAULT_BRANCH_LIMIT, INCIDENT_LIMIT * 3)) as {
        id: string;
        s: number;
      }[];
      throwIfAborted(q.signal);
      const seen = new Set<string>();
      const out: EvidenceCandidate[] = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue; // wiele incydentów → jeden rekord: zostaje najlepszy
        seen.add(row.id);
        out.push({ recordId: row.id, score: -row.s, via: "incident" });
        if (out.length >= INCIDENT_LIMIT) break;
      }
      return out;
    },
  };
}

/** Wyświetlamy tylko przypadki, w których ocena fragmentu potwierdziła zgodność sedna i czasu twierdzenia. */
export function narrativeLinks(
  assessmentsByClaim: ReadonlyMap<string, EvidenceAssessment[]>,
  records: ReadonlyMap<string, CorpusRecord>,
): NonNullable<ReportWarning["links"]> {
  const links = new Map<string, string>();
  for (const assessments of assessmentsByClaim.values()) {
    for (const a of assessments) {
      if (a.fixedRoleMatch !== "ta_sama" || !a.quoteVerified || a.excluded || a.verifier === "sprzeciw") continue;
      const record = records.get(a.recordId);
      if (record?.sourceId !== "euvsdisinfo" || !/^https:\/\/euvsdisinfo\.eu\/report\/[^\s/?#]+\/?$/u.test(record.url)) continue;
      if (detectInjection(record.title, "evidence", record.id).length > 0) continue;
      links.set(record.url, record.title);
    }
  }
  return Array.from(links, ([url, title]) => ({ url, title })).slice(0, 3);
}

// ───────────────────────── Dopasowanie domen incydentów (tylko ostrzeżenia) ─────────────────────────

/** Normalizuje host: małe litery, bez kropki końcowej, IDN → punycode. Bez usuwania „www.” i subdomen. */
function normalizeHost(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "" || !/^[\p{L}\p{N}.-]+$/u.test(h)) return null;
  try {
    const ascii = new URL(`http://${h}/`).hostname;
    return ascii === "" ? null : ascii;
  } catch {
    return null;
  }
}

/** Wpis domains_json może być hostem, hostem ze ścieżką albo pełnym URL-em. */
function hostFromListEntry(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const e = entry.trim();
  if (e === "") return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`);
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

const URL_WITH_SCHEME = /\bhttps?:\/\/[^\s<>"'`]+/giu;
// Host bez schematu (np. „przyklad.pl/wiadomosc”); lookbehind wyklucza domeny z adresów e-mail i fragmenty dłuższych nazw.
const BARE_HOST = /(?<![@\p{L}\p{N}._-])((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,})(?=[:/?#]|[\s,.;!?)\]}"'…]|$)/giu;

/** Wyciąga hosty z URL-i (ze schematem i bez) znalezionych w tekście. Dokładne hosty, bez dziedziczenia. */
export function extractHosts(urlOrText: string): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null) => {
    if (h) hosts.add(h);
  };
  const text = urlOrText.slice(0, 20_000);

  for (const m of text.matchAll(URL_WITH_SCHEME)) {
    try {
      add(normalizeHost(new URL(m[0].replace(/[.,;:!?)\]}…]+$/u, "")).hostname));
    } catch {
      /* niepoprawny URL — pomijamy */
    }
  }
  // Tekst bez schematów: usuwamy już rozpoznane URL-e, żeby nie liczyć ich dwa razy.
  const rest = text.replace(URL_WITH_SCHEME, " ");
  for (const m of rest.matchAll(BARE_HOST)) add(normalizeHost(m[1]!));
  return [...hosts];
}

/**
 * Dopasowanie DOKŁADNEGO hosta URL-i z wejścia do incidents.domains_json.
 * Wynik służy WYŁĄCZNIE do neutralnego ostrzeżenia (kind "incident_domain") — nigdy nie jest dowodem
 * i nie wpływa na werdykt (PLAN §3.4). Subdomeny i domeny nadrzędne NIE są dopasowywane
 * („blog.zla.pl” ≠ „zla.pl”).
 */
export function matchIncidentDomains(
  urlOrText: string,
  db: Database,
): { incidentId: string; title: string; url: string }[] {
  const hosts = new Set(extractHosts(urlOrText));
  if (hosts.size === 0) return [];
  const rows = db
    .prepare(`SELECT id, title, url, domains_json FROM incidents WHERE domains_json IS NOT NULL`)
    .all() as { id: string; title: string | null; url: string | null; domains_json: string }[];
  const out: { incidentId: string; title: string; url: string }[] = [];
  for (const row of rows) {
    let list: unknown;
    try {
      list = JSON.parse(row.domains_json);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const hit = list.some((entry) => {
      const h = hostFromListEntry(entry);
      return h !== null && hosts.has(h);
    });
    if (hit) out.push({ incidentId: row.id, title: row.title ?? "", url: row.url ?? "" });
  }
  return out;
}
