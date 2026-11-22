import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const taxiiMime = "application/taxii+json;version=2.1";
const stix = z.object({ id: z.string().min(1), spec_version: z.literal("2.1") });
const reference = z.object({ source_name: z.string(), url: z.string().url(), external_id: z.string().optional() }).strict();
// A different Fons dataset must never be forwarded, even when its HTTP request succeeds.
const catalogBundle = z.object({
  type: z.literal("bundle"), id: z.string().startsWith("bundle--"),
  objects: z.array(z.discriminatedUnion("type", [
    stix.extend({ type: z.literal("url"), value: z.string().url() }).strict(),
    stix.extend({ type: z.literal("note"), created: z.string(), modified: z.string(), lang: z.string(),
      authors: z.array(z.string()), content: z.string(), object_refs: z.array(z.string()), external_references: z.array(reference) }).strict(),
  ])).optional(),
});
const receipt = z.object({
  id: z.string().regex(/^[\w-][\w.:-]{0,255}$/),
  status: z.enum(["pending", "complete"]),
});
const completed = receipt.extend({
  total_count: z.number().int().nonnegative(), success_count: z.number().int().nonnegative(),
  pending_count: z.literal(0), failure_count: z.literal(0),
});

function serviceUrl(value: string, name: string): URL {
  const url = URL.parse(value);
  const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) throw new Error("Niepoprawny adres " + name + ".");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

interface Options {
  fonsBaseUrl: string;
  fonsToken: string;
  collectionUrl: string;
  openctiToken: string;
  onAccepted?: (statusUrl: URL) => void;
}

export async function pushIncidentCatalog(opts: Options, request: typeof fetch = fetch, pause = () => delay(2000)): Promise<number> {
  const fons = serviceUrl(opts.fonsBaseUrl, "Fons");
  const collection = serviceUrl(opts.collectionUrl, "kolekcji OpenCTI");
  if (!/\/taxii2\/root\/collections\/[\w-]+\/objects\/$/.test(collection.pathname)) throw new Error("Podaj adres objects kolekcji TAXII Push w OpenCTI.");
  if (!opts.fonsToken.trim() || !opts.openctiToken.trim()) throw new Error("Brakuje tokena dostępu Fons lub OpenCTI.");

  async function readJson(url: URL, name: string, init: RequestInit) {
    const res = await request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(name + " zwrócił HTTP " + res.status + ".");
    return res.json() as Promise<unknown>;
  }

  const data = await readJson(new URL("api/admin/export.json?dataset=stix", fons), "Fons", {
    headers: { Authorization: "Bearer " + opts.fonsToken },
  });
  const bundle = catalogBundle.safeParse(data);
  if (!bundle.success) throw new Error("Fons zwrócił nieprawidłowy pakiet katalogu STIX.");
  const objects = bundle.data.objects ?? [];
  if (!objects.length) return 0;
  const headers = { Authorization: "Bearer " + opts.openctiToken, Accept: taxiiMime };
  let status = await readJson(collection, "OpenCTI", {
    method: "POST", headers: { ...headers, "Content-Type": taxiiMime }, body: JSON.stringify({ objects }),
  });
  const first = receipt.safeParse(status);
  if (!first.success) throw new Error("OpenCTI nie zwrócił identyfikatora operacji TAXII.");
  const statusUrl = new URL("../../../status/" + encodeURIComponent(first.data.id) + "/", collection);
  opts.onAccepted?.(statusUrl);
  const deadline = Date.now() + 300_000;
  let state = first.data;
  while (state.status === "pending") {
    if (Date.now() >= deadline) throw new Error("Operacja TAXII wciąż oczekuje. Sprawdź jej status pod podanym adresem.");
    await pause();
    status = await readJson(statusUrl, "OpenCTI", { headers });
    const next = receipt.safeParse(status);
    if (!next.success || next.data.id !== first.data.id) throw new Error("OpenCTI zwrócił niezgodny status operacji TAXII.");
    state = next.data;
  }
  const result = completed.safeParse(status);
  if (!result.success || result.data.total_count !== objects.length || result.data.success_count !== objects.length) {
    throw new Error("OpenCTI nie potwierdził importu wszystkich obiektów. Sprawdź szczegóły operacji TAXII.");
  }
  return objects.length;
}
