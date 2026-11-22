/** Serwowanie zbudowanego WWW (web-dist/) z fallbackiem SPA dla /, /w/:token, /zrodla, /admin. */
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

const SPA_ROUTES = [/^\/$/, /^\/w\/[^/]+\/?$/, /^\/zrodla\/?$/, /^\/admin(\/.*)?$/];

export function isSpaRoute(path: string): boolean {
  return SPA_ROUTES.some((r) => r.test(path));
}

async function readIfFile(path: string): Promise<Buffer | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

export function createStaticHandler(dir: string): MiddlewareHandler {
  const root = resolve(dir);
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const path = c.req.path;
    if (path.startsWith("/api/")) return next();

    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.text("Nieprawidłowy adres.", 400);
    }
    if (decoded.includes("\0") || decoded.split("/").includes("..")) return c.text("Nie znaleziono.", 404);

    const full = resolve(root, `.${decoded}`);
    if (full !== root && !full.startsWith(root + sep)) return c.text("Nie znaleziono.", 404);

    if (decoded !== "/" && extname(decoded) !== "") {
      const file = await readIfFile(full);
      if (!file) return c.text("Nie znaleziono.", 404);
      const immutable = decoded.startsWith("/assets/");
      return new Response(c.req.method === "HEAD" ? null : new Uint8Array(file), {
        headers: {
          "Content-Type": MIME[extname(decoded).toLowerCase()] ?? "application/octet-stream",
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
        },
      });
    }

    if (isSpaRoute(path)) {
      const index = await readIfFile(resolve(root, "index.html"));
      if (!index) return c.text("Interfejs WWW nie został zbudowany. Uruchom: npm run build", 503);
      return new Response(c.req.method === "HEAD" ? null : new Uint8Array(index), {
        headers: { "Content-Type": MIME[".html"]!, "Cache-Control": "no-cache" },
      });
    }
    return c.text("Nie znaleziono.", 404);
  };
}
