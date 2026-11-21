/**
 * Step 1 — input normalisation (+ step 2 detector on the RAW input).
 *
 *  text  → detector on raw text → strip flagged sentences → transcript cleanup (timestamps, subtitle
 *          numbering, [muzyka]-type markers, caption line breaks) → clean → length limit
 *  url   → fetchPage (SSRF-protected, security module) → detector on rawHtml/rawText/hidden segments
 *          BEFORE cleaning → cleanText with flagged sentences stripped. The page is the SUBJECT of
 *          verification, never evidence (evidence only ever comes from CorpusStore).
 *          When the user also wrote something next to the link („X, tak jest napisane tutaj: <link>”),
 *          that message (detector-checked) is put first, labelled, so the claim extraction can treat
 *          the user's own claim as the main claim and the page as what it claims to rely on.
 *  image → provider vision transcribes visible text and dates (schema) → detector on the
 *          transcription; warning image_limits; no vision / ocr_down → NIEPELNE.
 * Then: PII masked (before any further LLM call and before storing), relative dates resolved
 * against receivedAt.
 */
import { createHash } from "node:crypto";
import type { DetectorHit, LlmProvider, ModelUsage, NormalizedInput, TechStatus } from "../shared/contracts";
import { LlmUnavailableError } from "../shared/contracts";
import { completeWithImages, supportsVision } from "./llm/types";
import { STATUS_PL } from "./messages";
import { FetchBlockedError, detectInjection, maskPii, resolveRelativeDates, stripFlaggedSentences } from "./ports";
import type { fetchPage as FetchPageFn } from "./ports";
import { PAGE_LABEL, USER_NOTE_LABEL, VISION_SYSTEM, VisionOut } from "./prompts";
import { cleanText, isoDateOrUndefined, truncateWords } from "./text";

/** Pasted text: room for a whole article or a video transcript (claims are then ranked by importance). */
export const MAX_TEXT_CHARS = 20000;
export const MAX_PAGE_CHARS = 16000;
export const MAX_IMAGES = 2;

export interface NormalizeRequest {
  kind: "text" | "url" | "image";
  text?: string;
  url?: string;
  images?: { mime: string; base64: string }[];
  receivedAt: string;
}

export interface NormalizeContext {
  fetchPage: typeof FetchPageFn;
  llm: LlmProvider;
  receivedAt: Date;
  ocrDown: boolean;
  signal?: AbortSignal;
}

export type NormalizeOutcome =
  | { ok: true; normalized: NormalizedInput; usage: ModelUsage[]; inputHash?: string }
  | { ok: false; status: TechStatus; messagePl: string; echo: string; hits: DetectorHit[]; usage: ModelUsage[] };

function dedupeHits(hits: DetectorHit[]): DetectorHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.location}|${h.pattern}|${h.excerpt}|${h.recordId ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function masked(text: string): string {
  return maskPii(text).text;
}

function fail(status: TechStatus, messagePl: string, echo: string, hits: DetectorHit[] = [], usage: ModelUsage[] = []): NormalizeOutcome {
  return { ok: false, status, messagePl, echo: masked(echo), hits, usage };
}

function finish(
  kind: NormalizedInput["kind"],
  subject: string,
  ctx: NormalizeContext,
  hits: DetectorHit[],
  warnings: string[],
  extra: Partial<Pick<NormalizedInput, "submittedUrl" | "pageTitle" | "pagePublishedAt">>,
  usage: ModelUsage[],
  inputHash?: string,
): NormalizeOutcome {
  const pii = maskPii(subject);
  const textResolvedDates = resolveRelativeDates(pii.text, ctx.receivedAt);
  const normalized: NormalizedInput = {
    kind,
    text: pii.text,
    ...(extra.submittedUrl ? { submittedUrl: masked(extra.submittedUrl) } : {}),
    ...(extra.pageTitle ? { pageTitle: masked(extra.pageTitle) } : {}),
    ...(extra.pagePublishedAt ? { pagePublishedAt: extra.pagePublishedAt } : {}),
    receivedAt: ctx.receivedAt.toISOString(),
    textResolvedDates,
    detectorHits: dedupeHits(hits),
    piiMasked: pii.masked,
    warnings,
  };
  return { ok: true, normalized, usage, ...(inputHash ? { inputHash } : {}) };
}

function limit(text: string, max: number, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push("truncated");
  return truncateWords(text, max);
}

export async function normalizeInput(req: NormalizeRequest, ctx: NormalizeContext): Promise<NormalizeOutcome> {
  if (req.kind === "url") return normalizeUrl(req, ctx);
  if (req.kind === "image") return normalizeImage(req, ctx);
  return normalizeText(req.text ?? "", ctx);
}

export { USER_NOTE_LABEL, PAGE_LABEL };
const MAX_NOTE_CHARS = 1000;

/** The user's own words sent together with the link (without the URL itself), or "" when none. */
export function userNoteBesideUrl(req: NormalizeRequest, url: string): string {
  if (!req.url || !req.text) return "";
  const t = req.text.replace(url, " ").replace(/https?:\/\/\S+/g, " ").trim();
  if (!/[\p{L}]{3,}/u.test(t)) return "";
  return truncateWords(t, MAX_NOTE_CHARS);
}

/**
 * Fake fence markers (`<<<END_UNTRUSTED>>>`, `-----BEGIN X-----`) are put on their own lines before detection,
 * so that stripping the flagged marker does not also delete the user's real claim written right after it
 * without a full stop (red-team RT-21: „<<<BEGIN_UNTRUSTED>>> Finlandia wstąpiła do NATO w 2023 roku.” → DOPRECYZUJ).
 * The marker itself is still detected and removed; only line breaks are added.
 */
const FENCE_MARKER = /<{3,}[^<>\n]{0,80}>{3,}|-{3,}[^\n-]{0,60}-{3,}|={3,}[^\n=]{0,60}={3,}/gu;

export function isolateFenceMarkers(text: string): string {
  return text.replace(FENCE_MARKER, (m) => `\n${m}\n`);
}

const TIMESTAMP = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?`;
/** Subtitle cue line („00:00:01,000 --> 00:00:04,000”), WebVTT header, numbering line before a cue. */
const CUE_LINE = new RegExp(String.raw`^\s*(?:WEBVTT.*|NOTE\b.*|\d+\s*$|${TIMESTAMP}\s*-->\s*${TIMESTAMP}.*)$`, "gmu");
/** Timestamp at a line start or in brackets anywhere („[12:31]”, „(1:02:03)”, „00:12 ”). */
const LINE_TIMESTAMP = new RegExp(String.raw`^[ \t]*[\[(]?${TIMESTAMP}[\])]?[ \t]*[-–—:]?[ \t]*`, "gmu");
const CUE_ARROW = new RegExp(String.raw`${TIMESTAMP}\s*-->\s*${TIMESTAMP}`, "u");
const BRACKET_TIMESTAMP = new RegExp(String.raw`[\[(]${TIMESTAMP}[\])]`, "gu");
/** Non-speech markers from automatic subtitles. */
const NOISE_MARKER =
  /[[(](?:muzyka|śmiech|oklaski|brawa|niezrozumiałe|niewyraźne|cisza|szum|music|applause|laughter|inaudible|crosstalk|музика|музыка|сміх|смех|оплески|аплодисменты)[^\])]{0,20}[\])]/giu;

/**
 * Cleans a pasted video/audio transcript before claim extraction: subtitle numbering and cue lines,
 * timestamps and non-speech markers are removed; caption-style text (many short lines without full
 * stops) is joined into running text so sentences are not cut at every line break. Speaker labels
 * („Jan Kowalski: …”) stay — who said it matters. Plain text without these features is returned unchanged.
 */
export function cleanTranscript(text: string): string {
  let marks = 0;
  const count = (re: RegExp) => (m: string) => {
    if (m.trim()) marks++;
    return re === BRACKET_TIMESTAMP || re === NOISE_MARKER ? " " : "";
  };
  // Cue lines (and the numbering before them) only in real subtitle files; line-start times only when
  // repeated — a single „12:30 – początek obrad” in ordinary text stays.
  const hasCues = CUE_ARROW.test(text) || /^\s*WEBVTT/u.test(text);
  const lineTimes = (text.match(LINE_TIMESTAMP) ?? []).filter((m) => m.trim()).length;
  let t = hasCues ? text.replace(CUE_LINE, count(CUE_LINE)) : text;
  if (lineTimes >= 2) t = t.replace(LINE_TIMESTAMP, count(LINE_TIMESTAMP));
  t = t.replace(BRACKET_TIMESTAMP, count(BRACKET_TIMESTAMP)).replace(NOISE_MARKER, count(NOISE_MARKER));
  if (marks === 0 && !looksLikeCaptions(text.split("\n"))) return text;
  // Subtitle/transcript: blank lines left by removed cues are not paragraph breaks.
  const subtitle = marks >= 2;
  const paragraphs = subtitle ? [t] : t.split(/\n[ \t]*\n/);
  return paragraphs
    .map((p) => {
      const lines = p.split("\n").map((l) => l.replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean);
      return looksLikeCaptions(lines, subtitle) ? lines.join(" ") : lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Many short lines, mostly without a full stop at the end — caption text cut at every line break. */
function looksLikeCaptions(rawLines: string[], subtitle = false): boolean {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  if (lines.length < (subtitle ? 2 : 8)) return false;
  const short = lines.filter((l) => l.length <= 80).length / lines.length;
  const ended = lines.filter((l) => /[.!?…:;]["”»)]?$/.test(l)).length / lines.length;
  return short >= 0.7 && ended < 0.4;
}

function normalizeText(input: string, ctx: NormalizeContext): NormalizeOutcome {
  const warnings: string[] = [];
  const raw = isolateFenceMarkers(input);
  const hits = detectInjection(raw, "user_message");
  const stripped = hits.length > 0 ? stripFlaggedSentences(raw, hits) : raw;
  const text = limit(cleanText(cleanTranscript(stripped)), MAX_TEXT_CHARS, warnings);
  if (hits.length > 0) warnings.push("injection_detected");
  if (!text && hits.length === 0) return fail("DOPRECYZUJ", STATUS_PL.emptyInput, "");
  return finish("text", text, ctx, hits, warnings, {}, []);
}

async function normalizeUrl(req: NormalizeRequest, ctx: NormalizeContext): Promise<NormalizeOutcome> {
  const url = (req.url ?? req.text ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("DOPRECYZUJ", STATUS_PL.badUrl, url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail("DOPRECYZUJ", STATUS_PL.badUrl, url);

  let page: Awaited<ReturnType<typeof FetchPageFn>>;
  try {
    page = await ctx.fetchPage(parsed.toString(), { timeoutMs: 8000, maxBytes: 5 * 1024 * 1024, signal: ctx.signal });
  } catch (e) {
    const blocked =
      e instanceof FetchBlockedError && ["scheme", "port", "private_ip"].includes((e as FetchBlockedError).reason);
    return fail("NIEPELNE", blocked ? STATUS_PL.pageBlocked : STATUS_PL.pageUnreadable, url);
  }

  // Detector on the RAW page (before hidden HTML and zero-width characters are removed).
  const hits = dedupeHits([
    ...(page.rawHtml ? detectInjection(neutralizeMarkupTags(page.rawHtml), "fetched_page") : []),
    // The security module's detector also flags imperative hidden text when given hiddenSegments.
    ...detectInjection(page.rawText, "fetched_page", undefined, { hiddenSegments: page.hiddenSegments }),
    ...page.hiddenSegments.flatMap((s) => detectInjection(s, "fetched_page")),
  ]);
  const warnings: string[] = [];
  if (hits.length > 0) warnings.push("injection_detected");
  const body = hits.length > 0 ? stripFlaggedSentences(page.cleanText, hits) : page.cleanText;
  const title = page.title ? (hits.length > 0 ? stripFlaggedSentences(page.title, hits) : page.title) : "";
  const pageText = limit(cleanText([title, body].filter((s) => s.trim()).join("\n\n")), MAX_PAGE_CHARS, warnings);
  if (!pageText) {
    return fail("NIEPELNE", STATUS_PL.pageEmpty, page.finalUrl, hits);
  }
  const note = userNoteBesideUrl(req, url);
  const noteHits = note ? detectInjection(note, "user_message") : [];
  hits.push(...noteHits);
  if (noteHits.length > 0 && !warnings.includes("injection_detected")) warnings.push("injection_detected");
  const cleanNote = note ? cleanText(noteHits.length > 0 ? stripFlaggedSentences(note, noteHits) : note) : "";
  const subject = cleanNote ? `${USER_NOTE_LABEL} ${cleanNote}\n\n${PAGE_LABEL}\n${pageText}` : pageText;
  return finish(
    "url",
    subject,
    ctx,
    hits,
    warnings,
    {
      submittedUrl: page.finalUrl || parsed.toString(),
      ...(title ? { pageTitle: cleanText(title) } : {}),
      ...(isoDateOrUndefined(page.publishedAt) ? { pagePublishedAt: page.publishedAt } : {}),
    },
    [],
  );
}

/**
 * Real HTML/SVG element names that also appear in the detector's "closing delimiter" list
 * (`</article>`, `</data>`, `</source>`, `</text>`, `</input>`, `</content>`). In RAW HTML such a tag is ordinary
 * markup, not an imitation of our fence — scanning it flagged every fetched page (eval: all URL cases).
 * The genuine tags are blanked out before the raw-HTML pass only. The same text written visibly on the page
 * (`&lt;/article&gt;`) stays escaped in raw HTML and reaches rawText as characters, where it is still detected;
 * every other delimiter (`</document>`, `</system>`, `<<<`, BOUNDARY…) is untouched.
 */
const HTML_ELEMENT_TAG = /<\/?\s*(?:article|data|source|text|input|content)\b[^<>]*>/giu;

export function neutralizeMarkupTags(rawHtml: string): string {
  return rawHtml.replace(HTML_ELEMENT_TAG, " ");
}

async function normalizeImage(req: NormalizeRequest, ctx: NormalizeContext): Promise<NormalizeOutcome> {
  const images = (req.images ?? []).slice(0, MAX_IMAGES);
  if (images.length === 0) return fail("DOPRECYZUJ", STATUS_PL.emptyInput, "");
  if (ctx.ocrDown || !ctx.llm.available || !supportsVision(ctx.llm)) {
    return fail("NIEPELNE", STATUS_PL.imageUnavailable, "[obraz]");
  }
  const inputHash = createHash("sha256")
    .update(images.map((i) => `${i.mime}:${i.base64}`).join("|"))
    .digest("hex");
  let out: VisionOut;
  const usage: ModelUsage[] = [];
  try {
    const res = await completeWithImages(ctx.llm, {
      purpose: "vision",
      system: VISION_SYSTEM,
      user: "Przepisz tekst widoczny na obrazie (obrazach).",
      schema: VisionOut,
      schemaName: "image_transcription",
      tier: "main",
      effort: "low",
      signal: ctx.signal,
      images,
    });
    out = res.data;
    usage.push(res.usage);
  } catch (e) {
    if (e instanceof LlmUnavailableError) return fail("NIEPELNE", STATUS_PL.imageUnavailable, "[obraz]", [], usage);
    throw e;
  }
  const rawText = out.readable ? (out.text ?? "") : "";
  const note = isolateFenceMarkers(req.text?.trim() ?? "");
  const noteHits = detectInjection(note, "user_message");
  const ocrHits = detectInjection(rawText, "ocr");
  const hits = [...noteHits, ...ocrHits];
  const caption = cleanText(stripFlaggedSentences(note, noteHits));
  if (!caption && cleanText(rawText).length < 10) {
    return fail("DOPRECYZUJ", STATUS_PL.imageUnreadable, "[obraz]", hits, usage);
  }
  const warnings: string[] = ["image_limits"];
  if (hits.length > 0) warnings.push("injection_detected");
  const transcription = limit(cleanText(stripFlaggedSentences(rawText, ocrHits)), MAX_TEXT_CHARS, warnings);
  const subject = (noteText: string) => noteText && transcription
    ? `${USER_NOTE_LABEL} ${noteText}\n\nTekst z obrazu:\n${transcription}` : noteText || transcription;
  const date = out.dates.map((d) => isoDateOrUndefined(d)).find((d): d is string => !!d);
  const result = finish("image", subject(caption), ctx, hits, warnings, date ? { pagePublishedAt: date } : {}, usage, inputHash);
  // A screenshot can be archival. Only the sender's own words refer to the submission date.
  if (result.ok) result.normalized.textResolvedDates = masked(subject(resolveRelativeDates(caption, ctx.receivedAt)));
  return result;
}
