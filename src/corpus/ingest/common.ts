/**
 * Wspólne narzędzia ingestii korpusu.
 *
 * Zasady (PLAN §5 i zadanie): uprzejme pobieranie (<= 1 żądanie/s na host), poszanowanie robots.txt,
 * User-Agent bez danych osobowych, brak obchodzenia paywalli i zabezpieczeń (403/CAPTCHA = pomijamy
 * źródło i dokumentujemy), tekst rekordu zawsze dosłowny, data pobrania = faktyczny czas pobrania.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { CorpusRecord, type CatalogSource } from "../../shared/contracts";
import { paths } from "../paths";

export const USER_AGENT = "PrawdowidBot/0.1 (prototyp hackathonowy)";
export const MAX_TEXT_CHARS = 1500;
export const MAX_QUOTE_CHARS = 300;

// ───────────────────────────── Raport z ingestii ─────────────────────────────

export interface Incident {
  id: string;
  title: string;
  summary: string;
  url: string;
  /** Domeny serwisów, które rozpowszechniały narrację (tylko jeśli źródło je podaje; bez platform społecznościowych). */
  domains: string[];
  publishedAt: string | null;
  /** Rekord korpusu powiązany z incydentem (gdy istnieje). */
  recordId: string | null;
}

export interface SkippedItem {
  what: string;
  reason: string;
}

export interface IngestResult {
  /** Identyfikator ingestora (klucz w INGESTERS i w raporcie). */
  id: string;
  /**
   * Gdy ustawione, WSZYSTKIE rekordy trafiają do data/corpus/<fileId>.jsonl (zamiast do plików nazwanych sourceId).
   * Potrzebne, gdy kilka ingestorów dokłada rekordy do tego samego źródła z katalogu (np. gov-pl: komunikaty oraz
   * osoby pełniące funkcje) i nie mogą nadpisywać swoich plików.
   */
  fileId?: string;
  records: CorpusRecord[];
  incidents: Incident[];
  skipped: SkippedItem[];
  notes: string[];
  requests: number;
}

export interface IngestOptions {
  /** Ignoruj cache surowych odpowiedzi. */
  refresh: boolean;
  /** Ograniczenie liczby elementów (do szybkich prób). */
  limit?: number;
  catalog: CatalogSource[];
  log: (msg: string) => void;
}

export function newResult(id: string): IngestResult {
  return { id, records: [], incidents: [], skipped: [], notes: [], requests: 0 };
}

// ───────────────────────────── Pobieranie ─────────────────────────────

export class BlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: "robots" | "http" | "challenge" | "network",
    message: string,
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

export interface HttpResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  /** Faktyczny moment pobrania (ISO) — przy trafieniu w cache: moment oryginalnego pobrania. */
  fetchedAt: string;
  fromCache: boolean;
}

interface RobotsRule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

function patternToRegExp(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

export function parseRobots(text: string, agent = "prawdowidbot"): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue;
      if (value === "" && key === "disallow") continue; // pusty Disallow = wszystko dozwolone
      current.rules.push({ allow: key === "allow", pattern: patternToRegExp(value), length: value.length });
    } else {
      lastWasAgent = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Wartość Crawl-delay (w sekundach) z grupy odpowiadającej agentowi; 0, gdy brak. */
export function parseCrawlDelay(text: string, agent = "prawdowidbot"): number {
  let inGroup = false;
  let matched = false;
  let best = 0;
  let wildcardDelay = 0;
  let wildcardGroup = false;
  let lastWasAgent = false;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().toLowerCase();
    if (key === "user-agent") {
      if (!lastWasAgent) {
        inGroup = false;
        wildcardGroup = false;
      }
      if (value === "*") wildcardGroup = true;
      else if (agent.includes(value)) {
        inGroup = true;
        matched = true;
      }
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (key === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n)) {
          if (inGroup) best = Math.max(best, n);
          if (wildcardGroup) wildcardDelay = Math.max(wildcardDelay, n);
        }
      }
    }
  }
  return matched ? best : wildcardDelay;
}

export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
  let best: RobotsRule | undefined;
  for (const r of rules) {
    if (!r.pattern.test(pathAndQuery)) continue;
    if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class PoliteClient {
  private lastRequestAt = new Map<string, number>();
  private robots = new Map<string, RobotsRule[] | "blocked">();
  private crawlDelayMs = new Map<string, number>();
  public requests = 0;

  constructor(
    private readonly opts: { refresh?: boolean; minIntervalMs?: number; cacheDir?: string } = {},
  ) {}

  private cacheFile(url: string, accept: string): string {
    const key = createHash("sha1").update(url + "\n" + accept).digest("hex");
    return resolve(this.opts.cacheDir ?? paths.cacheDir(), key + ".json");
  }

  private async throttle(host: string): Promise<void> {
    const min = Math.max(this.opts.minIntervalMs ?? 1100, this.crawlDelayMs.get(host) ?? 0);
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = last + min - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt.set(host, Date.now());
  }

  private async rawFetch(url: string, accept: string, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
    const u = new URL(url);
    await this.throttle(u.host);
    this.requests++;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(60_000),
          headers: { "User-Agent": USER_AGENT, Accept: accept, ...extraHeaders },
        });
        const body = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await sleep(3000);
          await this.throttle(u.host);
          continue;
        }
        return {
          status: res.status,
          finalUrl: res.url || url,
          contentType: res.headers.get("content-type") ?? "",
          body,
          fetchedAt: new Date().toISOString(),
          fromCache: false,
        };
      } catch (e) {
        lastErr = e;
        await sleep(2000);
      }
    }
    throw new BlockedError(url, "network", `Błąd sieci dla ${url}: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  /** Czy robots.txt hosta pozwala na ścieżkę. Brak robots.txt (404) = dozwolone; 403/5xx = traktujemy jako zakaz. */
  async allowedByRobots(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = u.origin;
    let rules = this.robots.get(origin);
    if (rules === undefined) {
      try {
        const res = await this.rawFetch(origin + "/robots.txt", "text/plain");
        if (res.status === 200 && !/<html/i.test(res.body.slice(0, 500))) {
          rules = parseRobots(res.body);
          const delay = parseCrawlDelay(res.body);
          if (delay > 0) this.crawlDelayMs.set(u.host, Math.min(delay, 30) * 1000);
        }
        else if (res.status === 404 || res.status === 410 || res.status === 200) rules = [];
        else rules = "blocked";
      } catch {
        rules = "blocked";
      }
      this.robots.set(origin, rules);
    }
    if (rules === "blocked") return false;
    return robotsAllows(rules, u.pathname + u.search);
  }

  /**
   * GET z cache'em, throttlingiem i robots.txt. Rzuca BlockedError przy zakazie robots lub
   * odpowiedzi 401/403/challenge (nie próbujemy obchodzić zabezpieczeń).
   */
  async get(
    url: string,
    opts: {
      accept?: string;
      headers?: Record<string, string>;
      /** Nagłówki uwierzytelnienia (np. klucz API): wysyłane, ale NIE wchodzą do klucza ani treści cache'u (rotacja klucza nie unieważnia cache'u). */
      secretHeaders?: Record<string, string>;
      skipRobots?: boolean;
    } = {},
  ): Promise<HttpResult> {
    const accept = opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5";
    const file = this.cacheFile(url, accept + JSON.stringify(opts.headers ?? {}));
    if (!this.opts.refresh && existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8")) as HttpResult;
        if (cached.status === 200) return { ...cached, fromCache: true };
      } catch {
        /* zepsuty cache — pobierz ponownie */
      }
    }
    if (!opts.skipRobots && !(await this.allowedByRobots(url))) {
      throw new BlockedError(url, "robots", `robots.txt nie zezwala na pobranie ${url} (lub nie da się go odczytać)`);
    }
    const res = await this.rawFetch(url, accept, { ...opts.headers, ...opts.secretHeaders });
    if (res.status === 401 || res.status === 403) {
      throw new BlockedError(url, "http", `HTTP ${res.status} dla ${url} (zabezpieczenie serwisu — nie obchodzimy)`);
    }
    if (res.status === 202 && res.body.length === 0) {
      throw new BlockedError(url, "challenge", `HTTP 202 bez treści dla ${url} (wyzwanie antybotowe — nie obchodzimy)`);
    }
    if (res.status === 200) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(res));
    }
    return res;
  }

  /** Pobranie danych binarnych (np. PDF) z cache'em na dysku. */
  async getBinary(url: string, opts: { accept?: string } = {}): Promise<{ data: Buffer; fetchedAt: string; finalUrl: string; fromCache: boolean }> {
    const accept = opts.accept ?? "*/*";
    const file = this.cacheFile(url, accept + "#bin");
    if (!this.opts.refresh && existsSync(file) && existsSync(file + ".meta")) {
      try {
        const meta = JSON.parse(readFileSync(file + ".meta", "utf8")) as { fetchedAt: string; finalUrl: string };
        return { data: readFileSync(file), fetchedAt: meta.fetchedAt, finalUrl: meta.finalUrl, fromCache: true };
      } catch {
        /* pobierz ponownie */
      }
    }
    if (!(await this.allowedByRobots(url))) {
      throw new BlockedError(url, "robots", `robots.txt nie zezwala na pobranie ${url}`);
    }
    const u = new URL(url);
    await this.throttle(u.host);
    this.requests++;
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000), headers: { "User-Agent": USER_AGENT, Accept: accept } });
    if (res.status === 401 || res.status === 403) throw new BlockedError(url, "http", `HTTP ${res.status} dla ${url}`);
    if (res.status !== 200) throw new BlockedError(url, "http", `HTTP ${res.status} dla ${url}`);
    const data = Buffer.from(await res.arrayBuffer());
    const fetchedAt = new Date().toISOString();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    writeFileSync(file + ".meta", JSON.stringify({ fetchedAt, finalUrl: res.url || url }));
    return { data, fetchedAt, finalUrl: res.url || url, fromCache: false };
  }

  async getJson<T = unknown>(url: string, opts: { headers?: Record<string, string> } = {}): Promise<{ data: T; res: HttpResult }> {
    const res = await this.get(url, { accept: "application/json", headers: opts.headers });
    if (res.status !== 200) throw new BlockedError(url, "http", `HTTP ${res.status} dla ${url}`);
    return { data: JSON.parse(res.body) as T, res };
  }
}

// ───────────────────────────── Tekst ─────────────────────────────

/** Normalizacja do porównań „dosłowności” (białe znaki, niełamliwe spacje). */
export function squash(s: string): string {
  return s.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Sprawdza, że `text` (po normalizacji białych znaków) jest podciągiem `source`. */
export function isVerbatim(text: string, source: string): boolean {
  return squash(source).includes(squash(text));
}

export function sha(s: string, n = 12): string {
  return createHash("sha1").update(s).digest("hex").slice(0, n);
}

export function recordId(sourceId: string, key: string): string {
  return `${sourceId}:${sha(key)}`;
}

/** Przycina na granicy zdania/słowa bez zmiany treści (prefiks oryginału, bez wielokropka). */
export function clipVerbatim(text: string, max: number): string {
  const t = squash(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("; "));
  if (sentenceEnd > max * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}

/** Dzieli długi tekst na fragmenty <= max znaków, po granicach akapitów i zdań. Zachowuje treść dosłownie. */
export function chunkText(text: string, max = 1200): string[] {
  const paras = text
    .split(/\n{1,}/)
    .map(squash)
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const p of paras) {
    if (p.length > max) {
      flush();
      const sentences = p.split(/(?<=[.;:!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9„"(])/);
      let buf = "";
      for (const s of sentences) {
        if (s.length > max) {
          if (buf) {
            out.push(buf.trim());
            buf = "";
          }
          for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
          continue;
        }
        if ((buf + " " + s).trim().length > max) {
          out.push(buf.trim());
          buf = s;
        } else buf = (buf + " " + s).trim();
      }
      if (buf) out.push(buf.trim());
      continue;
    }
    if ((cur + "\n" + p).trim().length > max) flush();
    cur = (cur ? cur + "\n" : "") + p;
  }
  flush();
  return out;
}

export interface ParsedHtml {
  title: string;
  text: string;
  meta: Record<string, string>;
  document: Document;
}

/** Parsuje HTML (linkedom), usuwa skrypty/style/nawigację i zwraca czytelny tekst z podziałem na akapity. */
export function parseHtmlPage(html: string, selector?: string): ParsedHtml {
  const { document } = parseHTML(html.trim() ? html : "<html><body></body></html>");
  const meta: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll("meta"))) {
    const k = m.getAttribute("property") ?? m.getAttribute("name") ?? m.getAttribute("itemprop");
    const v = m.getAttribute("content");
    if (k && v && !(k in meta)) meta[k] = v;
  }
  const title = squash(document.querySelector("title")?.textContent ?? "");
  const roots: Element[] = selector
    ? Array.from(document.querySelectorAll(selector))
    : [document.querySelector("main") ?? document.body];
  if (roots.length === 0) roots.push(document.body);
  const blocks: string[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (["p", "li", "h1", "h2", "h3", "h4", "h5", "td", "th", "blockquote", "dd", "dt"].includes(tag)) {
        const t = squash(child.textContent ?? "");
        if (t) blocks.push(t);
      } else walk(child);
    }
  };
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("script,style,noscript,nav,header,footer,form,aside,iframe,svg,button"))) el.remove();
    const tag = root.tagName.toLowerCase();
    if (["p", "li", "h1", "h2", "h3", "h4", "h5", "td", "th", "blockquote", "dd", "dt"].includes(tag)) {
      const t = squash(root.textContent ?? "");
      if (t) blocks.push(t);
    } else walk(root);
  }
  return { title, text: blocks.join("\n"), meta, document };
}

/**
 * Cały tekst widoczny na stronie (węzły tekstowe łączone `separator` — spacją albo pustym ciągiem jak textContent, bez script/style/noscript) — niezależna od parserów ingestii
 * „prosta” ekstrakcja do audytu dosłowności (verify.ts): tekst rekordu po squash() musi być jej podciągiem.
 */
export function plainPageText(html: string, separator = " "): string {
  const { document } = parseHTML(html.trim() ? html : "<html><body></body></html>");
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;
    for (const c of Array.from(node.childNodes)) visit(c);
  };
  visit(document.documentElement ?? document);
  return squash(parts.join(separator));
}

const BLOCK_TAGS = new Set(["div", "p", "li", "ul", "ol", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "br", "blockquote", "dd", "dt", "dl"]);

/** Tekst elementu z podziałem na linie na granicach bloków (inaczej niż textContent, które skleja sąsiednie divy). */
export function blockText(el: Element): string {
  const out: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    const tag = e.tagName.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push("\n");
    for (const c of Array.from(e.childNodes)) visit(c);
    if (block) out.push("\n");
  };
  visit(el);
  return out
    .join("")
    .split("\n")
    .map(squash)
    .filter(Boolean)
    .join("\n");
}

// ───────────────────────────── Język ─────────────────────────────

export function guessLang(text: string, hint?: string): string {
  if (hint) return hint;
  const t = text.toLowerCase();
  if (/[ąćęłńóśźż]/.test(t) || /\b(że|się|jest|nie|dla|oraz|przez)\b/.test(t)) return "pl";
  if (/[äöüß]/.test(t) || /\b(und|der|die|das|nicht|ist|mit|ein)\b/.test(t)) return "de";
  if (/[àâçéèêëîïôùûœ]/.test(t) || /\b(les|des|est|une|dans|pour)\b/.test(t)) return "fr";
  if (/[ñ¿¡]/.test(t) || /\b(los|las|que|una|para|con)\b/.test(t)) return "es";
  if (/[Ѐ-ӿ]/.test(t)) return /[іїєґ]/.test(t) ? "uk" : "ru";
  return "en";
}

// ───────────────────────────── Zapis ─────────────────────────────

export function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Waliduje rekordy zod-em i usuwa duplikaty id; zwraca posortowane po id. */
export function finalizeRecords(records: CorpusRecord[]): CorpusRecord[] {
  const byId = new Map<string, CorpusRecord>();
  for (const r of records) {
    const parsed = CorpusRecord.parse(r);
    if (parsed.text.length > MAX_TEXT_CHARS + 200) {
      throw new Error(`Rekord ${parsed.id}: tekst dłuższy niż ${MAX_TEXT_CHARS + 200} znaków`);
    }
    if (!byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const PLATFORM_DOMAINS = new Set([
  "facebook.com", "m.facebook.com", "fb.com", "fb.watch", "twitter.com", "x.com", "t.co", "youtube.com", "m.youtube.com", "youtu.be",
  "tiktok.com", "instagram.com", "t.me", "telegram.me", "vk.com", "ok.ru", "reddit.com", "wykop.pl", "whatsapp.com", "threads.net",
  "linkedin.com", "pinterest.com", "bsky.app", "rumble.com", "archive.org", "web.archive.org", "archive.ph", "archive.is", "google.com",
  "bit.ly", "tinyurl.com", "sejm.gov.pl", "senat.gov.pl",
]);

/** Domeny instytucji urzędowych, archiwów i narzędzi — to nie są serwisy "rozpowszechniające narrację". */
const NEUTRAL_DOMAINS = new Set(["perma.cc", "ghostarchive.org", "rev.com", "c-span.org", "stopfake.org", "dpa-factchecking.com", "factcheck.org", "politifact.com", "pravda.org.pl", "dw.com", "euvsdisinfo.eu"]);
const OFFICIAL_SUFFIX = /(^|\.)(gov|mil|edu)(\.[a-z]{2})?$|(^|\.)(europa\.eu|nato\.int|un\.org|gov\.pl|sejm\.gov\.pl)$/;

/**
 * Domena (bez "www.") z adresu, pod którym teza się POJAWIŁA (appearance w ClaimReview), albo null.
 * Pomijamy: platformy społecznościowe i archiwa (zbyt ogólne), instytucje urzędowe, fact-checkerów i narzędzia.
 * Uwaga semantyczna: obecność domeny oznacza tylko, że teza pojawiła się w tym serwisie — nie że serwis
 * celowo rozpowszechnia dezinformację (dlatego trafienie to wyłącznie neutralne ostrzeżenie).
 */
export function outletDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || !host.includes(".")) return null;
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const suffix = parts.slice(i).join(".");
      if (PLATFORM_DOMAINS.has(suffix) || NEUTRAL_DOMAINS.has(suffix)) return null;
    }
    if (OFFICIAL_SUFFIX.test(host)) return null;
    if (/^host\d+\.|adimpact|doubleclick|^ads?\./.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function sourceFromCatalog(catalog: CatalogSource[], id: string): CatalogSource {
  const s = catalog.find((c) => c.id === id);
  if (!s) throw new Error(`Brak źródła "${id}" w data/sources.yaml`);
  return s;
}

/** Wspólne pola rekordu z pozycji katalogu. */
export function baseFromCatalog(s: CatalogSource): Pick<
  CorpusRecord,
  "sourceId" | "publisher" | "role" | "type" | "level" | "independenceGroup" | "licence"
> {
  return {
    sourceId: s.id,
    publisher: s.publisher,
    role: s.role,
    type: s.type,
    level: s.level,
    independenceGroup: s.independenceGroup,
    licence: s.licence,
  };
}
