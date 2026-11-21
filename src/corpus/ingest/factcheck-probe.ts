/**
 * Sonda dostępności polskich fact-checkerów z katalogu, które mają 0 rekordów (AFP Sprawdzam, PAP FakeHunter).
 * Demagoga nie sondujemy: jego dane idą wyłącznie przez Google Fact Check Tools API (ingest/demagog.ts).
 * NIE tworzy rekordów — zapisuje w raporcie budowania (corpus-report.json) dowód, dlaczego ich nie ma:
 *   1. robots.txt hosta (jedno żądanie; nieczytelny/403 = traktujemy jak zakaz, tak jak PoliteClient),
 *   2. jeśli robots pozwala: strona główna, kanał RSS i mapa strony (po jednym żądaniu; blokada CDN 403/challenge = koniec,
 *      zabezpieczeń nie obchodzimy),
 *   3. liczba wpisów tych hostów w publicznym feedzie ClaimReview DataCommons (z cache'u pobrania, bez nowych żądań).
 * Wynik tej sondy jest podstawą opisu w docs/SOURCES.md (rozdz. 9) i w data/sources.yaml.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../paths";
import { iterateFeedItems } from "./claimreview";
import { BlockedError, PoliteClient, type IngestOptions, type IngestResult, newResult } from "./common";

export interface ProbeTarget {
  sourceId: string;
  host: string;
  /** Ścieżki do sprawdzenia, gdy robots.txt pozwala (po jednej próbie). */
  paths: string[];
}

// Demagog celowo poza sondą: jego dane pobieramy wyłącznie przez Google Fact Check Tools API (ingest/demagog.ts),
// bez żadnych żądań do demagog.org.pl.
export const PROBE_TARGETS: ProbeTarget[] = [
  { sourceId: "afp-sprawdzam", host: "sprawdzam.afp.com", paths: ["/", "/rss.xml"] },
  { sourceId: "fakehunter", host: "fakehunter.pap.pl", paths: ["/"] },
];

/** Rozpoznaje stronę-blokadę CDN/WAF (Cloudflare, Akamai, Incapsula) po treści odpowiedzi. */
export function looksLikeBotBlock(status: number, body: string): string | null {
  const head = body.slice(0, 4000);
  if (/Attention Required!?\s*\|\s*Cloudflare|cf-browser-verification|Just a moment\.\.\./i.test(head)) return "Cloudflare";
  if (/_Incapsula_Resource|Incapsula incident/i.test(head)) return "Incapsula";
  if (/errors\.edgesuite\.net|Access Denied/i.test(head) && status === 403) return "Akamai";
  if (status === 403) return "HTTP 403 bez rozpoznanego dostawcy";
  return null;
}

export async function ingestFactcheckProbe(opts: IngestOptions): Promise<IngestResult> {
  const result = newResult("factcheck-probe");
  const client = new PoliteClient({ refresh: true });

  for (const t of PROBE_TARGETS) {
    const origin = `https://${t.host}`;
    const robotsOk = await client.allowedByRobots(`${origin}/`);
    if (!robotsOk) {
      result.notes.push(`${t.sourceId} (${t.host}): robots.txt niedostępny lub zakazuje pobrania strony głównej → nie pobieramy (traktowane jak zakaz).`);
      result.skipped.push({ what: origin, reason: "robots.txt niedostępny/zakazujący — pominięto bez pobierania treści" });
      continue;
    }
    const outcomes: string[] = [];
    for (const p of t.paths) {
      const url = origin + p;
      try {
        const res = await client.get(url, { accept: "text/html,application/xml;q=0.9,*/*;q=0.5" });
        const block = looksLikeBotBlock(res.status, res.body);
        outcomes.push(`${p} → HTTP ${res.status}${block ? ` (${block})` : ""}`);

      } catch (e) {
        if (e instanceof BlockedError && e.reason === "http") {
          const m = /HTTP (\d{3})/.exec(e.message);
          outcomes.push(`${p} → HTTP ${m ? m[1] : "4xx"} (blokada serwisu — nie obchodzimy)`);
          break; // jedna blokada = reszta ścieżek tego hosta też zablokowana; nie nękamy serwisu
        }
        outcomes.push(`${p} → ${(e as Error).message}`);
        break;
      }
    }
    result.notes.push(`${t.sourceId} (${t.host}): robots.txt dostępny; ${outcomes.join("; ")}.`);
    if (outcomes.some((o) => /\((Cloudflare|Incapsula|Akamai|HTTP 403)/.test(o))) {
      result.skipped.push({ what: origin, reason: "strona-blokada CDN/WAF zamiast treści (HTTP 200 z wyzwaniem lub 403) — nie obchodzimy" });
    }
    for (const o of outcomes) if (/HTTP (403|401)/.test(o)) result.skipped.push({ what: `${origin}`, reason: o });
  }

  // Feed ClaimReview DataCommons z cache'u (bez nowych żądań).
  const feedFile = resolve(paths.cacheDir(), "claimreview-feed.json");
  if (existsSync(feedFile)) {
    const counts = new Map<string, number>();
    let total = 0;
    const interesting = /(^|\.)(demagog\.org\.pl|demagog\.cz|afp\.com|konkret24\.tvn24\.pl|fakehunter\.pap\.pl|oko\.press)$/i;
    for await (const item of iterateFeedItems(feedFile)) {
      total++;
      let host = "";
      try {
        host = new URL(item.url ?? "").hostname.toLowerCase();
      } catch {
        continue;
      }
      if (interesting.test(host)) counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    const want = ["demagog.org.pl", "sprawdzam.afp.com", "fakehunter.pap.pl", "konkret24.tvn24.pl"];
    const line = [...want.map((h) => `${h}: ${counts.get(h) ?? 0}`), ...[...counts].filter(([h]) => !want.includes(h)).map(([h, n]) => `${h}: ${n} (inny host)`)].join(", ");
    result.notes.push(`Feed ClaimReview DataCommons (z cache'u, ${total} wpisów): ${line}.`);
    opts.log(`  feed ClaimReview: ${total} wpisów; ${line}`);
  } else {
    result.notes.push("Feed ClaimReview DataCommons: brak pliku w cache'u (uruchom ingestor claimreview), nie policzono wpisów.");
  }

  result.requests = client.requests;
  for (const n of result.notes) opts.log(`  ${n}`);
  return result;
}
