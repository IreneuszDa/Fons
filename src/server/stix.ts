import { createHash, randomUUID } from "node:crypto";
import mappings from "../../data/disarm-mappings.json";
import type { Db } from "./context";

// STIX 2.1 §2.9 and §6.18: UUIDv5 over canonical JSON of the URL object's value.
const STIX_SCO_NAMESPACE = Buffer.from("00abedb4-aa42-466c-9c01-fed23315a9b7".replaceAll("-", ""), "hex");
function urlId(value: string): string {
  const hash = createHash("sha1").update(STIX_SCO_NAMESPACE).update(JSON.stringify({ value })).digest().subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `url--${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only the public catalog enters STIX. Its URLs link to analyses, not to indicators of compromise. */
export function incidentBundle(db: Db) {
  const rows = db.prepare(`SELECT i.id, i.url FROM incidents i JOIN records r ON i.record_id = r.id AND r.url = i.url
    WHERE r.origin = 'corpus' ORDER BY i.id`).all() as { id: string; url: string }[];
  const sources = new Map<string, string>();
  const incidentUrls = new Map<string, string>();
  for (const row of rows) {
    if (!URL.canParse(row.url)) continue;
    const u = new URL(row.url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) continue;
    sources.set(row.url, urlId(row.url));
    incidentUrls.set(row.id, row.url);
  }
  const notes = mappings.filter(m => incidentUrls.get(m.incidentId) === m.url).map(m => ({
    type: "note", spec_version: "2.1", id: m.stixNoteId, created: m.reviewedAt, modified: m.reviewedAt,
    authors: ["Fons"], lang: "pl", content: m.reasonPl, object_refs: [sources.get(m.url)!],
    external_references: [{ source_name: m.publisher, url: m.url }, { source_name: "DISARM", external_id: m.technique, url: m.techniqueUrl }],
  }));
  const objects = [...[...sources].map(([value, id]) => ({ type: "url", spec_version: "2.1", id, value })), ...notes];
  return { type: "bundle", id: "bundle--" + randomUUID(), ...(objects.length && { objects }) };
}
