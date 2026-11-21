import { createHmac, randomBytes } from "node:crypto";

const TTL_MS = 15 * 60_000;
const MAX_LINKS_PER_SESSION = 12;
const MAX_SESSIONS = 256;

interface PrivateLink {
  url: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/** The model can name an article without seeing the query string needed to fetch it. */
export class ConversationLinks {
  private readonly key = randomBytes(32);
  private readonly sessions = new Map<string, Map<string, PrivateLink>>();

  constructor(private readonly now: () => Date) {}

  remember(sessionId: string, visible: string, url: string): string {
    let links = this.sessions.get(sessionId);
    if (!links) {
      if (this.sessions.size >= MAX_SESSIONS) this.forget(this.sessions.keys().next().value!);
      links = new Map();
      this.sessions.set(sessionId, links);
    }
    const now = this.now().getTime();
    const id = createHmac("sha256", this.key).update(JSON.stringify([sessionId, url])).digest("base64url").slice(0, 16);
    const label = visible + id;
    for (const [existingLabel, entry] of links) {
      if (entry.expiresAt <= now) {
        clearTimeout(entry.timer);
        links.delete(existingLabel);
      } else if (existingLabel === label) return label;
    }
    if (links.size >= MAX_LINKS_PER_SESSION) {
      const oldest = links.keys().next().value!;
      clearTimeout(links.get(oldest)!.timer);
      links.delete(oldest);
    }
    const timer = setTimeout(() => this.drop(sessionId, label), TTL_MS).unref();
    links.set(label, { url, expiresAt: now + TTL_MS, timer });
    return label;
  }

  resolve(sessionId: string, label: string): string | undefined {
    const entry = this.sessions.get(sessionId)?.get(label);
    if (!entry) return undefined;
    if (entry.expiresAt > this.now().getTime()) return entry.url;
    this.drop(sessionId, label);
    return undefined;
  }

  forget(sessionId: string): void {
    for (const entry of this.sessions.get(sessionId)?.values() ?? []) clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
  }

  private drop(sessionId: string, label: string): void {
    const links = this.sessions.get(sessionId);
    const entry = links?.get(label);
    if (!links || !entry) return;
    clearTimeout(entry.timer);
    links.delete(label);
    if (!links.size) this.sessions.delete(sessionId);
  }
}
