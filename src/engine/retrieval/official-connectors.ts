/**
 * Konektory oficjalnych kanałów — czyste funkcje: surowa odpowiedź serwisu → szkice rekordów (tytuł, treść, data).
 * Bez sieci i bez modelu. Treść rekordu składa kod wyłącznie z pól odpowiedzi serwisu; jedyne dopisane słowa to
 * etykiety pól, takie same jak na stronie serwisu („Ogólny poziom ostrzeżenia dla kraju”, „Ostatnia aktualizacja”).
 *
 *  - Odyseusz (MSZ): profil kraju (poziom ostrzeżenia, komunikat, bezpieczeństwo, wjazd) i strony tematyczne,
 *  - gov.pl: lista aktualności / komunikatów (data, tytuł, zajawka każdej pozycji).
 *  - RCB: raport dobowy z datą wydania i treścią sekcji.
 *  - RSO: regionalne ostrzeżenia gov.pl z obszarem i okresem obowiązywania.
 */
import { parseHTML } from "linkedom";
import { z } from "zod";
import { MONTHS_GENITIVE_PL } from "../../security/dates";
import { chunkText, PASSAGE_MAX_CHARS } from "./live-score";
import { foldedWords, matchesAny, rsoRoadNumbers, type RsoLookup } from "./official-plan";

export interface RecordDraft {
  url: string;
  title: string;
  text: string;
  /** ISO 8601 albo null, gdy serwis nie podaje daty. */
  publishedAt: string | null;
}

const MAX_TEXT = PASSAGE_MAX_CHARS - 100;

/** Usuwa wiersze „Zobacz więcej na stronie: [odsyłacz]”, odsyłacze markdown („[tekst](adres)” → „tekst”), znaczniki list i nadmiar odstępów. */
export function cleanOfficialText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/Zobacz więcej na stronie:?\s*(?:\[[^\]]*\]\([^)]*\)\s*)*/gi, " ")
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/(^|\n)\s*[-•]\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(s: string, max: number = MAX_TEXT): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return `${s.slice(0, cut > max * 0.6 ? cut : max).trim()}…`;
}

function endSentence(s: string): string {
  return s === "" || /[.!?…”"]$/.test(s) ? s : `${s}.`;
}

/** „2026-10-29” → ISO; nieczytelna data → null. */
export function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ───────────────────────────── Odyseusz: profil kraju ─────────────────────────────

const Coded = z.object({ kod: z.string().optional(), opis: z.string().optional() }).passthrough();

const Profile = z
  .object({
    nazwa: z.string().min(1),
    dataAktualizacji: z.string().nullish(),
    trescPowiadomieniaDluga: z.string().nullish(),
    ostrzezenia: z
      .array(
        z
          .object({
            dataObowiazywaniaOd: z.string().nullish(),
            tresc: z.string().nullish(),
            poziomZagrozenia: Coded.nullish(),
            zakresTerytorialnyOstrzezenia: Coded.nullish(),
            regiony: z.array(z.unknown()).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    sekcje: z
      .array(
        z
          .object({
            zakresInformacyjny: Coded.nullish(),
            podsumowanie: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/** Sekcje profilu, które mówią o bezpieczeństwie i zasadach wjazdu (reszta — zdrowie, obyczaje — nie jest pobierana). */
const PROFILE_SECTIONS = new Set(["BEZPIECZENSTWO", "PODROZOWANIE"]);
const BASE_SCOPE = "BAZOWY_DLA_KRAJU";

function regionNames(regiony: unknown[] | null | undefined): string {
  const names = (regiony ?? [])
    .map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        for (const k of ["nazwa", "opis", "name"]) if (typeof o[k] === "string") return o[k] as string;
      }
      return "";
    })
    .map((n) => cleanOfficialText(n))
    .filter(Boolean);
  return names.join(", ");
}

/**
 * Profil kraju z serwisu MSZ Odyseusz → rekordy: (1) poziom ostrzeżenia dla kraju i ostrzeżenia regionalne,
 * data aktualizacji, bieżący komunikat; (2…) streszczenia sekcji „Bezpieczeństwo” i „Podróżowanie”.
 * Zwraca pustą listę, gdy odpowiedź nie ma oczekiwanego kształtu.
 */
export function odyseuszProfileDrafts(json: unknown, pageUrl: string): RecordDraft[] {
  const parsed = Profile.safeParse(json);
  if (!parsed.success) return [];
  const p = parsed.data;
  const country = cleanOfficialText(p.nazwa);
  const publishedAt = isoDate(p.dataAktualizacji);
  const out: RecordDraft[] = [];

  const parts: string[] = [`${country} — ostrzeżenia dla podróżujących Ministerstwa Spraw Zagranicznych (serwis Odyseusz).`];
  for (const w of p.ostrzezenia ?? []) {
    const level = cleanOfficialText(w.poziomZagrozenia?.opis);
    if (!level) continue;
    const base = !w.zakresTerytorialnyOstrzezenia?.kod || w.zakresTerytorialnyOstrzezenia.kod === BASE_SCOPE;
    const regions = regionNames(w.regiony);
    const head = base
      ? `Ogólny poziom ostrzeżenia dla kraju: ${level}.`
      : `Ostrzeżenie regionalne${regions ? ` (${regions})` : ""}: ${level}.`;
    const since = w.dataObowiazywaniaOd ? ` Obowiązuje od ${w.dataObowiazywaniaOd}.` : "";
    parts.push(`${head} ${endSentence(cleanOfficialText(w.tresc))}${since}`.replace(/\s+/g, " ").trim());
  }
  if (p.dataAktualizacji) parts.push(`Ostatnia aktualizacja profilu kraju: ${p.dataAktualizacji}.`);
  const notice = cleanOfficialText(p.trescPowiadomieniaDluga);
  if (notice) parts.push(`Komunikat: ${endSentence(notice)}`);
  if (parts.length > 1) {
    out.push({
      url: pageUrl,
      title: `MSZ (Odyseusz): ${country} — ostrzeżenia dla podróżujących`,
      text: cap(parts.join(" ")),
      publishedAt,
    });
  }

  for (const s of p.sekcje ?? []) {
    const code = s.zakresInformacyjny?.kod ?? "";
    const summary = cleanOfficialText(s.podsumowanie);
    if (!PROFILE_SECTIONS.has(code) || !summary) continue;
    const label = cleanOfficialText(s.zakresInformacyjny?.opis) || code;
    out.push({
      url: pageUrl,
      title: `MSZ (Odyseusz): ${country} — ${label}`,
      text: cap(`${country} — ${label} (informacje MSZ dla podróżujących). ${summary}`),
      publishedAt,
    });
  }
  return out;
}

// ───────────────────────────── Odyseusz: strona tematyczna ─────────────────────────────

const TopicSection = z
  .object({
    tytul: z.string().nullish(),
    tresc: z.string().nullish(),
    podsekcje: z.array(z.object({ tytul: z.string().nullish(), tresc: z.string().nullish() }).passthrough()).nullish(),
  })
  .passthrough();

const TopicPage = z.object({ nazwa: z.string().min(1), sekcje: z.array(TopicSection).nullish() }).passthrough();

/** Strona tematyczna Odyseusza (np. „Czym są ostrzeżenia dla podróżujących”) → rekord na każdą sekcję. */
export function odyseuszTopicDrafts(json: unknown, pageUrl: string): RecordDraft[] {
  const parsed = TopicPage.safeParse(json);
  if (!parsed.success) return [];
  const page = cleanOfficialText(parsed.data.nazwa);
  const out: RecordDraft[] = [];
  for (const s of parsed.data.sekcje ?? []) {
    const title = cleanOfficialText(s.tytul);
    const lines = [endSentence(cleanOfficialText(s.tresc))];
    for (const sub of s.podsekcje ?? []) {
      const st = cleanOfficialText(sub.tytul);
      const sb = endSentence(cleanOfficialText(sub.tresc));
      if (st || sb) lines.push(st && sb ? `${st}: ${sb}` : st || sb);
    }
    const body = lines.filter(Boolean).join("\n");
    if (!body) continue;
    for (const chunk of chunkText(`${title ? `${title}.\n` : ""}${body}`, { maxPassages: 3 })) {
      out.push({
        url: pageUrl,
        title: `MSZ (Odyseusz): ${page}${title ? ` — ${title}` : ""}`,
        text: chunk.replace(/\n/g, " "),
        publishedAt: null,
      });
    }
  }
  return out;
}

// ───────────────────────────── gov.pl: lista aktualności ─────────────────────────────

export interface GovplListItem {
  /** Data z listy w zapisie strony, np. „21.11.2026”. */
  date: string;
  title: string;
  intro: string;
  url: string;
}

/** „21.11.2026” → ISO; inny zapis → null. */
export function isoFromPlDate(s: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString() : null;
}

/** Pozycje listy aktualności gov.pl (blok „art-prev”): data, tytuł, zajawka, adres. Kolejność jak na stronie. */
export function parseGovplList(html: string, pageUrl: string): GovplListItem[] {
  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return [];
  }
  const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const items: GovplListItem[] = [];
  for (const li of Array.from(document.querySelectorAll(".art-prev li"))) {
    const link = li.querySelector(".title a") ?? li.querySelector("a[href]");
    const title = text(li.querySelector(".title")) || text(link);
    if (!title) continue;
    let url = pageUrl;
    try {
      const href = link?.getAttribute("href");
      if (href) url = new URL(href, pageUrl).href;
    } catch {
      /* zostaje adres listy */
    }
    items.push({ date: text(li.querySelector(".date")), title, intro: text(li.querySelector(".intro")), url });
  }
  return items;
}

/** Najwyżej tyle pozycji listy trafia do rekordów (najnowsze są na górze strony). */
export const GOVPL_LIST_MAX_ITEMS = 10;
const GOVPL_LIST_RECORD_CHARS = 1300;

/**
 * Lista aktualności gov.pl → 1–2 rekordy z najnowszymi pozycjami („data — tytuł: zajawka”), w kolejności ze strony.
 * Data publikacji rekordu = data najnowszej pozycji w rekordzie.
 */
export function govplListDrafts(html: string, pageUrl: string, label: string): RecordDraft[] {
  const items = parseGovplList(html, pageUrl).slice(0, GOVPL_LIST_MAX_ITEMS);
  if (items.length === 0) return [];
  const groups: GovplListItem[][] = [[]];
  let size = 0;
  for (const it of items) {
    const line = formatItem(it);
    if (size > 0 && size + line.length > GOVPL_LIST_RECORD_CHARS) {
      if (groups.length >= 2) break;
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(it);
    size += line.length + 1;
  }
  return groups
    .filter((g) => g.length > 0)
    .map((g, i) => ({
      url: pageUrl,
      title: `${label} — najnowsze pozycje na stronie${i > 0 ? " (starsze)" : ""}`,
      text: cap(g.map(formatItem).join("\n"), PASSAGE_MAX_CHARS),
      publishedAt: g.map((it) => isoFromPlDate(it.date)).filter((d): d is string => !!d).sort().pop() ?? null,
    }));
}

function formatItem(it: GovplListItem): string {
  const head = it.date ? `${it.date} — ${it.title}` : it.title;
  return it.intro ? `${endSentence(head.replace(/[.:]$/, ""))} ${it.intro}` : endSentence(head);
}

/** Raport dobowy ma stały URL. Każdy fragment zawiera datę wydania bieżącej wersji. */
export function rcbReportDrafts(html: string, pageUrl: string, label: string): RecordDraft[] {
  const { document } = parseHTML(html);
  const article = document.querySelector("article.article-area__article .editor-content");
  if (!article) return [];
  const dateText = cleanOfficialText(article.querySelector("p")?.textContent);
  const date = /^(\d{1,2}) ([a-ząćęłńóśźż]+) (\d{4})(?: r\.?)?$/iu.exec(dateText);
  if (!date) return [];
  const month = MONTHS_GENITIVE_PL.findIndex((m) => m === date[2]!.toLowerCase()) + 1;
  const publishedAt = month > 0 ? isoFromPlDate(`${date[1]}.${month}.${date[3]}`) : null;
  if (!publishedAt) return [];

  const sections: string[][] = [[]];
  for (const block of article.querySelectorAll("p, ul, ol, hr, h2, h3, h4")) {
    const list = block.closest("ul, ol");
    if (list && list !== block) continue;
    if (block.tagName === "HR") {
      if (sections.at(-1)!.length) sections.push([]);
      continue;
    }
    const lines = list ? Array.from(block.children, (child) => child.textContent) : [block.textContent];
    for (const line of lines) {
      const text = cleanOfficialText(line?.replace(/[\u200B\uFEFF]/g, ""));
      if (text && text !== dateText) sections.at(-1)!.push(text);
    }
  }
  const title = `${label} — ${dateText}`;
  return sections.flatMap((section) => {
    const body = section.join("\n");
    if (!body) return [];
    const passages = body.length < 40 ? [body] : chunkText(body, { max: MAX_TEXT, maxPassages: 3 });
    return passages.map((text) => ({
      url: pageUrl,
      title,
      text: cap(`Raport dobowy RCB z dnia ${dateText}\n${text}`, PASSAGE_MAX_CHARS),
      publishedAt,
    }));
  });
}

const RsoList = z.object({ newses: z.array(z.unknown()) });
const RsoWarning = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  shortcut: z.string().nullish(),
  content: z.string().nullish(),
  created_at: z.string(),
  valid_from: z.string(),
  valid_to: z.string(),
  rso_alarm: z.string().nullish(),
  provinces: z.record(z.string(), z.object({ name: z.string(), slug_name: z.string() })),
});

const warsawDateTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Warsaw",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Dane RSO podają czas lokalny bez przesunięcia. Dopasowanie do strefy działa latem i zimą. */
function parseRsoTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const utc = Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(utc)) return null;
  for (const hours of [2, 1]) {
    const local = new Date(utc - hours * 3600_000);
    if (warsawDateTime.format(local) === value) return local.toISOString();
  }
  return null;
}

export function rsoWarningDrafts(json: unknown, lookup: RsoLookup, now: Date): RecordDraft[] {
  const parsed = RsoList.safeParse(json);
  if (!parsed.success) return [];
  const timestamp = now.toISOString();
  const drafts: RecordDraft[] = [];
  for (const item of parsed.data.newses) {
    const decoded = RsoWarning.safeParse(item);
    if (!decoded.success) continue;
    const w = decoded.data;
    const publishedAt = parseRsoTime(w.created_at);
    const from = parseRsoTime(w.valid_from);
    const until = parseRsoTime(w.valid_to);
    if (!publishedAt || !from || !until || publishedAt > timestamp || until <= timestamp || from >= until) continue;
    const provinces = Object.values(w.provinces);
    if (lookup.region !== "wszystkie" && !provinces.some((r) => r.slug_name === lookup.region)) continue;

    const title = cleanOfficialText(w.title);
    const summary = cleanOfficialText(w.shortcut);
    const body = cleanOfficialText(w.content);
    const headline = `${title} ${summary}`;
    if (!title || (lookup.topicKeywords.length > 0 && !matchesAny(foldedWords(headline), lookup.topicKeywords))) continue;
    if (lookup.roadNumbers.length > 0 && !rsoRoadNumbers(`${headline} ${body}`).some((r) => lookup.roadNumbers.includes(r))) continue;
    const area = [...new Set(provinces.map((r) => cleanOfficialText(r.name)).filter(Boolean))].join(", ");
    const text = [
      endSentence(title),
      area ? `Województwa: ${area}.` : "",
      w.rso_alarm && /^[1-3]$/.test(w.rso_alarm) ? `Stopień zagrożenia: ${w.rso_alarm}.` : "",
      `Okres obowiązywania komunikatu: od ${w.valid_from} do ${w.valid_to} (czas polski).`,
      endSentence(summary === "0" ? "" : summary),
      body !== summary ? endSentence(body) : "",
    ].filter(Boolean).join(" ");
    const url = new URL(lookup.pageUrl);
    url.hash = `/_/szczgoly/${w.id}`;
    drafts.push({ url: url.href, title: `${lookup.label} — ${title}`, text: cap(text), publishedAt });
  }
  return drafts;
}
