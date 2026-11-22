import { beforeAll, afterAll, expect, describe, it } from "vitest";
import { pushIncidentCatalog } from "../../integrations/opencti/push";
import { loadCatalog } from "../corpus/catalog";
import { ensureCorpusLoaded } from "../corpus/store";
import { maskPii } from "../security/pii";
import type { ArchiveMaterial, SavedMaterial } from "../shared/archive";
import { purgeRetention } from "./db";
import { purgeWithdrawnArchives } from "./material-archive";
import { loginAs, makeApiToken, makeEnv } from "./testkit";

describe("Archiwum i eksport analityczny przez HTTP z korpusem projektu", () => {
  const env = makeEnv({ fetch: () => { throw new Error("unexpected_network_request"); } });
  const path = "/api/archives";
  beforeAll(() => {
    ensureCorpusLoaded(env.db);
    env.ctx.corpus.catalog = loadCatalog;
    env.ctx.security.maskPii = maskPii;
  }, 60_000);
  afterAll(() => env.db.close());

  const post = (route: string, body: object, cookie = "") => env.app.request(route, { method: "POST",
    headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  async function list(cookie: string) {
    const response = await env.app.request(path, { headers: { cookie } });
    return await response.json() as {items: SavedMaterial[]};
  }
  async function owner() {
    const res = await env.app.request(path);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function preview(source: string) {
    const { url } = env.db.prepare("SELECT url FROM records WHERE source_id = ? ORDER BY id LIMIT 1").get(source) as { url: string };
    const res = await post(path + "/preview", { url });
    expect(res.status).toBe(200);
    return (await res.json() as {items: ArchiveMaterial[]}).items;
  }
  function selector({ url, recordId, sha256 }: ArchiveMaterial) { return { url, recordId, sha256 }; }

  it("pokazuje licencjonowany fragment bez zapisu, wiąże wybór z treścią i właścicielem", async () => {
    const first = await owner(), second = await owner();
    const items = await preview("eurostat");
    expect(items.length).toBeGreaterThan(1);
    const item = items[0]!;
    expect(item.termsUrl).toMatch(/eurostat\/help\/copyright-notice/);
    expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(item.excerpt.length).toBeLessThanOrEqual(300);
    expect((await list(first)).items).toEqual([]);
    const body = selector(item);
    expect((await post(path, body)).status).toBe(401);
    expect((await post(path, { ...body, excerpt: "dodatkowa treść" }, first)).status).toBe(400);
    expect((await post(path, { ...body, sha256: "0".repeat(64) }, first)).status).toBe(409);
    const saved = (await (await post(path, body, first)).json() as { item: SavedMaterial }).item;
    expect(saved).toMatchObject(item);
    expect((await (await post(path, body, first)).json())).toEqual({ item: saved });
    expect((await list(second)).items).toEqual([]);
    await env.app.request(path + "/" + saved.id, { method: "DELETE", headers: { cookie: second } });
    expect((await list(first)).items).toEqual([saved]);
    await env.app.request(path + "/" + saved.id, { method: "DELETE", headers: { cookie: first } });
    expect((await list(first)).items).toEqual([]);
  });

  it("odrzuca materiał bez kwalifikacji, prywatne adresy i cofniętą zgodę katalogu", async () => {
    expect(await preview("demagog")).toEqual([]);
    const gus = (await preview("gus-bdl"))[0]!;
    expect(gus.termsUrl).toMatch(/bip.stat.gov.pl/);
    const unknown = await post(path + "/preview", { url: gus.url + "&token=my-private-value" });
    expect(await unknown.json()).toEqual({ items: [] });
    expect(env.logs.join(" ")).not.toContain("my-private-value");
    const cookie = await owner();
    env.ctx.corpus.catalog = () => loadCatalog().map(s => ({ ...s, archivePolicy: undefined }));
    try {
      expect((await post(path, selector(gus), cookie)).status).toBe(409);
    } finally { env.ctx.corpus.catalog = loadCatalog; }
  });

  it("ukrywa zapis dokładnie po 7 dniach, fizycznie usuwa przy retencji i wykonuje usuń moje dane", async () => {
    const first = await owner(), second = await owner();
    const body = selector((await preview("gus-bdl"))[0]!);
    await post(path, body, first);
    await post(path, body, second);
    const deleted = await env.app.request("/api/session", { method: "DELETE", headers: { cookie: second } });
    expect(await deleted.json()).toMatchObject({ deleted: { archives: 1 } });
    expect((await list(first)).items).toHaveLength(1);
    env.advance(7 * 86_400_000);
    expect((await list(first)).items).toEqual([]);
    expect(purgeRetention(env.db, env.ctx.now()).archives).toBe(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM material_archives").get()).toEqual({ n: 0 });
  });

  it("cofa podgląd i dostęp do kopii, gdy zmienią się warunki lub zakres ścieżek źródła", async () => {
    const first = await owner(), second = await owner();
    const gus = (await preview("gus-bdl"))[0]!;
    const args = selector(gus);
    await post(path, args, first);
    await post(path, args, second);
    const changeLicence = env.db.prepare("UPDATE records SET licence = ? WHERE id = ?");
    try {
      changeLicence.run("Nowe warunki", gus.recordId);
      env.ctx.corpus.catalog = () => loadCatalog().map(s => s.id === "gus-bdl" ? { ...s, licence: "Nowe warunki" } : s);
      expect((await post(path, args, first)).status).toBe(409);
      expect((await list(first)).items).toEqual([]);
      expect(purgeWithdrawnArchives(env.ctx)).toBe(1);
      const renewed = (await preview("gus-bdl")).find(item => item.recordId === gus.recordId)!;
      expect(renewed.sha256).not.toBe(gus.sha256);
      expect((await post(path, selector(renewed), first)).status).toBe(200);
      env.ctx.corpus.catalog = () => loadCatalog().map(s => s.id === "gus-bdl" ? { ...s, licence: "Nowe warunki", pathPrefixes: ["/inna-czesc/"] } : s);
      expect((await (await post(path + "/preview", { url: gus.url })).json())).toEqual({ items: [] });
      expect((await list(first)).items).toEqual([]);
    } finally {
      env.ctx.corpus.catalog = loadCatalog;
      changeLicence.run(gus.licence!, gus.recordId);
    }
  });

  it("zachowuje kopię po aktualizacji wartości i potrafi odczytać zapis sprzed wprowadzenia pola licencji", async () => {
    const cookie = await owner(), gus = (await preview("gus-bdl"))[0]!;
    const saved = (await (await post(path, selector(gus), cookie)).json() as { item: SavedMaterial }).item;
    const update = env.db.prepare("UPDATE records SET text = ? WHERE id = ?");
    try {
      update.run("Nowa wartość opublikowana przez GUS.", gus.recordId);
      expect((await list(cookie)).items).toEqual([saved]);
      env.db.prepare("UPDATE material_archives SET material_json = json_remove(material_json, '$.licence') WHERE id = ?").run(saved.id);
      expect((await list(cookie)).items[0]?.excerpt).toBe(gus.excerpt);
    } finally {
      update.run(gus.excerpt, gus.recordId);
      await env.app.request(path + "/" + saved.id, { method: "DELETE", headers: { cookie } });
    }
  });

  it("eksportuje przez uprawnienie analityka publiczne URL-e i udokumentowane przypisanie DISARM", async () => {
    const route = "/api/admin/export.json?dataset=stix";
    expect((await env.app.request(route)).status).toBe(401);
    const mod = await loginAs(env, "moderator");
    expect((await env.app.request(route, { headers: { cookie: mod.cookie } })).status).toBe(403);
    const headers = { authorization: "Bearer " + makeApiToken(env) };
    const res = await env.app.request(route, { headers });
    expect(res.headers.get("content-disposition")).toContain("fons-stix-2.1.json");
    const bundle = await res.json() as { type: string; id: string; objects: { type: string; spec_version: string; id: string; value?: string; object_refs?: string[]; external_references?: object[] }[] };
    expect(bundle.type).toBe("bundle");
    expect(bundle.objects.length).toBeGreaterThan(100);
    expect(bundle.objects.every(o => o.spec_version === "2.1")).toBe(true);
    const ids = new Set(bundle.objects.map(o => o.id));
    expect(ids.size).toBe(bundle.objects.length);
    const note = bundle.objects.find(o => o.external_references?.some(ref => 'external_id' in ref && ref.external_id === 'T0143.003'));
    expect(note).toBeDefined();
    // Independently reproduced with the OASIS stix2 Python library.
    expect(note!.object_refs).toEqual(["url--498e0d07-2e88-5570-a56d-210f513a1993"]);
    expect(bundle.objects.find(o => o.id === note!.object_refs![0])?.value).toMatch(/^https:\/\/pravda\.org\.pl\//);
    expect(bundle.objects.some(o => o.type === "indicator")).toBe(false);
    const again = await (await env.app.request(route, { headers })).json() as typeof bundle;
    expect(again.objects).toEqual(bundle.objects);
    expect(again.id).not.toBe(bundle.id);
  });

  it("eksportuje wszystkie sprawy do CSV i JSON także po przekroczeniu limitu listy panelu", async () => {
    const ins = env.db.prepare("INSERT INTO moderator_cases (representative_text, claim_norm, created_at, updated_at) VALUES (?,?,?,?)");
    const date = env.ctx.now().toISOString();
    env.db.transaction(() => {
      for (let i = 1; i <= 501; i++) ins.run("Sprawa " + i, "sprawa " + i, date, date);
    })();
    const headers = { authorization: "Bearer " + makeApiToken(env) };
    const json = await (await env.app.request("/api/admin/export.json", { headers })).json() as { cases: unknown[] };
    const csv = await (await env.app.request("/api/admin/export.csv", { headers })).text();
    expect(json.cases).toHaveLength(501);
    expect(csv.trim().split(/\r?\n/)).toHaveLength(502);
    expect((await env.app.request("/api/admin/export.json?dataset=stxi", { headers })).status).toBe(400);
    expect((await env.app.request("/api/admin/export.csv?dataset=stix", { headers })).status).toBe(400);
  });

  it("pobiera autoryzowany STIX i oczekuje na rozliczenie obiektów przez TAXII Push", async () => {
    const options = { fonsBaseUrl: "https://fons.test", fonsToken: makeApiToken(env), openctiToken: "test-receiver",
      collectionUrl: "https://opencti.test/cti/taxii2/root/collections/fons/objects/" };
    let total = 0, posts = 0, failed = 0;
    const send: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      expect(req.redirect).toBe("error");
      if (req.url.startsWith(options.fonsBaseUrl)) {
        expect(req.headers.get("authorization")).toBe("Bearer " + options.fonsToken);
        return env.app.request(req);
      }
      expect(req.headers.get("authorization")).toBe("Bearer " + options.openctiToken);
      if (req.method === "POST") {
        posts++;
        expect(req.url).toBe(options.collectionUrl);
        expect(req.headers.get("content-type")).toBe("application/taxii+json;version=2.1");
        const body = await req.json() as { objects: { type: string }[] };
        expect(Object.keys(body)).toEqual(["objects"]);
        expect(body.objects.some(o => o.type === "note")).toBe(true);
        total = body.objects.length;
        return Response.json({ id: "work-123", status: "pending", pending_count: total });
      }
      expect(req.url).toBe("https://opencti.test/cti/taxii2/root/status/work-123/");
      return Response.json({ id: "work-123", status: "complete", total_count: total, success_count: total - failed,
        failure_count: failed, pending_count: 0 });
    };
    expect(await pushIncidentCatalog(options, send, async () => {})).toBe(total);
    expect(total).toBeGreaterThan(100);
    failed = 1;
    await expect(pushIncidentCatalog(options, send, async () => {})).rejects.toThrow(/wszystkich obiektów/);
    expect(posts).toBe(2);
    await expect(pushIncidentCatalog(options, async () => Response.json({ cases: [] }))).rejects.toThrow(/pakiet/);
  });
});
