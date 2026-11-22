import type { Database } from "better-sqlite3";
import type { Claim, ClaimVerdict, CorpusRecord } from "../shared/contracts";
import { fold, stemToken } from "./retrieval/stem";

type TransportPolicy = "ticket_sales" | "diesel_access";

export interface LocalTransportQuestion {
  policy: TransportPolicy;
  place: string;
  placeStem: string;
  neededEvidencePl: string;
  claim: Claim;
  searchTerms: string[];
  mayAddress(record: CorpusRecord): boolean;
}

function policyOf(text: string): TransportPolicy | undefined {
  const s = fold(text);
  if (/\bbilet/.test(s) && /\baplikacj/.test(s) && /\b(?:autobus|komunikacj|przejazd|transport)/.test(s)) return "ticket_sales";
  if (/\b(?:dies(?:el|l)|olej\w* napedow)/.test(s) && /\b(?:wje|wjazd|wjad|wjez)/.test(s) && /\bcentrum\b/.test(s)) return "diesel_access";
  return undefined;
}

const PLACE = /(?:\b[Cc]entrum\s+|\b(?:[Ww]|[Ww]e)\s+(?:(?:mieście|miejscowości|gminie)\s+)?)(\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+){0,2})(?!\p{L})/u;
const CITY_AS_SUBJECT = /^(?:[Cc]zy\s+)?(\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+){0,2})\s+(?:nie\s+)?(?:wprowadz|zaka|zabron|ogranicz)/u;
// When the writer omits capital letters, accept a place only where the surrounding grammar identifies it.
const LOWER_SUBJECT = /^(?:czy\s+)?([\p{L}-]+)\s+(?:nie\s+)?(?:wprowadz|zaka|zabron|ogranicz)/iu;
const LOWER_CENTRE = /\bcentrum\s+([\p{L}-]+)\s*[.?!]?$/iu;
const LOWER_TICKETS = /\b(?:w|we)\s+([\p{L}-]+)\s+bilet/iu;
const COMMON_NOUN = /^(?:miast[a-z]*|aplikacj[a-z]*|autobus[a-z]*|gmin[a-z]*|stref[a-z]*|tygodni[a-z]*|miejscowosci|wprowadzi|wprowadza)$/;
const TOPIC_WORDS: Record<TransportPolicy, RegExp> = {
  ticket_sales: /\b(?:bilet|transport|taryf|przewoz|autobus|komunikacj|przejazd|sprzedaz)/,
  diesel_access: /\b(?:stref|wjazd|wje|dies|pojazd|samochod|spalin|emisj|transport|sct\b|ruch\w* drog)/,
};

/** Recognizes the local rule being asked about; its truth always depends on the sources searched for this request. */
export function localTransportQuestion(text: string): LocalTransportQuestion | undefined {
  if (text.length > 400 || /[!?]\s*\S|https?:\/\//i.test(text)) return undefined;
  const policy = policyOf(text);
  if (!policy) return undefined;
  const inferred = policy === "ticket_sales" ? LOWER_TICKETS : LOWER_CENTRE;
  const place = (PLACE.exec(text) ?? CITY_AS_SUBJECT.exec(text) ?? LOWER_SUBJECT.exec(text) ?? inferred.exec(text))?.[1];
  if (!place || place.length < 3 || COMMON_NOUN.test(fold(place))) return undefined;
  const first = place.split(/\s+/)[0]!;
  const placeStem = fold(stemToken(first, "pl") ?? first);
  const placeInText = (s: string) => fold(s).split(/[^\p{L}]+/u).some(word => word.startsWith(placeStem));
  return {
    policy, place, placeStem,
    neededEvidencePl: policy === "ticket_sales"
      ? "aktualny regulamin sprzedaży biletów lub komunikat organizatora transportu wskazujący dostępne sposoby zakupu i datę zmiany"
      : "uchwała rady gminy z opisem lub mapą granic strefy, wskazaniem pojazdów objętych ograniczeniem i datą jego wejścia w życie",
    claim: { id: "c1", text, type: "fakt", isMain: true, temporal: { kind: "stan" }, inputOverlap: 1 },
    searchTerms: policy === "ticket_sales" ? [place, place + " regulamin sprzedaży biletów"] : [place, place + " strefa czystego transportu"],
    mayAddress(record) {
      const content = [record.title, record.text, record.claimReviewed, record.publisher, record.url].filter(Boolean).join(" ");
      return placeInText(content) && TOPIC_WORDS[policy].test(fold(content));
    },
  };
}

/** A locality-only query prevents higher-ranked national results from hiding a municipal document. */
export function findLocalTransportRecords(db: Database, local: LocalTransportQuestion): string[] {
  const match = '"' + local.placeStem.replaceAll('"', '""') + '"*';
  const rows = db.prepare(`SELECT id FROM records JOIN records_fold ON records.rowid = records_fold.rowid
    WHERE records_fold MATCH ? ORDER BY bm25(records_fold)`).all(match) as { id: string }[];
  return rows.map(row => row.id);
}

/** Called only after a completed search has found no matching local material. */
export function unresolvedQuestion(claim: Claim, searched: string[], neededEvidencePl?: string) {
  const reason = "Nie udało mi się potwierdzić tej informacji w sprawdzonych źródłach.";
  const summaryPl = neededEvidencePl ? reason + "\nPoszukiwane źródło: " + neededEvidencePl.replace(/[.!?]+$/, "") + "." : reason;
  const verdict: ClaimVerdict = {
    claimId: claim.id, verdict: "BRAK_DOWODOW", ruleApplied: 2,
    reasonPl: reason, missingContext: neededEvidencePl,
    triedPl: searched.join(", "), evidence: [],
    strength: { level: "slaba", score: null, factors: [], notes: [], primarySources: 0, independentPublishers: 0,
      newestEvidenceAt: null, archivalWarning: false, verifierAgreement: "brak" },
  };
  return { mainVerdict: verdict.verdict, verdicts: [verdict], summaryPl };
}
