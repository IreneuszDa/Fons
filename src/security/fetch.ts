/**
 * URL fetching with SSRF protection (PLAN §6 "URL").
 *
 *  - only http/https, only ports 80/443;
 *  - every hostname is resolved inside the socket's own `lookup` (undici Agent → net/tls.connect),
 *    every resolved address is checked, and the socket connects to exactly the checked address —
 *    no DNS-rebinding gap between "check" and "connect";
 *  - literal IPs (incl. decimal/hex/octal forms, which WHATWG URL normalises) are checked before connecting;
 *  - ≤ 3 redirects, each re-validated from scratch;
 *  - ≤ 5 MB counted while streaming, after decompression (gzip/deflate/br);
 *  - overall timeout (default 6 s) covering connect, headers and body;
 *  - text/html, application/xhtml+xml, text/plain only.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readable, type Transform } from "node:stream";
import ipaddr from "ipaddr.js";
import { Agent, request, type Dispatcher } from "undici";
import { extractFromHtml, extractFromPlainText } from "./extract";

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  /** Raw HTML (for the detector — BEFORE cleaning). */
  rawHtml?: string;
  /** Text including hidden elements (for the detector). */
  rawText: string;
  /** Readable content (Readability), without hidden HTML and zero-width characters. */
  cleanText: string;
  title?: string;
  publishedAt?: string;
  /** Hidden content (display:none, aria-hidden, white-on-white, comments, meta …). */
  hiddenSegments: string[];
}

export type FetchBlockedReason =
  | "scheme"
  | "port"
  | "private_ip"
  | "too_large"
  | "redirects"
  | "timeout"
  | "content_type"
  | "http_error";

/** Polish, plain-language messages for each reason (safe to show to users). */
export const FETCH_BLOCKED_MESSAGE_PL: Record<FetchBlockedReason, string> = {
  scheme: "Ten link nie jest adresem strony internetowej (http lub https), więc go nie otwieramy.",
  port: "Ten link prowadzi do nietypowego miejsca na serwerze, więc go nie otwieramy.",
  private_ip: "Ten link prowadzi do sieci wewnętrznej, a nie do publicznej strony, więc go nie otwieramy.",
  too_large: "Ta strona jest za duża, żeby ją sprawdzić. Wklej sam tekst wiadomości.",
  redirects: "Ten link przekierowuje zbyt wiele razy, więc go nie otwieramy.",
  timeout: "Strona odpowiadała zbyt długo. Spróbuj później albo wklej sam tekst.",
  content_type: "Pod tym linkiem nie ma zwykłej strony z tekstem (np. jest plik lub obraz). Wklej sam tekst.",
  http_error: "Nie udało się otworzyć tej strony (serwer zwrócił błąd). Sprawdź link albo wklej sam tekst.",
};

export class FetchBlockedError extends Error {
  readonly reason: FetchBlockedReason;
  /** Message safe for users (Polish). */
  readonly userMessagePl: string;
  constructor(reason: FetchBlockedReason, detail?: string, readonly httpStatus?: number) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "FetchBlockedError";
    this.reason = reason;
    this.userMessagePl = FETCH_BLOCKED_MESSAGE_PL[reason];
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /**
   * Also accept `application/json` (public data APIs of catalogue sources, e.g. MSZ Odyseusz). The body is returned
   * verbatim in `rawText` / `cleanText`; all other protections (SSRF, redirects, size, timeout) are unchanged.
   */
  acceptJson?: boolean;
  /**
   * TEST HOOKS — do not use in production code.
   * `resolver` replaces DNS; `isIpAllowed` replaces the public-address policy;
   * `allowedPorts` replaces [80, 443].
   */
  resolver?: Resolver;
  isIpAllowed?: (ip: string) => boolean;
  allowedPorts?: number[];
}

export const USER_AGENT = "FonsBot/0.1 (prototyp hackathonowy)";
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ACCEPTED_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

// ─────────────────────────── IP policy ───────────────────────────

/**
 * True only for globally routable unicast addresses. Blocks loopback, RFC1918, link-local
 * (169.254/16 incl. cloud metadata), CGNAT 100.64/10, multicast, broadcast, 0.0.0.0/8, reserved,
 * benchmarking, IPv6 loopback/ULA/link-local/multicast, and IPv4 embedded in IPv6
 * (IPv4-mapped, NAT64, 6to4, Teredo) unless the embedded IPv4 itself is public.
 */
export function isPublicIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // ipaddr.parse accepts only canonical forms here because callers pass resolved / URL-normalised addresses;
    // anything unparsable is treated as not public.
    addr = ipaddr.parse(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicIp(v6.toIPv4Address().toString());
    // IPv4-compatible (::a.b.c.d, ::/96, przestarzałe) — na starszych stosach trafia do IPv4 (np. ::7f00:1 = loopback).
    if (v6.parts.slice(0, 6).every((p) => p === 0)) return false;
    // Lokalny NAT64 (RFC 8215, 64:ff9b:1::/48) — nigdy publiczny.
    if (v6.parts[0] === 0x64 && v6.parts[1] === 0xff9b && v6.parts[2] === 1) return false;
    return v6.range() === "unicast";
  }
  return (addr as ipaddr.IPv4).range() === "unicast";
}

function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

/** `lookup` for net/tls.connect: resolves, rejects if ANY address is non-public, returns only checked addresses. */
function makeGuardedLookup(resolver: Resolver, allowed: (ip: string) => boolean) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb) => {
    const opts = typeof options === "object" && options !== null ? options : {};
    resolver(hostname)
      .then((addrs) => {
        if (addrs.length === 0) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        // Reject when any record is private: an attacker could otherwise mix public and private answers.
        for (const a of addrs) {
          if (!allowed(a.address)) throw new FetchBlockedError("private_ip", `${hostname} → ${a.address}`);
        }
        let list = addrs;
        if (opts.family === 4 || opts.family === 6) {
          const f = list.filter((a) => a.family === opts.family);
          if (f.length > 0) list = f;
        }
        if (opts.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => cb(err));
  };
}

// ─────────────────────────── URL validation ───────────────────────────

function validateUrl(raw: string, allowedPorts: number[], allowed: (ip: string) => boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError("scheme", "invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchBlockedError("scheme", u.protocol);
  if (u.username || u.password) throw new FetchBlockedError("scheme", "credentials in URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new FetchBlockedError("scheme", "no host");
  if (isIP(host)) {
    // WHATWG URL already turned 2130706433 / 0x7f.1 / 0177.0.0.1 / 127.1 into dotted-quad form.
    if (!allowed(host)) throw new FetchBlockedError("private_ip", host);
  } else {
    const h = host.toLowerCase().replace(/\.$/, "");
    // Single-label names resolve via search domains / mDNS to internal hosts; these suffixes are internal by definition.
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes("."))
      throw new FetchBlockedError("private_ip", h);
  }
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  if (!allowedPorts.includes(port)) throw new FetchBlockedError("port", String(port));
  return u;
}

// ─────────────────────────── body reading ───────────────────────────

/** Drops a response body without leaving an unhandled 'error' event behind. */
function discard(body: Readable) {
  body.on("error", () => {});
  body.destroy();
}

function findBlocked(err: unknown): FetchBlockedError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof FetchBlockedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function decoderFor(encoding: string | undefined): Transform | null {
  const e = (encoding ?? "").trim().toLowerCase();
  if (e === "" || e === "identity") return null;
  if (e === "gzip" || e === "x-gzip") return createGunzip();
  if (e === "deflate") return createInflate();
  if (e === "br") return createBrotliDecompress();
  throw new FetchBlockedError("content_type", `unsupported content-encoding ${e}`);
}

async function readLimited(body: Readable, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  const dec = decoderFor(encoding);
  const stream: Readable = dec ? body.pipe(dec) : body;
  if (dec) body.on("error", (e) => dec.destroy(e));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      total += b.length;
      if (total > maxBytes) throw new FetchBlockedError("too_large", `> ${maxBytes} bytes`);
      chunks.push(b);
    }
  } catch (e) {
    discard(body);
    if (dec) discard(dec);
    throw e;
  }
  return Buffer.concat(chunks);
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head.subarray(0, 4096).toString("latin1"))?.[1];
  const cs = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  try {
    new TextDecoder(cs);
    return cs;
  } catch {
    return "utf-8";
  }
}

// ─────────────────────────── main ───────────────────────────

interface ResourceOptions extends FetchOptions {
  mimeTypes: readonly string[];
  accept?: string;
  /** A fixed provider API may receive JSON with a credential. Never redirect that request. */
  postJson?: { body: object; headers: Record<string, string> };
  /** Checked before the initial request and every redirect, in addition to the public IP policy. */
  allowUrl?: (url: URL) => boolean;
}

/** Bounded bytes from a public URL. All consumers share the socket-pinned address policy. */
export async function fetchPublicResource(url: string, opts: ResourceOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowedPorts = opts.allowedPorts ?? [80, 443];
  const allowed = opts.isIpAllowed ?? isPublicIp;
  const resolver = opts.resolver ?? defaultResolver;

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(new FetchBlockedError("timeout", `${timeoutMs} ms`)), timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutCtl.signal]) : timeoutCtl.signal;

  const agent = new Agent({
    connect: { lookup: makeGuardedLookup(resolver, allowed) as never, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxResponseSize: -1,
  });

  try {
    let current = validateUrl(url, allowedPorts, allowed);
    for (let redirects = 0; ; redirects++) {
      if (opts.allowUrl && !opts.allowUrl(current)) throw new FetchBlockedError("scheme", "unexpected origin");
      let res: Dispatcher.ResponseData;
      try {
        res = await request(current, {
          method: opts.postJson ? "POST" : "GET",
          dispatcher: agent,
          signal,
          ...(opts.postJson ? { body: JSON.stringify(opts.postJson.body) } : {}),
          headers: {
            "user-agent": USER_AGENT,
            accept: opts.accept ?? opts.mimeTypes.join(","),
            "accept-encoding": "gzip, deflate, br",
            "accept-language": "pl,en;q=0.7",
            ...(opts.postJson ? { "content-type": "application/json", ...opts.postJson.headers } : {}),
          },
        });
      } catch (err) {
        throw findBlocked(err) ?? (timeoutCtl.signal.aborted ? new FetchBlockedError("timeout") : err);
      }

      const status = res.statusCode;
      if (status >= 300 && status < 400 && status !== 304) {
        const loc = res.headers.location;
        discard(res.body);
        if (opts.postJson) throw new FetchBlockedError("redirects", "provider POST");
        const location = Array.isArray(loc) ? loc[0] : loc;
        if (!location) throw new FetchBlockedError("http_error", `redirect without location (${status})`);
        if (redirects >= MAX_REDIRECTS) throw new FetchBlockedError("redirects", `> ${MAX_REDIRECTS}`);
        current = validateUrl(new URL(location, current).href, allowedPorts, allowed);
        continue;
      }
      if (status < 200 || status >= 300) {
        discard(res.body);
        throw new FetchBlockedError("http_error", String(status), status);
      }

      const ctHeader = res.headers["content-type"];
      const contentType = (Array.isArray(ctHeader) ? ctHeader[0] : ctHeader) ?? "";
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      if (!opts.mimeTypes.includes(mime)) {
        discard(res.body);
        throw new FetchBlockedError("content_type", mime || "missing");
      }
      const lenHeader = res.headers["content-length"];
      const declared = Number(Array.isArray(lenHeader) ? lenHeader[0] : lenHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(res.body);
        throw new FetchBlockedError("too_large", `content-length ${declared}`);
      }

      const encHeader = res.headers["content-encoding"];
      let buf: Buffer;
      try {
        buf = await readLimited(res.body, Array.isArray(encHeader) ? encHeader[0] : encHeader, maxBytes);
      } catch (err) {
        throw findBlocked(err) ?? (timeoutCtl.signal.aborted ? new FetchBlockedError("timeout") : err);
      }
      return { finalUrl: current.href, status, contentType, mime, bytes: buf };
    }
  } catch (err) {
    const blocked = findBlocked(err);
    if (blocked) throw blocked;
    if (timeoutCtl.signal.aborted && !(opts.signal?.aborted ?? false)) throw new FetchBlockedError("timeout");
    throw err;
  } finally {
    clearTimeout(timer);
    agent.destroy().catch(() => {});
  }
}

/** Fetch a public page and extract its text. Binary files are never accepted as text. */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const mimeTypes = opts.acceptJson ? ["application/json", ...ACCEPTED_TYPES] : ACCEPTED_TYPES;
  const accept = opts.acceptJson ? "application/json,text/html;q=0.9,text/plain;q=0.8" : "text/html,application/xhtml+xml,text/plain;q=0.9";
  const { finalUrl, status, contentType, mime, bytes } = await fetchPublicResource(url, { ...opts, mimeTypes, accept });
  const text = new TextDecoder(charsetOf(contentType, bytes)).decode(bytes);
  if (mime === "application/json") return { finalUrl, status, contentType, rawText: text, cleanText: text, hiddenSegments: [] };
  if (mime === "text/plain") return { finalUrl, status, contentType, ...extractFromPlainText(text) };
  return { finalUrl, status, contentType, rawHtml: text, ...extractFromHtml(text, finalUrl) };
}
