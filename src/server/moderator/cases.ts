/**
 * Pętla informacji, P1 (PLAN §8): nierozstrzygnięte zgłoszenie → sprawa moderatora, deduplikacja,
 * licznik UNIKALNYCH nadawców, jeden alert na sprawę (webhook), twardy dzienny limit alertów z licznikiem
 * pominiętych w logu.
 *
 * Deduplikacja (kolejno): (1) to samo znormalizowane twierdzenie; (2) Jaccard tokenów >= 0,6; (3) parafraza:
 * kosinus wektorów lokalnego modelu e5 >= 0,93 (0,96, gdy po którejś stronie nie ma nazw własnych/liczb).
 * W (2) i (3) „kotwice” (nazwy własne, skrótowce, liczby) muszą być zgodne — „w Elblągu” i „w Gdańsku” to dwie
 * sprawy, choć model językowy uznaje te zdania za prawie identyczne (kosinus 0,95). Progi skalibrowane na parach
 * z eval/cases (H-elblag, H-olsztyn, paliwo na Lubelszczyźnie) i parach negatywnych (inne miasto, inne zdarzenie).
 * Bez modelu (brak portu albo błąd) zostaje dopasowanie leksykalne.
 *
 * Odpowiedź dla użytkownika jest budowana dopiero z wyniku tej funkcji, czyli po zapisie do bazy;
 * „przekazano” nigdy nie pada, jeśli alert faktycznie nie wyszedł.
 */
import { localTransportQuestion } from "../../engine/local-transport";
import type { ChannelId } from "../../shared/contracts";
import type { Db, ServerContext } from "../context";
import { anchorsCompatible, claimAnchors, claimTokens, dayKey, foldWords, jaccard, normalizeClaim, truncate } from "../util";
import { dieselRestriction, sameDieselRestriction } from "./transport-case";
import { matchTopics } from "./topics";

export const JACCARD_THRESHOLD = 0.6;
/** Kosinus (e5, prefiks „query:”) dla parafrazy, gdy obie strony mają zgodne kotwice. */
export const SEMANTIC_THRESHOLD = 0.93;
/** Kosinus, gdy po którejś stronie nie ma kotwic (nie ma czym odróżnić miejsca/daty). */
export const SEMANTIC_STRICT_THRESHOLD = 0.96;
/** Część dziennego limitu alertów zarezerwowana dla alertów „wielu nadawców” (tematy nie wyczerpią całości). */
export const SENDER_ALERT_RESERVE = 0.25;
const EMBED_TIMEOUT_MS = 3000;
const MAX_CANDIDATES = 500;

export type AlertOutcome = "sent" | "none" | "no_webhook" | "cap" | "failed";

export interface CaseOutcome {
  caseId: string;
  /** created/updated: sprawa zapisana; recommended: zapisana, alert zasadny, ale NIE wysłany. */
  action: "created" | "updated" | "recommended";
  alert: AlertOutcome;
  senderCount: number;
  /** true, jeśli ten nadawca był już policzony w tej sprawie. */
  alreadyCounted: boolean;
}

interface CaseRow {
  id: number;
  representative_text: string;
  claim_norm: string;
  status: string;
  sender_count: number;
  channels_json: string;
  alert_state: string;
  vec?: Buffer | null;
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Buffer | null | undefined, dims: number): Float32Array | undefined {
  if (!b || b.byteLength !== dims * 4) return undefined;
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface DuplicateQuery {
  norm: string;
  tokens: string[];
  anchors: string[];
  vec?: Float32Array;
  text?: string;
}

/** Wybór sprawy-duplikatu (eksport dla testów kalibracji). */
export function findDuplicate(db: Db, q: DuplicateQuery): CaseRow | undefined {
  const restriction = q.text ? dieselRestriction(q.text) : undefined;
  if (restriction) {
    // This narrow lookup also finds older open cases outside the generic similarity window.
    const rows = db.prepare("SELECT * FROM moderator_cases WHERE status = 'open' AND claim_norm LIKE '%dies%' ORDER BY updated_at DESC")
      .iterate() as Iterable<CaseRow>;
    for (const row of rows) {
      const previous = dieselRestriction(row.representative_text);
      if (previous && sameDieselRestriction(restriction, previous)) return row;
    }
    return undefined;
  }
  const qualifiedRestriction = q.text && localTransportQuestion(q.text)?.policy === "diesel_access";
  const rows = db
    .prepare("SELECT * FROM moderator_cases WHERE status = 'open' ORDER BY updated_at DESC LIMIT ?")
    .all(MAX_CANDIDATES) as CaseRow[];
  let best: { row: CaseRow; sim: number } | undefined;
  let bestSemantic: { row: CaseRow; sim: number } | undefined;
  for (const row of rows) {
    // An exception, another zone or a reversal of the restriction is a different allegation.
    if (q.text && qualifiedRestriction && localTransportQuestion(row.representative_text)?.policy === "diesel_access") {
      if (foldWords(q.text) === foldWords(row.representative_text)) return row;
      continue;
    }
    if (row.claim_norm === q.norm) return row;
    const rowAnchors = claimAnchors(row.representative_text);
    if (!anchorsCompatible(q.anchors, rowAnchors)) continue;
    const sim = jaccard(q.tokens, row.claim_norm.split(" "));
    if (sim >= JACCARD_THRESHOLD && (!best || sim > best.sim)) best = { row, sim };
    if (q.vec) {
      const rv = fromBlob(row.vec, q.vec.length);
      if (rv) {
        const cos = cosine(q.vec, rv);
        const need = q.anchors.length === 0 || rowAnchors.length === 0 ? SEMANTIC_STRICT_THRESHOLD : SEMANTIC_THRESHOLD;
        if (cos >= need && (!bestSemantic || cos > bestSemantic.sim)) bestSemantic = { row, sim: cos };
      }
    }
  }
  return best?.row ?? bestSemantic?.row;
}

/** Wektor twierdzenia z lokalnego modelu (port kontekstu); brak portu, błąd albo przekroczony czas → undefined. */
async function embedClaim(ctx: ServerContext, text: string): Promise<Float32Array | undefined> {
  if (!ctx.embedClaims) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      ctx.embedClaims([text]),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), EMBED_TIMEOUT_MS);
      }),
    ]);
    const v = res?.[0];
    return v && v.length > 0 && v.every((x) => Number.isFinite(x)) ? v : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeCase(
  ctx: ServerContext,
  p: { text: string; senderId: string; channel: ChannelId },
  vec?: Float32Array,
): { row: CaseRow; created: boolean; alreadyCounted: boolean } {
  const db = ctx.db;
  const nowIso = ctx.now().toISOString();
  const norm = normalizeClaim(p.text);
  const tokens = claimTokens(p.text);
  const anchors = claimAnchors(p.text);
  const tx = db.transaction(() => {
    const existing = findDuplicate(db, { norm, tokens, anchors, vec, text: p.text });
    let id: number;
    let created = false;
    if (existing) {
      id = existing.id;
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO moderator_cases (representative_text, claim_norm, status, sender_count, channels_json, alert_state, created_at, updated_at, vec)
             VALUES (?, ?, 'open', 0, '[]', 'none', ?, ?, ?)`,
          )
          .run(truncate(p.text, 500), norm, nowIso, nowIso, vec ? toBlob(vec) : null).lastInsertRowid,
      );
      created = true;
    }
    const ins = db.prepare("INSERT OR IGNORE INTO case_senders (case_id, sender_id, channel) VALUES (?, ?, ?)").run(id, p.senderId, p.channel);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM case_senders WHERE case_id = ?").get(id) as { n: number }).n;
    const channels = (db.prepare("SELECT DISTINCT channel FROM case_senders WHERE case_id = ? ORDER BY channel").all(id) as { channel: string }[]).map((r) => r.channel);
    db.prepare("UPDATE moderator_cases SET sender_count = ?, channels_json = ?, updated_at = ? WHERE id = ?").run(
      count,
      JSON.stringify(channels),
      nowIso,
      id,
    );
    const row = db.prepare("SELECT * FROM moderator_cases WHERE id = ?").get(id) as CaseRow;
    return { row, created, alreadyCounted: ins.changes === 0 };
  });
  return tx.immediate();
}

function logAlert(ctx: ServerContext, caseId: number, outcome: string, reason: string, detail?: string): void {
  const now = ctx.now();
  ctx.db
    .prepare("INSERT INTO alerts_log (case_id, day, outcome, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(caseId, dayKey(now), outcome, reason, detail ?? null, now.toISOString());
}

function setAlertState(db: Db, caseId: number, state: string): void {
  db.prepare("UPDATE moderator_cases SET alert_state = ? WHERE id = ?").run(state, caseId);
}

async function postAlert(ctx: ServerContext, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const url = ctx.cfg.alertWebhookUrl;
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, detail: "no_webhook" };
  try {
    const res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    return { ok: res.status >= 200 && res.status < 300, detail: `http_${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.name : "error" };
  }
}

/** Tekst do Slacka/Discorda: „&”, „<”, „>” jako encje — bez <!channel>, @here ani podstawionych linków. */
export function escapeChatText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(everyone|here|channel)/gi, "@\u200b$1");
}

async function evaluateAlert(ctx: ServerContext, row: CaseRow, incomingText: string): Promise<AlertOutcome> {
  if (row.alert_state === "sent") return "none";
  const topics = matchTopics(`${row.representative_text}\n${incomingText}`, ctx.topics);
  const reason = topics.length > 0 ? `topic:${topics.map((t) => t.topic.id).join(",")}` : row.sender_count >= ctx.options.senderThreshold ? `senders>=${ctx.options.senderThreshold}` : null;
  if (!reason) return "none";

  if (!ctx.cfg.alertWebhookUrl) {
    if (row.alert_state !== "recommended") {
      setAlertState(ctx.db, row.id, "recommended");
      logAlert(ctx, row.id, "no_webhook", reason);
    }
    return "no_webhook";
  }

  const today = dayKey(ctx.now());
  const attempts = (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM alerts_log WHERE day = ? AND outcome IN ('sent','failed')").get(today) as { n: number }
  ).n;
  // Alerty tematyczne (już przy pierwszym nadawcy — łatwe do wywołania) nie mogą zająć całego limitu:
  // część jest zarezerwowana dla spraw zgłaszanych przez wielu nadawców (SEC-03).
  const topicAttempts = (
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM alerts_log WHERE day = ? AND outcome IN ('sent','failed') AND reason LIKE 'topic:%'")
      .get(today) as { n: number }
  ).n;
  const topicCap = ctx.options.dailyAlertCap - Math.floor(ctx.options.dailyAlertCap * SENDER_ALERT_RESERVE);
  if (attempts >= ctx.options.dailyAlertCap || (reason.startsWith("topic:") && topicAttempts >= topicCap)) {
    if (row.alert_state !== "skipped_cap") {
      setAlertState(ctx.db, row.id, "skipped_cap");
      logAlert(ctx, row.id, "skipped_cap", reason);
    }
    return "cap";
  }

  const res = await postAlert(ctx, {
    // „text” i „content” — gotowe do Slacka/Discorda: bez treści zgłoszenia (tekst od anonimowego nadawcy mógłby
    // wstawić <!channel> albo podstawiony link), tylko numer sprawy i odnośnik do panelu. Treść jest w polu
    // representativeText dla własnych odbiorców (JSON, nie formatowany przez komunikator).
    text: escapeChatText(`Fons: sprawa #${row.id} wymaga uwagi (${reason}, nadawców: ${row.sender_count}). Panel: ${ctx.cfg.publicBaseUrl}/admin`),
    content: escapeChatText(`Fons: sprawa #${row.id} wymaga uwagi (${reason}, nadawców: ${row.sender_count}).`),
    caseId: String(row.id),
    reason,
    senders: row.sender_count,
    representativeText: truncate(row.representative_text, 500),
    link: `${ctx.cfg.publicBaseUrl}/admin`,
  });
  if (res.ok) {
    setAlertState(ctx.db, row.id, "sent");
    logAlert(ctx, row.id, "sent", reason, res.detail);
    return "sent";
  }
  setAlertState(ctx.db, row.id, "failed");
  logAlert(ctx, row.id, "failed", reason, res.detail);
  return "failed";
}

/**
 * Tworzy lub aktualizuje sprawę. Rzuca wyjątek, gdy zapis do bazy się nie powiódł
 * (wywołujący wtedy NIE może twierdzić, że sprawa istnieje).
 */
export async function recordUnresolved(
  ctx: ServerContext,
  p: { text: string; senderId: string; channel: ChannelId },
): Promise<CaseOutcome> {
  // Wektor liczony PRZED transakcją (asynchronicznie); tylko gdy dopasowanie leksykalne mogłoby nie wystarczyć.
  const vec = await embedClaim(ctx, p.text);
  const { row, created, alreadyCounted } = writeCase(ctx, p, vec);
  let alert: AlertOutcome = "none";
  try {
    alert = await evaluateAlert(ctx, row, p.text);
  } catch {
    alert = "failed";
  }
  const delivered = alert === "sent";
  const wanted = alert !== "none";
  return {
    caseId: String(row.id),
    action: wanted && !delivered ? "recommended" : created ? "created" : "updated",
    alert,
    senderCount: row.sender_count,
    alreadyCounted,
  };
}
