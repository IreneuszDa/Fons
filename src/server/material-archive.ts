import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { pathMatchesPrefixes } from "../corpus/catalog";
import type { ArchiveMaterial, SavedMaterial } from "../shared/archive";
import type { CatalogSource } from "../shared/contracts";
import type { ServerContext } from "./context";
import { clientIp, clientKey } from "./http";
import { newChatOwner } from "./web-chats";

const WEEK_MS = 7 * 86_400_000;
const MAX_SAVED = 24;
const previewInput = z.object({ url: z.string().trim().url().max(2048) }).strict();
const saveInput = previewInput.extend({ recordId: z.string().min(1).max(160), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const POLICIES = {
  eurostat: {
    host: "ec.europa.eu",
    path: /^\/eurostat\/api\/dissemination\/statistics\/1\.0\/data\/(?:migr_asytpsm|migr_asyappctza|prc_hicp_manr|prc_hicp_aind|demo_pjan|une_rt_a|une_rt_m|nrg_ind_id|gov_10a_exp|nrg_ind_ren|nrg_ti_gas)$/,
    termsUrl: "https://ec.europa.eu/eurostat/help/copyright-notice",
    attribution: "Fons opracował opis na podstawie danych Eurostatu. Za opracowanie odpowiada Fons.",
  },
  "gus-bdl": {
    host: "bdl.stat.gov.pl",
    path: /^\/api\/v1\/data\/by-variable\/[0-9]+$/,
    termsUrl: "https://bip.stat.gov.pl/kontakt/ponowne-wykorzystywanie-informacji-sektora-publicznego/",
    attribution: "Fons opracował opis na podstawie danych Banku Danych Lokalnych GUS. Za opracowanie odpowiada Fons.",
  },
};

function archiveSource(catalog: CatalogSource[], url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  const source = catalog.find(s => s.archivePolicy === "aggregate-statistics-v1" && s.fetchMethod === "api"
    && s.role === "tresc" && s.hosts.includes(url.hostname) && pathMatchesPrefixes(s, url.pathname));
  if (!source || (source.id !== "eurostat" && source.id !== "gus-bdl")) return;
  const policy = POLICIES[source.id];
  if (policy.host !== url.hostname || !policy.path.test(url.pathname)) return;
  if (source.id === "eurostat") {
    const geos = url.searchParams.getAll("geo");
    if (!geos.length || !geos.every(geo => ["EU27_2020", "PL", "DE"].includes(geo))) return;
  } else if (url.searchParams.getAll("unit-level").join(",") !== "0") return;
  return { source, policy };
}

/** User URLs are selectors for local snapshots. This operation never downloads a page. */
function candidates(ctx: ServerContext, rawUrl: string): ArchiveMaterial[] {
  const url = new URL(rawUrl);
  const allowed = archiveSource(ctx.corpus.catalog(), url);
  if (!allowed) return [];
  const { source, policy } = allowed;
  const rows = ctx.db.prepare(`SELECT id AS recordId, title, text AS excerpt, url, publisher,
    published_at AS publishedAt, fetched_at AS fetchedAt FROM records
    WHERE source_id = ? AND url = ? AND licence = ? AND origin = 'corpus' AND role = 'tresc'
    AND length(text) BETWEEN 1 AND 300 AND EXISTS (SELECT 1 FROM json_each(topics_json) WHERE value = 'generated-from-data')
    ORDER BY period DESC, id`).all(source.id, url.href, source.licence) as Omit<ArchiveMaterial, "termsUrl" | "attribution" | "sha256">[];
  return rows.filter(row => !ctx.security.maskPii([row.title, row.excerpt].join(" ")).masked).map(row => {
    const material = { ...row, termsUrl: policy.termsUrl, attribution: policy.attribution, licence: source.licence };
    return { ...material, sha256: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
  });
}

interface ArchiveRow { id: string; material_json: string; created_at: string; expires_at: string }
const unpack = (row: ArchiveRow): SavedMaterial => ({ ...JSON.parse(row.material_json) as ArchiveMaterial,
  id: row.id, savedAt: row.created_at, expiresAt: row.expires_at });
type Owner = ReturnType<typeof newChatOwner>;

/** Apply withdrawals also to saved material. Existing snapshots keep their data when only the statistics change. */
export function purgeWithdrawnArchives(ctx: ServerContext, senderId?: string): number {
  const catalog = ctx.corpus.catalog();
  return ctx.db.transaction(() => {
    const columns = "SELECT id, json_extract(material_json, '$.url') AS url, json_extract(material_json, '$.licence') AS licence, json_extract(material_json, '$.recordId') AS recordId FROM material_archives";
    const rows = (senderId === undefined ? ctx.db.prepare(columns).all() : ctx.db.prepare(columns + " WHERE sender_id = ?").all(senderId)) as
      { id: string; url: string; licence: string | null; recordId: string }[];
    const remove = ctx.db.prepare("DELETE FROM material_archives WHERE id = ?");
    let count = 0;
    for (const row of rows) {
      const allowed = archiveSource(catalog, new URL(row.url));
      const licence = row.licence ?? (allowed && (ctx.db.prepare("SELECT licence FROM records WHERE id = ? AND url = ? AND source_id = ? AND origin = 'corpus'")
        .get(row.recordId, row.url, allowed.source.id) as { licence: string } | undefined)?.licence);
      if (!allowed || licence !== allowed.source.licence) count += remove.run(row.id).changes;
    }
    return count;
  })();
}

export function archiveRoutes(ctx: ServerContext, ownerFrom: (c: Context) => Owner | undefined,
  remember: (c: Context, cookie: string) => void,
  reject: (c: Context, ctx: ServerContext, opts: { requireJson: boolean }) => Response | undefined) {
  const api = new Hono();
  api.use("*", async (c, next) => {
    const rejected = reject(c, ctx, { requireJson: c.req.method === "POST" });
    if (rejected) return rejected;
    if (!ctx.limiters.ip.check("archive:" + clientKey(clientIp(c, ctx)))) {
      c.header("Retry-After", "60");
      return c.json({ messagePl: "Zbyt wiele żądań. Spróbuj ponownie za minutę." }, 429);
    }
    await next();
  });
  api.get("/", c => {
    const owner = ownerFrom(c) ?? newChatOwner(ctx);
    remember(c, owner.cookie);
    purgeWithdrawnArchives(ctx, owner.senderId);
    const rows = ctx.db.prepare("SELECT * FROM material_archives WHERE sender_id = ? AND expires_at > ? ORDER BY created_at DESC, id")
      .all(owner.senderId, ctx.now().toISOString()) as ArchiveRow[];
    return c.json({ items: rows.map(unpack) });
  });
  api.post("/preview", async c => {
    const input = previewInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ messagePl: "Podaj pełny adres URL materiału." }, 400);
    const items = candidates(ctx, input.data.url);
    return c.json({ items });
  });
  api.post("/", async c => {
    const input = saveInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ messagePl: "Wybierz fragment z podglądu." }, 400);
    const owner = ownerFrom(c);
    if (!owner) return c.json({ messagePl: "Otwórz archiwum w tej przeglądarce i włącz ciasteczka." }, 401);
    const item = candidates(ctx, input.data.url).find(r => r.recordId === input.data.recordId && r.sha256 === input.data.sha256);
    if (!item) return c.json({ messagePl: "Materiał lub zasady źródła zmieniły się. Wczytaj ponownie podgląd." }, 409);
    const now = ctx.now();
    const saved = ctx.db.transaction(() => {
      ctx.db.prepare("DELETE FROM material_archives WHERE sender_id = ? AND expires_at <= ?").run(owner.senderId, now.toISOString());
      const existing = ctx.db.prepare("SELECT * FROM material_archives WHERE sender_id = ? AND sha256 = ?").get(owner.senderId, item.sha256) as ArchiveRow | undefined;
      if (existing) return unpack(existing);
      const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM material_archives WHERE sender_id = ?").get(owner.senderId) as { n: number };
      if (n >= MAX_SAVED) return null;
      const row = { id: randomUUID(), created_at: now.toISOString(), expires_at: new Date(now.getTime() + WEEK_MS).toISOString(), material_json: JSON.stringify(item) };
      ctx.db.prepare("INSERT INTO material_archives (id, created_at, expires_at, material_json, sha256, sender_id) VALUES (@id, @created_at, @expires_at, @material_json, @sha256, @sender)")
        .run({ ...row, sha256: item.sha256, sender: owner.senderId });
      return unpack(row);
    }).immediate();
    if (!saved) return c.json({ messagePl: "Archiwum mieści 24 fragmenty. Usuń wybrany zapis, aby dodać kolejny." }, 409);
    remember(c, owner.cookie);
    return c.json({ item: saved });
  });
  api.delete("/:id", c => {
    const owner = ownerFrom(c);
    if (owner) ctx.db.prepare("DELETE FROM material_archives WHERE id = ? AND sender_id = ?").run(c.req.param("id"), owner.senderId);
    return c.json({ ok: true });
  });
  return api;
}
