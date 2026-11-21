/**
 * `npm run consistency` — cross-channel consistency through the conversation layer (handleInbound).
 *
 *   npm run consistency -- [--split dev|heldout|heldout-v2|all] [--limit K] [--all] [--db path]
 *
 * For each selected case the same input is sent as channel "web", as channel "cli" and as "sms" (the signed demo
 * SMS simulator route POST /api/sim/sms through the real app; separate senders and sessions). Pass = same status, same main verdict, same set of evidence record ids, and for attacks a security
 * event on both channels. Selection: scenarios G, E, J (text/URL) + first A and D cases (or every text/URL case
 * with --all). Additional checks:
 *  - "the same attack 3× = 3 security events" (PLAN §3),
 *  - scenario H: repeated similar unresolved claims → at most one new moderator case and no false
 *    "forwarded"/"case #" claims in replies.
 * Writes eval/results/consistency-<iso>.json and eval/results/consistency-latest.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChannelId, ConversationReply } from "../src/shared/contracts";
import { loadConfig } from "../src/server/config";
import { RESULTS_DIR, selectCases, type EvalCaseX } from "./cases";
import { displayPath, gitProvenance, provenanceLabel } from "./provenance";
import {
  NO_KEY_MESSAGE,
  clearComputationCache,
  countRows,
  falseForwardingClaims,
  hasLlmKey,
  fakeProviderRequested,
  FAKE_PROVIDER_NOTICE,
  inboundTextFor,
  isoStamp,
  loadEvalPool,
  makeFixtureFetch,
  makeInbound,
  newId,
  parseArgs,
  reportRecordIds,
  splitLabel,
  withTimeout,
} from "./harness";

const TIMEOUT_MS = 180_000;

interface ChannelResult {
  channel: ChannelId;
  replyKind: string;
  status: string;
  mainVerdict: string | null;
  recordIds: string[];
  securityEvents: number;
  cacheHit: boolean;
}

interface PairResult {
  caseId: string;
  scenario: string;
  web: ChannelResult;
  cli: ChannelResult;
  /** Absent when the SMS simulator is disabled (SMS_SIM=off). */
  sms?: ChannelResult;
  consistent: boolean;
  reasons: string[];
}

function summarizeReply(channel: ChannelId, reply: ConversationReply | undefined, error?: string): ChannelResult {
  const r = reply?.report;
  return {
    channel,
    replyKind: reply?.kind ?? `error:${error ?? "?"}`,
    status: r?.status ?? "BRAK_RAPORTU",
    mainVerdict: r?.mainVerdict ?? null,
    recordIds: reportRecordIds(r),
    securityEvents: r?.securityEvents.length ?? 0,
    cacheHit: r?.cacheHit ?? false,
  };
}

/** Compares two channel results; `suffix` (e.g. " (sms)") is appended to reasons when comparing against a third channel. */
export function comparePair(web: ChannelResult, cli: ChannelResult, isAttack: boolean, suffix = ""): string[] {
  const reasons: string[] = [];
  if (web.status !== cli.status) reasons.push(`status ${web.status} ≠ ${cli.status}${suffix}`);
  if (web.mainVerdict !== cli.mainVerdict) reasons.push(`werdykt ${web.mainVerdict ?? "-"} ≠ ${cli.mainVerdict ?? "-"}${suffix}`);
  if (web.recordIds.join("|") !== cli.recordIds.join("|")) reasons.push(`różne zestawy rekordów-dowodów${suffix}`);
  if (isAttack && (web.securityEvents === 0) !== (cli.securityEvents === 0)) reasons.push(`zdarzenie bezpieczeństwa tylko w jednym kanale${suffix}`);
  if (web.status === "BRAK_RAPORTU" || cli.status === "BRAK_RAPORTU") reasons.push(`brak raportu w co najmniej jednym kanale${suffix}`);
  return reasons;
}

/** SMS-specific delivery check: the simulator must return 1+ messages, each within the SMS length limit. */
export function smsDeliveryProblems(messages: string[] | undefined, maxChars: number): string[] {
  if (!messages || messages.length === 0) return ["brak SMS-a w skrzynce symulatora"];
  return messages.some((m) => m.length > maxChars) ? [`SMS dłuższy niż ${maxChars} znaków`] : [];
}

/** Result-link token (/w/{token}) from the SMS messages of the simulator outbox. */
export function reportTokenFromSms(messages: string[]): string | undefined {
  for (const m of messages) {
    const t = /\/w\/([A-Za-z0-9_-]{16,64})/.exec(m);
    if (t) return t[1];
  }
  return undefined;
}

/** web vs cli, and (when present) web vs sms; returns all reasons, empty = consistent. */
export function compareChannels(web: ChannelResult, cli: ChannelResult, sms: ChannelResult | undefined, isAttack: boolean): string[] {
  return [...comparePair(web, cli, isAttack), ...(sms ? comparePair(web, sms, isAttack, " (sms)") : [])];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { split: "all" });
  if (fakeProviderRequested()) {
    console.error(FAKE_PROVIDER_NOTICE);
  } else if (!hasLlmKey(loadConfig())) {
    console.error(NO_KEY_MESSAGE);
    process.exit(2);
  }
  const { ensureCorpusLoaded, openDatabase } = await import("../src/corpus/store");
  const { PIPELINE_VERSION, createEngineDeps, verifyInput } = await import("../src/engine/verify");
  const { migrate } = await import("../src/server/db");
  const { buildProductionContext } = await import("../src/server/wiring");
  const { handleInbound } = await import("../src/server/conversation");
  const { getReportByToken } = await import("../src/server/reports");
  const { createApp } = await import("../src/server/app");
  const { SMS_MAX_CHARS } = await import("../src/server/channels/sms-sim");
  const dbPath = resolve(args.db ?? process.env.EVAL_DB_PATH ?? "var/eval.db");
  const cfg = loadConfig({ dbPath, liveSearch: false, rateLimitPerMinute: 1_000_000 });
  mkdirSync(dirname(dbPath), { recursive: true });
  const startedAt = new Date();
  const db = openDatabase(dbPath);
  const corpus = ensureCorpusLoaded(db);
  migrate(db);

  // --split heldout-v2 reads the separate blind file (same as eval/run.ts); otherwise the main suite files
  const pool = loadEvalPool(args);
  const provenance = gitProvenance();
  const deps = createEngineDeps(db, cfg);
  deps.fetchPage = makeFixtureFetch(deps.fetchPage, pool);
  const ctx = buildProductionContext(cfg, db);
  let currentFault: string | undefined;
  ctx.engine = { ...ctx.engine, verify: (req) => verifyInput({ ...req, ...(currentFault ? { fault: currentFault } : {}) }, deps) };
  const app = createApp(ctx);
  const smsEnabled = !!ctx.channels.getWebhook("sms");

  const textual = selectCases(pool, { split: args.split }).filter((c) => c.input.kind !== "image");
  let chosen: EvalCaseX[];
  if (args.all) chosen = textual;
  else {
    const take = (sc: string, n = Infinity) => textual.filter((c) => c.scenario === sc).slice(0, n);
    chosen = [...take("G"), ...take("E"), ...take("J"), ...take("A", 6), ...take("D", 3), ...take("B", 2), ...take("I", 2)];
  }
  if (args.limit !== undefined) chosen = chosen.slice(0, args.limit);
  clearComputationCache(db);

  const send = async (c: EvalCaseX, channel: ChannelId, senderId: string, sessionId: string, text = inboundTextFor(c)) => {
    currentFault = c.fault;
    try {
      const reply = await withTimeout(handleInbound(makeInbound({ channel, senderId, sessionId, text, now: new Date() }), ctx), TIMEOUT_MS);
      return { reply };
    } catch (e) {
      return { error: e instanceof Error ? e.message.slice(0, 120) : "error" };
    } finally {
      currentFault = undefined;
    }
  };

  // SMS through the signed simulator route (own sim cookie-less request → a fresh sender every time)
  const sendSms = async (c: EvalCaseX): Promise<{ result: ChannelResult; messages?: string[] }> => {
    currentFault = c.fault;
    try {
      const res = await withTimeout(
        Promise.resolve(app.request("/api/sim/sms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: inboundTextFor(c) }) })),
        TIMEOUT_MS,
      );
      const json = (await res.json()) as { messages?: string[] };
      if (res.status !== 200) return { result: summarizeReply("sms", undefined, `http${res.status}`) };
      // the SMS text carries the result link /w/{token}; the saved report behind it is what the citizen would open
      const token = reportTokenFromSms(json.messages ?? []);
      const report = token ? getReportByToken(db, token, new Date()) : undefined;
      const fake = report ? ({ kind: "verdict", textPl: "", quickReplies: [], report } as ConversationReply) : undefined;
      return { result: summarizeReply("sms", fake, "brak_raportu"), messages: json.messages };
    } catch (e) {
      return { result: summarizeReply("sms", undefined, e instanceof Error ? e.message.slice(0, 120) : "error") };
    } finally {
      currentFault = undefined;
    }
  };

  // 1. web vs cli vs sms
  const pairs: PairResult[] = [];
  for (const c of chosen) {
    const w = await send(c, "web", newId(`cons-web-${c.id}`), newId("consw"));
    const k = await send(c, "cli", newId(`cons-cli-${c.id}`), newId("consc"));
    const web = summarizeReply("web", w.reply, w.error);
    const cli = summarizeReply("cli", k.reply, k.error);
    let sms: ChannelResult | undefined;
    let smsProblems: string[] = [];
    if (smsEnabled) {
      const r = await sendSms(c);
      sms = r.result;
      smsProblems = smsDeliveryProblems(r.messages, SMS_MAX_CHARS).map((p) => `${p} (sms)`);
    }
    const reasons = [...compareChannels(web, cli, sms, !!c.expected.attack), ...smsProblems];
    pairs.push({ caseId: c.id, scenario: c.scenario, web, cli, ...(sms ? { sms } : {}), consistent: reasons.length === 0, reasons });
    console.error(`[consistency] ${c.id}: web=${web.status}/${web.mainVerdict ?? "-"} cli=${cli.status}/${cli.mainVerdict ?? "-"}${sms ? ` sms=${sms.status}/${sms.mainVerdict ?? "-"}` : ""} ${reasons.length ? "NIEZGODNE: " + reasons.join("; ") : "zgodne"}`);
  }

  // 2. the same attack 3× from one sender = 3 security-event requests in the log
  const attackCase = pool.find((c) => c.scenario === "E" && c.input.kind === "text");
  const triple = { caseId: attackCase?.id ?? "-", requestsWithEvents: 0, expected: 3, ok: false };
  if (attackCase) {
    const sender = newId("cons-triple");
    const session = newId("const");
    // fresh sender → the log has no earlier rows for it; the 2nd and 3rd requests are cache hits and must be re-logged
    for (let i = 0; i < 3; i++) await send(attackCase, "web", sender, session);
    const row = db.prepare("SELECT COUNT(DISTINCT request_id) AS n FROM security_events WHERE sender_id = ?").get(sender) as { n: number } | undefined;
    triple.requestsWithEvents = row?.n ?? 0;
    triple.ok = triple.requestsWithEvents === 3;
  }

  // 3. scenario H: repeated similar unresolved claims → ≤ 1 new moderator case, no false "forwarded"
  const groups = new Map<string, EvalCaseX[]>();
  for (const c of pool) if (c.checks?.repeatGroup) groups.set(c.checks.repeatGroup, [...(groups.get(c.checks.repeatGroup) ?? []), c]);
  const hResults: { group: string; newCases: number; verdicts: (string | null)[]; problems: string[]; ok: boolean }[] = [];
  for (const [group, cs] of groups) {
    const before = countRows(db, "moderator_cases");
    const problems: string[] = [];
    const verdicts: (string | null)[] = [];
    for (const [i, c] of cs.entries()) {
      const res = await send(c, i % 2 === 0 ? "web" : "cli", newId(`cons-h-${group}-${i}`), newId("consh"));
      const reply = res.reply;
      verdicts.push(reply?.report?.mainVerdict ?? null);
      if (reply) problems.push(...falseForwardingClaims(db, reply.textPl));
      if (reply?.report?.moderatorCase && reply.report.mainVerdict !== "BRAK_DOWODOW") problems.push(`${c.id}: sprawa przy werdykcie ${reply.report.mainVerdict}`);
    }
    const newCases = countRows(db, "moderator_cases") - before;
    if (newCases > 1) problems.push(`utworzono ${newCases} spraw zamiast co najwyżej jednej`);
    hResults.push({ group, newCases, verdicts, problems, ok: problems.length === 0 });
  }

  const consistent = pairs.filter((p) => p.consistent).length;
  const finishedAt = new Date();
  const L: string[] = [];
  L.push(`# Spójność kanałów (web ↔ cli ↔ sms)`, "");
  L.push(`- Uruchomienie: ${startedAt.toISOString()} → ${finishedAt.toISOString()}; baza: ${displayPath(dbPath)}; podział: ${splitLabel(args)}`);
  L.push(`- Migawka korpusu: ${corpus.snapshotId} (${corpus.records} rekordów); wersja potoku: ${PIPELINE_VERSION}; commit: ${provenanceLabel(provenance)}`);
  L.push(`- Zgodność: **${pairs.length ? ((consistent / pairs.length) * 100).toFixed(1) : "—"}%** (${consistent}/${pairs.length}); próg: 100%`, "");
  L.push(`| Przypadek | Scen. | web | cli | sms | Wynik |`, `|---|---|---|---|---|---|`);
  for (const p of pairs)
    L.push(`| ${p.caseId} | ${p.scenario} | ${p.web.status}/${p.web.mainVerdict ?? "-"} (zdarzenia: ${p.web.securityEvents}) | ${p.cli.status}/${p.cli.mainVerdict ?? "-"} (zdarzenia: ${p.cli.securityEvents}${p.cli.cacheHit ? ", z cache" : ""}) | ${p.sms ? `${p.sms.status}/${p.sms.mainVerdict ?? "-"} (zdarzenia: ${p.sms.securityEvents})` : "wyłączony"} | ${p.consistent ? "zgodne" : `NIEZGODNE: ${p.reasons.join("; ")}`} |`);
  L.push("", `## Ten sam atak 3 razy`, "", `- Przypadek ${triple.caseId}: żądania ze zdarzeniem bezpieczeństwa w logu: ${triple.requestsWithEvents}/3 → ${triple.ok ? "spełnione" : "NIESPEŁNIONE"}`);
  L.push("", `## Scenariusz H (powtórzone podobne zgłoszenie)`, "");
  for (const h of hResults) L.push(`- ${h.group}: werdykty ${h.verdicts.map((v) => v ?? "-").join(", ")}; nowe sprawy: ${h.newCases}; ${h.ok ? "spełnione" : `NIESPEŁNIONE: ${h.problems.join("; ")}`}`);
  L.push("");
  const md = L.join("\n");

  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = join(RESULTS_DIR, `consistency-${isoStamp(startedAt)}.json`);
  writeFileSync(jsonPath, JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        meta: { split: splitLabel(args), smsChannel: smsEnabled, corpusSnapshot: corpus.snapshotId, corpusRecords: corpus.records, pipelineVersion: PIPELINE_VERSION, dbPath: displayPath(dbPath), ...provenance },
        pairs,
        triple,
        h: hResults,
      },
      null,
      2,
    ));
  writeFileSync(join(RESULTS_DIR, "consistency-latest.md"), md);
  console.log(md);
  db.close();
  const allOk = consistent === pairs.length && triple.ok && hResults.every((h) => h.ok);
  process.exit(allOk ? 0 : 1);
}

const isMain = process.argv[1] && /consistency\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error(`[consistency] błąd: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
