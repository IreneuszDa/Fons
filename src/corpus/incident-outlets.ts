// A platform host identifies millions of unrelated publishers. Only explicitly
// attributed channel URLs with a stable account path can identify one of them.
const SHARED_PLATFORMS = [
  "facebook.com", "fb.com", "fb.watch", "instagram.com", "tiktok.com", "youtube.com", "youtu.be",
  "x.com", "twitter.com", "t.me", "telegram.me", "telegram.org", "whatsapp.com", "linkedin.com",
  "reddit.com", "threads.net", "threads.com", "bsky.app", "discord.com",
];

export function outletHost(value: string): string | undefined {
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`);
    const host = u.hostname.toLowerCase().replace(/\.$/u, "");
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !host.includes(".")) return;
    if (SHARED_PLATFORMS.some(platform => host === platform || host.endsWith(`.${platform}`))) return;
    return host;
  } catch { return; }
}

/** Match the explicit profile and URLs that identify their owner in the path.
 * A watch URL, share redirect, @mention or name in a query does not identify the owner. */
export function outletChannel(value: string, profileOnly = false): string | undefined {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/u, "");
    if (host === "tiktok.com") {
      const match = /^\/(@[A-Za-z0-9._]{1,24})(\/video\/\d+)?$/.exec(path);
      if (match && !(profileOnly && match[2])) return `https://tiktok.com/${match[1]!.toLowerCase()}`;
    }
    if (host === "youtube.com") {
      const match = /^\/(channel\/UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]+)(\/(?:videos|shorts|streams|posts|featured))?$/.exec(path);
      if (match && !(profileOnly && match[2])) {
        const id = match[1]!;
        return `https://youtube.com/${id.startsWith("@") ? id.toLowerCase() : id}`;
      }
    }
  } catch { /* invalid URL */ }
  return;
}
