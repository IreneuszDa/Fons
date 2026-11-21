/**
 * The only place where the engine core imports other modules (security, corpus, retrieval, verdict),
 * using the signatures fixed in docs/MODULES.md. Tests replace this single file with local stubs.
 */
export { fetchPage, FetchBlockedError } from "../security/fetch";
export type { FetchedPage } from "../security/fetch";
export { detectInjection, stripFlaggedSentences } from "../security/detector";
export { maskPii } from "../security/pii";
export { resolveRelativeDates } from "../security/dates";
export { createCorpusStore } from "../corpus/store";
export { createRetrievalBranches, retrieve, matchIncidentDomains, pinOfficialRecords, warmUp } from "./retrieval";
export { decideVerdict, isDecisive } from "./verdict";
export type { VerdictInput, VerdictDecision } from "./verdict";
