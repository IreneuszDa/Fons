import type { CorpusRecord } from "../../shared/contracts";
import { recordId } from "./common";
import type { baseFromCatalog } from "./common";
import { countryIdentity } from "../../engine/retrieval/subject";

export const REGISTER_TOPIC = "pelny-wykaz-czlonkow";
export type Organization = "NATO" | "UE";

export function memberIdentities(names: string[], declared: number): string[] | undefined {
  if (!Number.isSafeInteger(declared) || declared < 1 || names.length !== declared) return;
  const ids = names.map(name => countryIdentity(name));
  if (ids.some(id => !id) || new Set(ids).size !== declared) return;
  return ids as string[];
}

export function memberRegister(organization: Organization, base: ReturnType<typeof baseFromCatalog>,
  url: string, fetchedAt: string, publishedAt: string | null, declared: number, names: string[]): CorpusRecord | undefined {
  if (!memberIdentities(names, declared)) return;
  return { ...base, id: recordId(base.sourceId, url + "|complete-membership"), url, fetchedAt, publishedAt, lang: "pl", origin: "corpus",
    title: organization + " — pełny wykaz państw członkowskich",
    text: `Pełny wykaz państw członkowskich ${organization}. Liczba państw podana przez wydawcę: ${declared}.\n${names.join(", ")}.`,
    topics: [REGISTER_TOPIC, "generated-from-data"] };
}

/** Read back the serialized set. Unidentified, duplicated or missing countries invalidate
 * the closed-world inference; the reader still has individual positive membership entries. */
export function registeredMembers(record: CorpusRecord, org: Organization): string[] | undefined {
  if (record.id !== recordId(record.sourceId, record.url + "|complete-membership") || !record.topics.includes(REGISTER_TOPIC)) return;
  const match = /^Pełny wykaz państw członkowskich (UE|NATO)\. Liczba państw podana przez wydawcę: (\d+)\.\n([^\n]+)\.$/u.exec(record.text);
  if (match?.[1] !== org) return;
  return memberIdentities(match[3]!.split(", "), Number(match[2]));
}
