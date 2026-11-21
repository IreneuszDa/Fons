/**
 * Ingestia oficjalnego API Sejmu (https://api.sejm.gov.pl/sejm/term{N}): posłowie bieżącej kadencji, kluby i koła poselskie,
 * oraz Marszałek Sejmu.
 *
 *  - Rekord posła i klubu jest zdaniem WYGENEROWANYM z pól API (tag tematu „generated-from-data”); pola są dosłowne
 *    (imię i nazwisko, klub, okręg, status mandatu). `url` = dokładny adres wpisu posła (…/MP/{id}) albo klubu
 *    (…/clubs/{id}); `publishedAt` = null (API nie podaje daty publikacji wpisu — nie zgadujemy). Nie zapisujemy danych
 *    prywatnych (adres e-mail, data i miejsce urodzenia, wykształcenie, wynik wyborczy).
 *  - Marszałek Sejmu: API Sejmu nie ma pola funkcji, więc bierzemy najnowsze „Obwieszczenie Marszałka Sejmu” z Dziennika
 *    Ustaw / Monitora Polskiego (ELI) i dosłowną linię podpisu „Marszałek Sejmu: X. Nazwisko” z jego PDF. Imię uzupełniamy
 *    w tytule rekordu tylko wtedy, gdy inicjał i nazwisko pasują do dokładnie jednego posła z API.
 *  - robots.txt hosta (api.sejm.gov.pl) zezwala na wszystko; <= 1 żądanie/s.
 */
import type { CorpusRecord } from "../../shared/contracts";
import { pdfToText } from "./eli";
import {
  PoliteClient,
  type IngestOptions,
  type IngestResult,
  baseFromCatalog,
  newResult,
  recordId,
  sourceFromCatalog,
  squash,
} from "./common";

const API = "https://api.sejm.gov.pl";

export interface SejmMp {
  id: number;
  firstName: string;
  lastName: string;
  firstLastName: string;
  club: string;
  active: boolean;
  districtNum?: number;
  districtName?: string;
  voivodeship?: string;
  inactiveCause?: string;
  mandateExpiryDate?: string;
  waiverDesc?: string;
}

export interface SejmClub {
  id: string;
  name: string;
  membersCount: number;
  members?: { firstName: string; lastName: string; function?: string }[];
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
export function romanTerm(n: number): string {
  return ROMAN[n] ?? String(n);
}

const CAUSE_PL: Record<string, string> = { Zrzeczenie: "zrzeczenie się mandatu", Zgon: "zgon" };

/** Zdanie o pośle wygenerowane z pól API (patrz nagłówek pliku). */
export function mpSentence(mp: SejmMp, clubs: Map<string, SejmClub>, term: number): string {
  const kad = `${romanTerm(term)} kadencji`;
  const club = clubs.get(mp.club);
  const clubText =
    mp.club === "niez."
      ? "poseł niezrzeszony (nie należy do żadnego klubu ani koła poselskiego)"
      : `klub lub koło poselskie: ${club ? `${club.name} (${mp.club})` : mp.club}`;
  const where = [mp.districtNum !== undefined ? `okręg wyborczy nr ${mp.districtNum}${mp.districtName ? ` ${mp.districtName}` : ""}` : "", mp.voivodeship ? `województwo ${mp.voivodeship}` : ""]
    .filter(Boolean)
    .join(", ");
  if (mp.active) {
    return `${mp.firstLastName} - poseł/posłanka na Sejm RP ${kad}: ${clubText}${where ? `; ${where}` : ""}; mandat poselski aktywny według API Sejmu.`;
  }
  const cause = mp.inactiveCause ? CAUSE_PL[mp.inactiveCause] ?? mp.inactiveCause.toLowerCase() : "nieznana przyczyna";
  const waiver = mp.waiverDesc ? `; opis w API Sejmu: „${squash(mp.waiverDesc)}”` : "";
  return (
    `${mp.firstLastName} - były poseł/posłanka Sejmu RP ${kad}: według API Sejmu mandat jest nieaktywny` +
    `${mp.mandateExpiryDate ? ` (wygasł ${mp.mandateExpiryDate}` : " ("}, przyczyna: ${cause}${waiver}); ostatnio ${mp.club === "niez." ? "poseł niezrzeszony" : `klub lub koło: ${club ? `${club.name} (${mp.club})` : mp.club}`}.`
  );
}

/** Zdanie o klubie/kole: liczba członków i funkcje kierownicze z API. */
export function clubSentence(club: SejmClub, term: number): string {
  const lead = (fn: RegExp) =>
    (club.members ?? [])
      .filter((m) => m.function && fn.test(m.function))
      .map((m) => `${m.firstName} ${m.lastName}`);
  const chairs = lead(/^przewodnicz/);
  const deputies = lead(/^wiceprzewodnicz/);
  const parts = [`${club.name} (${club.id}) - klub lub koło poselskie w Sejmie RP ${romanTerm(term)} kadencji; według API Sejmu liczy ${club.membersCount} członków.`];
  if (chairs.length) parts.push(`Przewodniczący/przewodnicząca: ${chairs.join(", ")}.`);
  if (deputies.length) parts.push(`Wiceprzewodniczący/wiceprzewodnicząca: ${deputies.join(", ")}.`);
  return parts.join(" ");
}

/** Liczebność Sejmu z listy posłów (generowane). */
export function compositionSentence(mps: SejmMp[], term: number): string {
  const active = mps.filter((m) => m.active);
  const byClub = new Map<string, number>();
  for (const m of active) byClub.set(m.club, (byClub.get(m.club) ?? 0) + 1);
  const clubs = [...byClub.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c === "niez." ? "niezrzeszeni" : c}: ${n}`);
  return (
    `Według API Sejmu w Sejmie RP ${romanTerm(term)} kadencji mandat poselski sprawuje ${active.length} posłów; ` +
    `na liście posłów tej kadencji jest łącznie ${mps.length} osób, w tym ${mps.length - active.length} z nieaktywnym mandatem. ` +
    `Posłowie z aktywnym mandatem według klubów i kół: ${clubs.join(", ")}.`
  );
}

/** Linia podpisu z tekstu PDF obwieszczenia: „Marszałek Sejmu: W. Czarzasty”. */
export function parseMarshalSignature(pdfText: string): { line: string; initial: string; surname: string } | null {
  const flat = pdfText.replace(/\r/g, "").split("\n");
  for (const l of flat) {
    const m = /^\s*(Marszałek Sejmu:\s*([A-ZĄĆĘŁŃÓŚŹŻ])\.\s*([\p{L}-]+(?:\s+[\p{L}-]+)?))\s*$/u.exec(l);
    if (m) return { line: squash(m[1]!), initial: m[2]!, surname: m[3]!.trim() };
  }
  return null;
}

interface ActListItem {
  ELI: string;
  title: string;
  announcementDate: string;
  promulgation?: string;
  displayAddress?: string;
  texts?: { fileName: string; type: string }[];
}

export async function ingestSejmMp(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("sejm-mp");
  result.fileId = "sejm-mp";
  const client = new PoliteClient({ refresh: opts.refresh });
  const base = baseFromCatalog(sourceFromCatalog(opts.catalog, "sejm-eli"));
  const publisher = "Sejm Rzeczypospolitej Polskiej (API Sejmu)";

  // 1. Bieżąca kadencja.
  const terms = await client.getJson<{ num: number; current: boolean; from: string }[]>(`${API}/sejm/term`);
  const current = terms.data.find((t) => t.current);
  if (!current) throw new Error("API Sejmu nie wskazuje bieżącej kadencji");
  const term = current.num;
  const kad = romanTerm(term);
  const period = `${kad} kadencja Sejmu (od ${current.from})`;
  opts.log(`  bieżąca kadencja Sejmu: ${term} (od ${current.from})`);

  // 2. Kluby i posłowie.
  const clubsRes = await client.getJson<SejmClub[]>(`${API}/sejm/term${term}/clubs`);
  const clubs = new Map(clubsRes.data.map((c) => [c.id, c]));
  const mpRes = await client.getJson<SejmMp[]>(`${API}/sejm/term${term}/MP`);
  const mps = mpRes.data;
  opts.log(`  posłowie: ${mps.length} (aktywnych ${mps.filter((m) => m.active).length}), kluby: ${clubs.size}`);

  for (const club of clubsRes.data) {
    const url = `${API}/sejm/term${term}/clubs/${encodeURIComponent(club.id)}`;
    const rec: CorpusRecord = {
      ...base,
      publisher,
      id: recordId("sejm-eli", `${url}|klub`),
      url,
      title: `Klub lub koło poselskie ${club.id}: ${club.name} (Sejm ${kad} kadencji)`,
      publishedAt: null,
      fetchedAt: clubsRes.res.fetchedAt,
      lang: "pl",
      text: clubSentence(club, term),
      topics: ["generated-from-data", "kto-jest", "sejm", "klub-poselski", "posel", club.id.toLowerCase()],
      period,
      origin: "corpus",
    };
    result.records.push(rec);
  }

  {
    const url = `${API}/sejm/term${term}/MP`;
    result.records.push({
      ...base,
      publisher,
      id: recordId("sejm-eli", `${url}|sklad`),
      url,
      title: `Skład Sejmu RP ${kad} kadencji: liczba posłów i kluby`,
      publishedAt: null,
      fetchedAt: mpRes.res.fetchedAt,
      lang: "pl",
      text: compositionSentence(mps, term),
      topics: ["generated-from-data", "sejm", "klub-poselski", "posel", "sklad-sejmu"],
      period,
      origin: "corpus",
    });
  }

  for (const mp of mps) {
    const url = `${API}/sejm/term${term}/MP/${mp.id}`;
    const clubShort = mp.club === "niez." ? "niezrzeszony" : mp.club;
    const rec: CorpusRecord = {
      ...base,
      publisher,
      id: recordId("sejm-eli", `${url}|posel`),
      url,
      title: mp.active
        ? `Poseł/posłanka ${mp.firstLastName} - ${clubShort} (Sejm ${kad} kadencji)`
        : `Były poseł/posłanka ${mp.firstLastName} - mandat nieaktywny (Sejm ${kad} kadencji)`,
      publishedAt: null,
      fetchedAt: mpRes.res.fetchedAt,
      lang: "pl",
      text: mpSentence(mp, clubs, term),
      topics: ["generated-from-data", "kto-jest", "sejm", "posel", "klub-poselski", mp.active ? "mandat-aktywny" : "mandat-wygasly", ...(mp.club === "niez." ? ["niezrzeszony"] : [mp.club.toLowerCase()])],
      period,
      origin: "corpus",
    };
    result.records.push(rec);
  }

  // 3. Marszałek Sejmu — najnowsze obwieszczenie Marszałka Sejmu z podpisem.
  try {
    const year = new Date().getUTCFullYear();
    const found: ActListItem[] = [];
    for (const y of [year, year - 1]) {
      const list = await client.getJson<{ items: ActListItem[] }>(
        `${API}/eli/acts/search?title=${encodeURIComponent("Obwieszczenie Marszałka Sejmu")}&year=${y}&limit=100`,
      );
      found.push(...list.data.items.filter((i) => /^Obwieszczenie Marszałka Sejmu/.test(i.title)));
      if (found.length >= 3) break;
    }
    found.sort((a, b) => (b.promulgation ?? b.announcementDate).localeCompare(a.promulgation ?? a.announcementDate));
    let done = false;
    for (const act of found.slice(0, 5)) {
      const file = act.texts?.find((t) => t.type === "O")?.fileName;
      if (!file) continue;
      const pdfUrl = `${API}/eli/acts/${act.ELI}/text/O/${file}`;
      const bin = await client.getBinary(pdfUrl);
      const sig = parseMarshalSignature(await pdfToText(bin.data));
      if (!sig) {
        result.skipped.push({ what: pdfUrl, reason: "brak linii podpisu „Marszałek Sejmu: …”" });
        continue;
      }
      const candidates = mps.filter((m) => m.lastName === sig.surname && m.firstName.startsWith(sig.initial));
      const full = candidates.length === 1 ? candidates[0]!.firstLastName : null;
      const published = act.promulgation ?? act.announcementDate;
      result.records.push({
        ...base,
        publisher: "Dziennik Ustaw / Monitor Polski (Kancelaria Sejmu, ELI)",
        id: recordId("sejm-eli", `${pdfUrl}|marszalek`),
        url: pdfUrl,
        title: `Marszałek Sejmu RP${full ? ` ${full}` : ""} - podpis pod obwieszczeniem Marszałka Sejmu (${act.displayAddress ?? act.ELI}, ${published})`,
        publishedAt: published,
        fetchedAt: bin.fetchedAt,
        lang: "pl",
        text: sig.line,
        topics: ["kto-jest", "funkcja-publiczna", "sejm", "marszalek-sejmu", "urzednicy"],
        origin: "corpus",
      });
      opts.log(`  Marszałek Sejmu: „${sig.line}” (${act.ELI}, ${published})${full ? ` = ${full}` : ""}`);
      done = true;
      break;
    }
    if (!done) result.skipped.push({ what: "Marszałek Sejmu", reason: "nie znaleziono obwieszczenia z podpisem" });
  } catch (e) {
    result.skipped.push({ what: "Marszałek Sejmu", reason: (e as Error).message });
  }

  result.requests = client.requests;
  result.notes.push(
    `API Sejmu, kadencja ${term}: zdania o posłach i klubach generowane z pól API (tag generated-from-data), url = adres wpisu; publishedAt = null; ` +
      "bez danych prywatnych. Marszałek Sejmu: dosłowna linia podpisu z najnowszego obwieszczenia Marszałka Sejmu (ELI).",
  );
  return result;
}
