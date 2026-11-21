/**
 * Planowanie gałęzi „official” — czysty kod, bez sieci i bez modelu.
 *
 * Z tekstu twierdzenia ustala, KTÓRE oficjalne kanały instytucji trzeba sprawdzić (rejestr data/authorities.yaml):
 *  - instytucję rozpoznajemy po słowach kluczowych („MSZ”, „RCB”, „Ministerstwo Spraw Zagranicznych”),
 *  - kraj po nazwie z listy profili krajów serwisu MSZ Odyseusz (data/odyseusz-countries.json), z tolerancją
 *    na polską odmianę („do Niemiec”, „w Niemczech”) i jawną listą form nieregularnych (countryAliases).
 * Wynik to lista adresów do pobrania; o tym, czy host wolno pobrać, decyduje dopiero gałąź (katalog źródeł).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { foldToken } from "./live-score";

export const DEFAULT_AUTHORITIES_PATH = fileURLToPath(new URL("../../../data/authorities.yaml", import.meta.url));
export const DEFAULT_COUNTRIES_PATH = fileURLToPath(new URL("../../../data/odyseusz-countries.json", import.meta.url));

/** Najwyżej tyle adresów na jedno twierdzenie (profil kraju, strona tematyczna, listy komunikatów). */
export const MAX_OFFICIAL_LOOKUPS = 4;
/** Najwyżej tyle krajów z jednego twierdzenia. */
export const MAX_COUNTRIES = 2;

const Keywords = z.array(z.string().min(2)).min(1);

const OdyseuszAuthority = z.object({
  id: z.string(),
  label: z.string(),
  connector: z.literal("odyseusz"),
  institutionKeywords: Keywords,
  topicKeywords: Keywords,
  /** Adres danych profilu kraju; „{ISO}” jest zastępowane kodem kraju. */
  profileApi: z.string().includes("{ISO}"),
  /** Adres strony profilu dla czytelnika (link w raporcie). */
  profileUrl: z.string().includes("{ISO}"),
  topicPages: z.array(z.object({ api: z.string().url(), url: z.string().url() })).default([]),
});

const GovplListAuthority = z.object({
  id: z.string(),
  label: z.string(),
  connector: z.literal("govpl-list"),
  institutionKeywords: Keywords,
  pages: z.array(z.string().url()).min(1),
});

const RcbReportAuthority = z.object({
  id: z.string(),
  label: z.string(),
  connector: z.literal("rcb-report"),
  institutionKeywords: Keywords,
  page: z.string().url(),
});

const RsoAuthority = z.object({
  id: z.string(),
  label: z.string(),
  connector: z.literal("rso"),
  institutionKeywords: Keywords,
  listApi: z.string().includes("{region}").includes("{category}"),
  page: z.string().url(),
});

const Authority = z.discriminatedUnion("connector", [OdyseuszAuthority, GovplListAuthority, RcbReportAuthority, RsoAuthority]);
export type Authority = z.infer<typeof Authority>;

const RegistryFile = z.object({
  authorities: z.array(Authority),
  countryAliases: z.record(z.string(), z.array(z.string())).default({}),
});

export interface Country {
  iso: string;
  name: string;
}

export interface OfficialRegistry {
  authorities: Authority[];
  countries: Country[];
  /** Kod ISO → złożone formy nieregularne (składnia słów kluczowych). */
  countryAliases: Record<string, string[]>;
}

export interface RsoLookup {
  kind: "rso";
  authorityId: string;
  label: string;
  fetchUrl: string;
  pageUrl: string;
  region: string;
  topicKeywords: string[];
  roadNumbers: string[];
}

export type OfficialLookup =
  | { kind: "odyseusz-profile"; authorityId: string; label: string; fetchUrl: string; pageUrl: string; iso: string; country: string }
  | { kind: "odyseusz-topic"; authorityId: string; label: string; fetchUrl: string; pageUrl: string }
  | { kind: "govpl-list" | "rcb-report"; authorityId: string; label: string; fetchUrl: string; pageUrl: string }
  | RsoLookup;

const registryCache = new Map<string, OfficialRegistry>();

/** Wczytuje rejestr i listę krajów. Brak pliku rejestru = pusty rejestr (gałąź nic nie sprawdza). */
export function loadOfficialRegistry(
  authoritiesPath: string = DEFAULT_AUTHORITIES_PATH,
  countriesPath: string = DEFAULT_COUNTRIES_PATH,
): OfficialRegistry {
  const key = `${authoritiesPath}|${countriesPath}`;
  const hit = registryCache.get(key);
  if (hit) return hit;
  let registry: OfficialRegistry = { authorities: [], countries: [], countryAliases: {} };
  if (existsSync(authoritiesPath)) {
    const file = RegistryFile.parse(parseYaml(readFileSync(authoritiesPath, "utf8")));
    const countries = existsSync(countriesPath)
      ? z.array(z.object({ iso: z.string().length(2), name: z.string().min(2) })).parse(JSON.parse(readFileSync(countriesPath, "utf8")))
      : [];
    registry = { authorities: file.authorities, countries, countryAliases: file.countryAliases };
  }
  registryCache.set(key, registry);
  return registry;
}

// ───────────────────────────── dopasowanie słów ─────────────────────────────

/** Słowa tekstu: małe litery, bez znaków diakrytycznych, bez interpunkcji. */
export function foldedWords(text: string): string[] {
  return foldToken(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Dopasowanie frazy kluczowej: każde słowo frazy jest PRZEDROSTKIEM kolejnego słowa tekstu; „$” na końcu
 * frazy = ostatnie słowo musi być równe (np. „msz$” nie łapie „mszy”). Ta sama składnia co w
 * data/high-risk-topics.yaml.
 */
export function matchesKeyword(words: string[], keyword: string): boolean {
  const exact = keyword.trim().endsWith("$");
  const parts = foldedWords(exact ? keyword.trim().slice(0, -1) : keyword);
  if (parts.length === 0) return false;
  const last = parts.length - 1;
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((p, j) => (exact && j === last ? words[i + j] === p : words[i + j]!.startsWith(p)))) return true;
  }
  return false;
}

export function matchesAny(words: string[], keywords: string[]): boolean {
  return keywords.some((k) => matchesKeyword(words, k));
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Czy słowo tekstu jest odmienioną formą słowa z nazwy kraju. Zwraca długość wspólnego przedrostka (0 = nie).
 *  - słowa do 3 liter: tylko dokładnie;
 *  - 4 litery („Kuba”, „Czad”, „Iran”): słowo zaczyna się od nazwy albo różni się samą końcówką przypadka;
 *  - dłuższe: wspólny przedrostek co najmniej 4 litery i najwyżej 3 ostatnie litery nazwy zmienione
 *    („Niemcy” → „Niemiec”, „Niemczech”; „Szwecja” → „Szwecji”).
 */
export function countryWordMatch(token: string, nameWord: string): number {
  const n = nameWord.length;
  if (n <= 3) return token === nameWord ? n : 0;
  const cp = commonPrefix(token, nameWord);
  if (n === 4) {
    if (cp === 4 && token.length <= 6) return cp;
    if (cp === 3 && token.length <= 5 && /(y|ie|e|u|a|o)$/.test(token)) return cp;
    return 0;
  }
  return cp >= Math.max(4, n - 3) && token.length <= n + 4 ? cp : 0;
}

/** Słowa nazwy kraju bez dopisków w nawiasach („Stany Zjednoczone (USA)” → stany, zjednoczone). */
function countryNameWords(name: string): string[] {
  return foldedWords(name.replace(/\([^)]*\)/g, " "));
}

/**
 * Kraje wymienione w tekście, w kolejności wystąpienia (najwyżej MAX_COUNTRIES). Przy kilku pasujących nazwach
 * dla tego samego miejsca w tekście wygrywa nazwa z większą liczbą słów, potem z dłuższym wspólnym przedrostkiem
 * („Nigerii” → Nigeria, nie Niger; „Korei Północnej” → Korea Północna).
 */
export function findCountries(text: string, registry: Pick<OfficialRegistry, "countries" | "countryAliases">): Country[] {
  const words = foldedWords(text);
  if (words.length === 0) return [];
  const byIso = new Map(registry.countries.map((c) => [c.iso, c]));
  const found: { pos: number; len: number; score: number; country: Country }[] = [];

  for (const [iso, aliases] of Object.entries(registry.countryAliases)) {
    const country = byIso.get(iso);
    if (!country) continue;
    for (const alias of aliases) {
      const exact = alias.trim().endsWith("$");
      const parts = foldedWords(exact ? alias.trim().slice(0, -1) : alias);
      if (parts.length === 0) continue;
      const last = parts.length - 1;
      for (let i = 0; i + parts.length <= words.length; i++) {
        if (parts.every((p, j) => (exact && j === last ? words[i + j] === p : words[i + j]!.startsWith(p)))) {
          found.push({ pos: i, len: parts.length, score: 100 + parts.join("").length, country });
        }
      }
    }
  }

  for (const country of registry.countries) {
    const nameWords = countryNameWords(country.name);
    if (nameWords.length === 0) continue;
    for (let i = 0; i + nameWords.length <= words.length; i++) {
      let score = 0;
      let ok = true;
      for (let j = 0; j < nameWords.length; j++) {
        const m = countryWordMatch(words[i + j]!, nameWords[j]!);
        if (m === 0) {
          ok = false;
          break;
        }
        score += m;
      }
      if (ok) found.push({ pos: i, len: nameWords.length, score, country });
    }
  }

  // Najlepsze dopasowanie dla każdego miejsca w tekście; dłuższe nazwy zasłaniają krótsze, które się w nich mieszczą.
  found.sort((a, b) => b.len - a.len || b.score - a.score || a.pos - b.pos);
  const taken = new Set<number>();
  const picked: typeof found = [];
  for (const f of found) {
    let free = true;
    for (let k = f.pos; k < f.pos + f.len; k++) if (taken.has(k)) free = false;
    if (!free) continue;
    for (let k = f.pos; k < f.pos + f.len; k++) taken.add(k);
    picked.push(f);
  }
  picked.sort((a, b) => a.pos - b.pos);
  const out: Country[] = [];
  for (const p of picked) {
    if (!out.some((c) => c.iso === p.country.iso)) out.push(p.country);
    if (out.length >= MAX_COUNTRIES) break;
  }
  return out;
}

// Identyfikatory województw i kategorii używane przez publiczną wyszukiwarkę gov.pl.
const RSO_REGIONS: readonly [string, string[]][] = [
  ["kujawsko-pomorskie", ["kujawsko pomorsk"]],
  ["warminsko-mazurskie", ["warminsko mazursk"]],
  ["dolnoslaskie", ["dolnoslask"]],
  ["lubelskie", ["lubelsk"]],
  ["lubuskie", ["lubusk"]],
  ["lodzkie", ["lodzk"]],
  ["malopolskie", ["malopolsk"]],
  ["mazowieckie", ["mazowieck", "mazowsz"]],
  ["opolskie", ["opolsk"]],
  ["podkarpackie", ["podkarpack"]],
  ["podlaskie", ["podlask"]],
  ["pomorskie", ["pomorsk"]],
  ["slaskie", ["slask"]],
  ["swietokrzyskie", ["swietokrzysk"]],
  ["wielkopolskie", ["wielkopolsk"]],
  ["zachodniopomorskie", ["zachodniopomorsk"]],
];

const RSO_ALERT_WORDS = ["ostrzezen", "ostrzeg", "alert", "komunikat", "stopien zagrozenia"];
const IMGW_WORDS = ["imgw$", "instytut meteorologii i gospodarki wodnej"];
const RSO_CATEGORIES = [
  {
    slug: "ogolne",
    label: "ostrzeżenia ogólne",
    keywords: ["ostrzezen ogoln", "alarm", "ewakuac"],
    topics: [["syren", "alarmowan"], ["skazen"], ["ewakuac"], ["przerw w dostaw"]],
  },
  {
    slug: "meteorologiczne",
    label: "ostrzeżenia meteorologiczne",
    keywords: ["meteorolog", "ostrzezen pogodow"],
    topics: [["burz", "nawalnic"], ["mgla", "mgle", "mgiel", "mgly"], ["mroz", "przymrozk"], ["upal"], ["oblodzen", "gololedz"], ["wiatr", "wichur"], ["zamiec", "zawiej"], ["snieg", "sniez"], ["opad", "ulew", "deszcz"], ["sztorm"]],
  },
  {
    slug: "hydrologiczne",
    label: "ostrzeżenia hydrologiczne",
    keywords: ["hydrolog", "stan alarmow", "stan ostrzegawcz"],
    topics: [["powodz", "wezbran"], ["susz"], ["podtopien"]],
  },
  {
    slug: "informacje-drogowe",
    label: "ostrzeżenia drogowe",
    keywords: ["ostrzezen drogow", "gddkia$", "utrudnien drogow", "utrudnien na", "ruch wahadlow", "informacj drogow"],
    topics: [["wypadek", "wypadk", "kolizj"], ["zamkniec", "nieprzejezdn"], ["remont", "robot drogow"]],
  },
];

/** Rozpoznaje oznaczenia dróg w zapytaniu i treści komunikatu (np. DK-79, S7, autostrada A1). */
export function rsoRoadNumbers(text: string): string[] {
  return [...foldToken(text).matchAll(/\b(?:(dk)[ -]*(\d{1,3})|([as])(\d{1,3})|dro(?:g|dz)\p{L}* (?:krajow\p{L}* )?(?:nr )?(\d{1,3}))\b/gu)]
    .map((match) => match[1] ? `dk${match[2]}` : match[3] ? `${match[3]}${match[4]}` : `dk${match[5]}`);
}

function planRsoLookups(words: string[], authority: z.infer<typeof RsoAuthority>, institution: boolean): RsoLookup[] {
  // W nazwie kujawsko-pomorskiego chodzi o jedno województwo. Nie dopasowuj przy nim także pomorskiego.
  const regionalWords = words.map((word, i) => word.startsWith("pomorsk") && words[i - 1] === "kujawsko" ? "kujawsko-pomorskie" : word);
  const regions = RSO_REGIONS.filter(([slug, keywords]) => matchesAny(slug === "pomorskie" ? regionalWords : words, keywords)).map(([slug]) => slug);
  const alert = matchesAny(words, RSO_ALERT_WORDS);
  const imgw = matchesAny(words, IMGW_WORDS);
  const roads = rsoRoadNumbers(words.join(" "));
  const categories = RSO_CATEGORIES.map((category) => ({
    ...category,
    topicKeywords: category.topics.filter((topic) => matchesAny(words, topic)).flat(),
  }));
  const selected = categories.filter((category) =>
    (category.slug === "informacje-drogowe" || alert || institution || imgw) &&
    (matchesAny(words, category.keywords) || category.topicKeywords.length > 0 ||
      (category.slug === "informacje-drogowe" && alert && roads.length > 0)),
  );
  const targeted = selected.length > 0 ? selected : imgw && alert ? categories.filter((c) => c.slug === "meteorologiczne" || c.slug === "hydrologiczne") : [];
  const requested = targeted.length > 0 ? targeted : institution || (regions.length > 0 && alert) ? categories : [];
  return requested.flatMap((category) => (regions.length ? regions : ["wszystkie"]).map((region) => ({
    kind: "rso",
    authorityId: authority.id,
    label: `${authority.label} - ${category.label}`,
    fetchUrl: authority.listApi.replace("{region}", region).replace("{category}", category.slug),
    pageUrl: authority.page,
    region,
    topicKeywords: category.topicKeywords,
    roadNumbers: category.slug === "informacje-drogowe" ? roads : [],
  })));
}

// ───────────────────────────── plan ─────────────────────────────

/**
 * Lista oficjalnych adresów do sprawdzenia dla danego tekstu (twierdzenie + zapytania dodatkowe).
 * Pusta lista = twierdzenie nie wskazuje żadnej instytucji z rejestru (gałąź zwraca wtedy brak kandydatów).
 */
export function planOfficialLookups(text: string, registry: OfficialRegistry, max: number = MAX_OFFICIAL_LOOKUPS): OfficialLookup[] {
  const words = foldedWords(text);
  if (words.length === 0) return [];
  const profiles: OfficialLookup[] = [];
  const topics: OfficialLookup[] = [];
  const alerts: OfficialLookup[] = [];
  const lists: OfficialLookup[] = [];
  const otherWarnings: OfficialLookup[] = [];
  let countries: Country[] | undefined;

  for (const a of registry.authorities) {
    const institution = matchesAny(words, a.institutionKeywords);
    if (a.connector === "govpl-list") {
      if (!institution) continue;
      for (const page of a.pages) lists.push({ kind: "govpl-list", authorityId: a.id, label: a.label, fetchUrl: page, pageUrl: page });
      continue;
    }
    if (a.connector === "rcb-report") {
      if (institution) alerts.push({ kind: "rcb-report", authorityId: a.id, label: a.label, fetchUrl: a.page, pageUrl: a.page });
      continue;
    }
    if (a.connector === "rso") {
      const bucket = institution ? alerts : otherWarnings;
      bucket.push(...planRsoLookups(words, a, institution));
      continue;
    }
    const topic = matchesAny(words, a.topicKeywords);
    if (!institution && !topic) continue;
    countries ??= findCountries(text, registry);
    for (const c of countries) {
      profiles.push({
        kind: "odyseusz-profile",
        authorityId: a.id,
        label: a.label,
        fetchUrl: a.profileApi.replace("{ISO}", c.iso),
        pageUrl: a.profileUrl.replace("{ISO}", c.iso),
        iso: c.iso,
        country: c.name,
      });
    }
    if (topic && (institution || countries.length > 0)) {
      for (const p of a.topicPages) topics.push({ kind: "odyseusz-topic", authorityId: a.id, label: a.label, fetchUrl: p.api, pageUrl: p.url });
    }
  }

  const seen = new Set<string>();
  const out: OfficialLookup[] = [];
  for (const l of [...profiles, ...topics, ...alerts, ...lists, ...otherWarnings]) {
    if (seen.has(l.fetchUrl)) continue;
    seen.add(l.fetchUrl);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}
