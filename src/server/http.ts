import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import ipaddr from "ipaddr.js";
import type { ServerContext } from "./context";

/** Adres klienta: za zaufanym proxy (TRUST_PROXY=on) ostatni wpis X-Forwarded-For, inaczej adres połączenia. */
export function clientIp(c: Context, ctx: ServerContext): string {
  if (ctx.cfg.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    /* brak informacji o połączeniu (np. testy) */
  }
  return "unknown";
}

export const GENERIC_ERROR_PL = "Coś poszło nie tak po naszej stronie. Spróbuj ponownie za chwilę.";

/**
 * Klucz klienta do limitów: IPv4 bez zmian (także zapis IPv4-mapped „::ffff:a.b.c.d”), IPv6 przycięte do sieci /64
 * (jeden abonent dostaje zwykle całą /64 — inaczej miałby 2^64 osobnych limitów). Nieparsowalny adres bez zmian.
 */
export function clientKey(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  try {
    let addr = ipaddr.parse(raw);
    if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    if (addr.kind() === "ipv4") return addr.toString();
    const parts = (addr as ipaddr.IPv6).parts.slice(0, 4).map((p) => p.toString(16));
    return `${parts.join(":")}::/64`;
  } catch {
    return ip;
  }
}
