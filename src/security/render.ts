/**
 * Rendering helpers for untrusted values (PLAN §6 "Strona wyniku": URL scheme allowlist, full escaping).
 */

/**
 * Returns a normalised absolute http(s) URL, or null for anything else
 * (javascript:, data:, file:, relative paths, URLs with embedded credentials, control characters).
 */
export function safeUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.length > 2048) return null;
  // Control characters / whitespace inside are a classic scheme-obfuscation trick ("java\tscript:").
  if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null; // "https://gov.pl@evil.example"
  if (u.hostname === "") return null;
  return u.href;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Escapes text for safe insertion into HTML text or a quoted attribute. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]!);
}
