/** Lista tematów wysokiego ryzyka (data/high-risk-topics.yaml) i dopasowanie do tekstu. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { foldWords } from "../util";

export interface TopicRule {
  id: string;
  label: string;
  keywords: string[];
}

export const DEFAULT_TOPICS_PATH = fileURLToPath(new URL("../../../data/high-risk-topics.yaml", import.meta.url));

export function loadHighRiskTopics(path: string = DEFAULT_TOPICS_PATH): TopicRule[] {
  if (!existsSync(path)) return [];
  const doc = parse(readFileSync(path, "utf8")) as { topics?: { id?: unknown; label?: unknown; keywords?: unknown }[] } | null;
  const out: TopicRule[] = [];
  for (const t of doc?.topics ?? []) {
    if (typeof t.id !== "string" || !Array.isArray(t.keywords)) continue;
    out.push({
      id: t.id,
      label: typeof t.label === "string" ? t.label : t.id,
      keywords: t.keywords
        .filter((k): k is string => typeof k === "string")
        .map((k) => foldWords(k) + (k.trim().endsWith("$") ? "$" : ""))
        .filter((k) => k !== "" && k !== "$"),
    });
  }
  return out;
}

/** Przedrostkowe dopasowanie fraz do słów tekstu (po złożeniu diakrytyków). */
export function matchTopics(text: string, rules: TopicRule[]): { topic: TopicRule; keyword: string }[] {
  const words = foldWords(text).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const hits: { topic: TopicRule; keyword: string }[] = [];
  for (const topic of rules) {
    for (const kw of topic.keywords) {
      const exact = kw.endsWith("$");
      const parts = (exact ? kw.slice(0, -1) : kw).split(" ");
      const last = parts.length - 1;
      let found = false;
      for (let i = 0; i + parts.length <= words.length && !found; i++) {
        found = parts.every((p, j) => {
          const w = words[i + j]!;
          return exact && j === last ? w === p : w.startsWith(p);
        });
      }
      if (found) {
        hits.push({ topic, keyword: kw });
        break;
      }
    }
  }
  return hits;
}
