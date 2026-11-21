/**
 * Ingestia oficjalnych źródeł o przywództwie UE (pytania „Kto jest przewodniczącym Komisji Europejskiej / wysokim przedstawicielem?”,
 * „Kto jest polskim europosłem?”):
 *   1. Kolegium Komisarzy — https://commission.europa.eu/about/organisation/college-commissioners_en
 *      (Przewodnicząca, wiceprzewodniczący wykonawczy, wysoka przedstawiciel, komisarze: imię i nazwisko + teka — dosłownie ze strony),
 *   2. Polscy posłowie do Parlamentu Europejskiego — oficjalny portal otwartych danych PE
 *      (https://data.europarl.europa.eu/api/v2/meps/show-current?country-of-representation=PL): zdania WYGENEROWANE z pól API
 *      (tag „generated-from-data”); url = wpis posła w API.
 * Czego NIE ma: Rada Europejska (consilium.europa.eu) blokuje boty wyzwaniem Cloudflare (HTTP 403) — nie obchodzimy;
 * strona Parlamentu (europarl.europa.eu) zwraca 403. Strona Kolegium nie podaje narodowości komisarzy, więc rekordów nie
 * oznaczamy jako „polski komisarz”.
 */
import type { CorpusRecord } from "../../shared/contracts";
import {
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  newResult,
  parseHtmlPage,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

export const COLLEGE_URL = "https://commission.europa.eu/about/organisation/college-commissioners_en";
export const MEP_LIST_URL = "https://data.europarl.europa.eu/api/v2/meps/show-current?country-of-representation=PL&format=application%2Fld%2Bjson&offset=0&limit=100";

// ───────────────────────────── Kolegium Komisarzy ─────────────────────────────

export interface CommissionMember {
  /** Nagłówek grupy ze strony: „The President”, „Executive Vice-Presidents and High Representative”, „Vice-President”, „Commissioners”. */
  group: string;
  name: string;
  /** Dosłowny opis teki (jeden lub kilka akapitów złączonych spacją); pusty dla Przewodniczącej. */
  portfolio: string;
}

const COLLEGE_GROUPS = /^(The President|Executive Vice-Presidents(?: and High Representative)?|Vice-Presidents?|Commissioners)$/;

export function parseCollege(html: string): CommissionMember[] {
  const { document } = parseHtmlPage(html);
  const out: CommissionMember[] = [];
  let group = "";
  for (const el of Array.from(document.querySelectorAll("h2, h3, article.ecl-content-item"))) {
    const tag = el.tagName.toLowerCase();
    if (tag === "h2") {
      // Sekcja „Composition” kończy się następnym nagłówkiem h2 (np. „Latest”) — dalsze karty to aktualności, nie osoby.
      group = "";
      continue;
    }
    if (tag === "h3") {
      const t = squash(el.textContent ?? "");
      if (COLLEGE_GROUPS.test(t)) group = t;
      continue;
    }
    if (!group) continue;
    const name = squash(el.querySelector(".ecl-content-block__title a")?.textContent ?? "");
    if (!name) continue;
    const portfolio = Array.from(el.querySelectorAll(".ecl-content-block__description p"))
      .map((p) => squash(p.textContent ?? ""))
      .filter(Boolean)
      .join(" ");
    out.push({ group, name, portfolio });
  }
  return out;
}

export function commissionText(m: CommissionMember): string {
  return m.portfolio ? `${m.name} ${m.portfolio}` : `${m.group} ${m.name}`;
}

/** Polski opis stanowiska do tytułu rekordu (tytuł nie jest cytatem; tekst pozostaje dosłowny). */
export function commissionRoleGloss(m: CommissionMember): string {
  if (m.group === "The President") return "President of the European Commission (przewodniczący Komisji Europejskiej)";
  if (/^High Representative for Foreign Affairs/.test(m.portfolio)) {
    return "High Representative / Vice-President (wysoki przedstawiciel UE do spraw zagranicznych i polityki bezpieczeństwa)";
  }
  return m.portfolio || m.group;
}

// ───────────────────────────── Posłowie do PE z Polski ─────────────────────────────

export interface MepListItem {
  identifier: string;
  givenName: string;
  familyName: string;
  group: string;
  country: string;
}

export function parseMepList(json: unknown): MepListItem[] {
  const data = (json as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: MepListItem[] = [];
  for (const d of data) {
    const identifier = String(d.identifier ?? "");
    const given = squash(String(d.givenName ?? ""));
    const family = squash(String(d.familyName ?? ""));
    const group = squash(String(d["api:political-group"] ?? ""));
    const country = squash(String(d["api:country-of-representation"] ?? ""));
    if (identifier && given && family && group) out.push({ identifier, givenName: given, familyName: family, group, country });
  }
  return out;
}

/** Pełne nazwy grup w PE (angielskie nazwy oficjalne; kod pozostaje taki, jak w API). */
export const EP_GROUPS: Record<string, string> = {
  PPE: "Group of the European People's Party (Christian Democrats)",
  "S&D": "Progressive Alliance of Socialists and Democrats",
  ECR: "European Conservatives and Reformists Group",
  PfE: "Patriots for Europe Group",
  ESN: "Europe of Sovereign Nations Group",
  Renew: "Renew Europe Group",
  "Verts/ALE": "Greens/European Free Alliance",
  "The Left": "The Left in the European Parliament",
  NI: "Non-attached Members",
};

export function mepSentence(m: MepListItem): string {
  const gname = EP_GROUPS[m.group];
  return (
    `${m.givenName} ${m.familyName} - poseł/posłanka do Parlamentu Europejskiego (państwo reprezentowane: ${m.country === "PL" ? "Polska, PL" : m.country}); ` +
    `grupa polityczna w PE: ${m.group}${gname ? ` (${gname})` : ""}; obecny członek PE według portalu otwartych danych PE.`
  );
}

// ───────────────────────────── Ingestia ─────────────────────────────

export async function ingestEuLeadership(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("eu-leadership");
  const client = new PoliteClient({ refresh: opts.refresh });

  try {
    const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "ec-commission"));
    const res = await client.get(COLLEGE_URL);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const members = parseCollege(res.body);
    if (members.length < 20) throw new Error(`za mało członków Kolegium (${members.length}) — zmiana układu strony?`);
    for (const m of members) {
      const rec: CorpusRecord = {
        ...base,
        id: recordId("ec-commission", `${COLLEGE_URL}|${m.name}`),
        url: res.finalUrl,
        title: `Komisja Europejska (Kolegium Komisarzy): ${m.name} - ${commissionRoleGloss(m)}`,
        publishedAt: null,
        fetchedAt: res.fetchedAt,
        lang: "en",
        text: commissionText(m),
        topics: [
          "kto-jest",
          "funkcja-publiczna",
          "urzednicy",
          "unia-europejska",
          "komisja-europejska",
          "kolegium-komisarzy",
          ...(m.group === "The President" ? ["przewodniczacy-komisji"] : []),
          ...(/^High Representative/.test(m.portfolio) ? ["wysoki-przedstawiciel"] : []),
        ],
        origin: "corpus",
      };
      result.records.push(rec);
    }
    opts.log(`  Kolegium Komisarzy: ${members.length} osób`);
  } catch (e) {
    result.skipped.push({ what: COLLEGE_URL, reason: (e as Error).message });
  }

  try {
    const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "ep-open-data"));
    const res = await client.get(MEP_LIST_URL, { accept: "application/ld+json" });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const meps = parseMepList(JSON.parse(res.body)).filter((m) => m.country === "PL");
    if (meps.length === 0) throw new Error("brak posłów z Polski w odpowiedzi API (zmiana formatu?)");
    for (const m of meps) {
      const url = `https://data.europarl.europa.eu/api/v2/meps/${m.identifier}`;
      const rec: CorpusRecord = {
        ...base,
        id: recordId("ep-open-data", url),
        url,
        title: `Poseł/posłanka do PE z Polski: ${m.givenName} ${m.familyName} - ${m.group}`,
        publishedAt: null,
        fetchedAt: res.fetchedAt,
        lang: "pl",
        text: mepSentence(m),
        topics: ["generated-from-data", "kto-jest", "funkcja-publiczna", "urzednicy", "unia-europejska", "parlament-europejski", "europosel", "polska", `pe-${m.group.toLowerCase().replace(/[^a-z]/g, "")}`],
        origin: "corpus",
      };
      result.records.push(rec);
    }
    opts.log(`  Posłowie do PE z Polski: ${meps.length}`);
  } catch (e) {
    result.skipped.push({ what: MEP_LIST_URL, reason: (e as Error).message });
  }

  result.requests = client.requests;
  result.notes.push(
    "Kolegium Komisarzy: imię i nazwisko + teka dosłownie ze strony (strona nie podaje narodowości). Posłowie do PE z Polski: zdania generowane z pól API " +
      "(tag generated-from-data), url = wpis posła. Rada Europejska (consilium.europa.eu) i europarl.europa.eu blokują boty (HTTP 403) — pominięte.",
  );
  return result;
}
