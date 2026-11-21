/**
 * Text helpers shared by the security module (fetch extraction, detector).
 */

/** Zero-width, soft hyphen, word joiners, BOM, bidi embedding/override/isolate controls, Mongolian vowel separator. */
export const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]/g;

/** Bidi controls only (used as a weak attack signal). */
export const BIDI_RE = /[‪-‮⁦-⁩]/;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, "");
}

/** Collapses horizontal whitespace, trims lines, limits blank lines to one. */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v    -   　]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits text into sentence-like spans (on . ! ? … followed by whitespace, and on line breaks).
 * Spans keep offsets into the original string so that callers can cut them out.
 */
export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  const sep = /(?<=[.!?…])[ \t ]+|[ \t]*\n[\s]*/g;
  let last = 0;
  for (const m of text.matchAll(sep)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx), start: last, end: idx });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: last, end: text.length });
  return out.filter((s) => s.text.trim() !== "");
}

/** Shortens to `max` characters with an ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
