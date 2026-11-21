/**
 * Local copy of the URL allowlist used by the result page (PLAN §6 "Strona wyniku").
 * Kept inside src/web so the browser bundle does not depend on server-side modules.
 * Returns a normalised absolute http(s) URL, or null for anything else
 * (javascript:, data:, file:, relative paths, embedded credentials, control characters).
 */
export function safeUrl(url: unknown): string | null {
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
  if (u.username !== "" || u.password !== "") return null;
  if (u.hostname === "") return null;
  return u.href;
}

/** Same-origin app path (for /w/:token links built from resultUrl). Only "/w/<token>" is accepted. */
export function resultPathFor(token: string | undefined, resultUrl?: string): string | null {
  if (token && /^[A-Za-z0-9_-]{8,128}$/.test(token)) return `/w/${token}`;
  if (resultUrl) {
    try {
      const u = new URL(resultUrl, "http://local.invalid");
      const m = /^\/w\/([A-Za-z0-9_-]{8,128})\/?$/.exec(u.pathname);
      if (m) return `/w/${m[1]}`;
    } catch {
      return null;
    }
  }
  return null;
}
