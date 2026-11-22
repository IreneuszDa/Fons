/** Tiny history-API router (no dependencies): route matching, navigation and same-origin link interception. */
import { useEffect, useState } from "react";

export type Route =
  | { name: "chat" }
  | { name: "phone" }
  | { name: "result"; token: string }
  | { name: "sources" }
  | { name: "admin" }
  | { name: "notfound" };

export function matchRoute(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "/" || p === "") return { name: "chat" };
  if (p === "/telefon") return { name: "phone" };
  if (p === "/zrodla") return { name: "sources" };
  if (p === "/admin") return { name: "admin" };
  const m = /^\/w\/([^/]+)$/.exec(p);
  if (m && m[1]) {
    let token: string;
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      return { name: "notfound" };
    }
    return { name: "result", token };
  }
  return { name: "notfound" };
}

/** Paths the client router owns (everything else, e.g. /api/*, goes to the browser). */
export function isAppPath(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname === "/api") return false;
  return matchRoute(pathname).name !== "notfound";
}

const listeners = new Set<() => void>();

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const l of listeners) l();
  window.scrollTo?.(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/**
 * Decides whether a click on an anchor should be handled client-side.
 * Exported for unit tests (no DOM needed).
 */
export function shouldIntercept(
  ev: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean },
  anchor: { href: string; target: string; hasDownload: boolean },
  origin: string,
): string | null {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
  if (anchor.hasDownload || (anchor.target && anchor.target !== "_self")) return null;
  let u: URL;
  try {
    u = new URL(anchor.href, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || !isAppPath(u.pathname)) return null;
  return u.pathname + u.search + u.hash;
}

/** Installs one document-level click handler so plain <a href="/zrodla"> links (Astryx Link, TopNavItem) stay in the SPA. */
export function installLinkInterception(): () => void {
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!el) return;
    const to = shouldIntercept(
      e,
      { href: el.getAttribute("href") ?? "", target: el.target, hasDownload: el.hasAttribute("download") },
      window.location.origin,
    );
    if (!to) return;
    e.preventDefault();
    navigate(to);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
