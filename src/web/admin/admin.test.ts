/** Admin client (stubbed fetch, no network), fake server role rules, role→tabs and metrics helpers. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import admin from "../fixtures/admin.json";
import {
  adminLogin,
  adminLogout,
  adminMe,
  createToken,
  currentCsrf,
  fetchCases,
  fetchMetrics,
  patchCase,
  resetAdminClient,
  type AdminMetrics,
} from "./adminApi";
import { handle, resetFakeServer } from "./fakeServer";
import { abstentionOf, countOf, countRows, fixedRows, modelCostRows, percent, purposeRows, stepRows } from "./metricsView";
import { MetricsBody } from "./MetricsPanel";
import { canEditCases, tabsForRole } from "./roles";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function stubFetch(responder: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = responder(url, init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string> | undefined)?.[name];

beforeEach(() => resetAdminClient());
afterEach(() => vi.unstubAllGlobals());

describe("adminApi", () => {
  it("logs in with username + password and keeps the CSRF token for state-changing calls", async () => {
    stubFetch((url) => {
      if (url === "/api/admin/login") return { status: 200, body: { user: { username: "ola", role: "moderator" }, csrf: "tok123" } };
      return { status: 200, body: { ok: true } };
    });
    const user = await adminLogin("ola", "haslo-bardzo-dlugie");
    expect(user).toEqual({ username: "ola", role: "moderator" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: "ola", password: "haslo-bardzo-dlugie" });
    expect(calls[0]!.init.credentials).toBe("same-origin");

    await patchCase("12", { status: "closed" });
    const patch = calls[1]!;
    expect(patch.url).toBe("/api/admin/cases/12");
    expect(patch.init.method).toBe("PATCH");
    expect(header(patch, "X-CSRF-Token")).toBe("tok123");

    await fetchCases("open");
    expect(calls[2]!.url).toBe("/api/admin/cases?status=open");
    expect(header(calls[2]!, "X-CSRF-Token")).toBeUndefined(); // GET never carries it
  });

  it("accepts csrfToken as an alias and rejects unknown roles", async () => {
    stubFetch(() => ({ status: 200, body: { user: { username: "x", role: "analityk" }, csrfToken: "alias" } }));
    await adminMe();
    expect(currentCsrf()).toBe("alias");
    stubFetch(() => ({ status: 200, body: { user: { username: "x", role: "obywatel" }, csrf: "c" } }));
    await expect(adminMe()).rejects.toMatchObject({ status: 403 });
  });

  it("me() returns null on 401", async () => {
    stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    expect(await adminMe()).toBeNull();
  });

  it("maps 401 to a re-login error and 403 to a friendly no-permission message", async () => {
    stubFetch(() => ({ status: 401, body: { error: "unauthorized", messagePl: "Zaloguj się do panelu." } }));
    await expect(fetchMetrics()).rejects.toMatchObject({ status: 401, messagePl: "Zaloguj się do panelu." });
    stubFetch(() => ({ status: 403, body: { error: "forbidden", messagePl: "forbidden raw" } }));
    const err = await fetchMetrics().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).messagePl).toContain("Brak uprawnień");
  });

  it("refreshes a stale CSRF token once from /me and retries", async () => {
    let attempts = 0;
    stubFetch((url, init) => {
      if (url === "/api/admin/me") return { status: 200, body: { user: { username: "a", role: "analityk" }, csrf: "fresh" } };
      attempts++;
      if (header({ url, init }, "X-CSRF-Token") !== "fresh") return { status: 403, body: { error: "csrf" } };
      return { status: 201, body: { id: 7, token: "secret-once" } };
    });
    const r = await createToken("Grafana");
    expect(r).toEqual({ id: "7", token: "secret-once" });
    expect(attempts).toBe(2);
  });

  it("turns a network failure into the Polish network message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fail"))));
    await expect(fetchCases("open")).rejects.toMatchObject({ status: 0 });
  });

  it("logout forgets the CSRF token even if the call fails", async () => {
    stubFetch(() => ({ status: 200, body: { user: { username: "a", role: "administrator" }, csrf: "c1" } }));
    await adminMe();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fail"))));
    await adminLogout().catch(() => undefined);
    expect(currentCsrf()).toBeUndefined();
  });
});

describe("fake server (fixture mode)", () => {
  beforeEach(() => resetFakeServer());
  const login = (username: string) => handle("POST", "/api/admin/login", { username, password: "x" }, {}).body as { csrf: string };

  it("requires login, enforces roles and CSRF", () => {
    expect(handle("GET", "/api/admin/cases?status=open", undefined, {}).status).toBe(401);
    const { csrf } = login("moderator");
    expect(handle("GET", "/api/admin/cases?status=open", undefined, {}).status).toBe(200);
    expect(handle("GET", "/api/admin/metrics", undefined, {}).status).toBe(403);
    expect(handle("PATCH", "/api/admin/cases/12", { status: "closed" }, {}).status).toBe(403); // no CSRF header
    expect(handle("PATCH", "/api/admin/cases/12", { status: "closed" }, { "X-CSRF-Token": csrf }).status).toBe(200);
    const closed = handle("GET", "/api/admin/cases?status=closed", undefined, {}).body as { cases: { id: string }[] };
    expect(closed.cases.map((c) => c.id)).toContain("12");
  });

  it("analityk sees metrics, tokens and exports but cannot edit cases or users", () => {
    const { csrf } = login("analityk");
    const h = { "X-CSRF-Token": csrf };
    expect(handle("GET", "/api/admin/metrics", undefined, {}).status).toBe(200);
    expect(handle("GET", "/api/admin/export.csv", undefined, {}).text).toContain("representativeText");
    expect(handle("PATCH", "/api/admin/cases/12", { note: "x" }, h).status).toBe(403);
    expect(handle("GET", "/api/admin/users", undefined, {}).status).toBe(403);
    const created = handle("POST", "/api/admin/tokens", { label: "Test" }, h);
    expect(created.status).toBe(201);
    expect((created.body as { token: string }).token).toMatch(/^fons_fixture_/);
  });

  it("administrator manages users but cannot remove itself", () => {
    const { csrf } = login("administrator");
    const h = { "X-CSRF-Token": csrf };
    expect(handle("POST", "/api/admin/users", { username: "nowy", role: "moderator", password: "krotkie" }, h).status).toBe(400);
    expect(handle("POST", "/api/admin/users", { username: "nowy", role: "moderator", password: "dlugie-haslo-123" }, h).status).toBe(201);
    expect(handle("DELETE", "/api/admin/users/administrator", undefined, h).status).toBe(400);
    expect(handle("DELETE", "/api/admin/users/nowy", undefined, h).status).toBe(200);
    expect(handle("POST", "/api/admin/cache/invalidate", {}, h).status).toBe(200);
  });

  it("guards CSV cells against formula injection", () => {
    const { csrf } = login("administrator");
    handle("PATCH", "/api/admin/cases/12", { representativeText: "=HYPERLINK(1)" }, { "X-CSRF-Token": csrf });
    handle("PATCH", "/api/admin/cases/12", { status: "open" }, { "X-CSRF-Token": csrf });
    expect(handle("GET", "/api/admin/export.csv", undefined, {}).text).toContain("'=HYPERLINK(1)");
  });
});

describe("roles", () => {
  it("maps each role to its tabs", () => {
    expect(tabsForRole("moderator")).toEqual(["cases"]);
    expect(tabsForRole("analityk")).toEqual(["metrics", "exports", "tokens"]);
    expect(tabsForRole("administrator")).toEqual(["cases", "metrics", "exports", "tokens", "users", "cache"]);
    expect(canEditCases("analityk")).toBe(false);
    expect(canEditCases("moderator")).toBe(true);
  });
});

describe("metricsView", () => {
  const m = admin.metrics as unknown as AdminMetrics;
  it("reads numbers and objects alike", () => {
    expect(countOf(5)).toBe(5);
    expect(countOf({ calls: 3 })).toBe(3);
    expect(countOf(undefined)).toBe(0);
    expect(countRows({ a: 1, b: { count: 4 } }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(fixedRows({ X: 2 }, { X: "Iks", Y: "Igrek" })).toEqual([
      { id: "X", label: "Iks", count: 2 },
      { id: "Y", label: "Igrek", count: 0 },
    ]);
  });
  it("derives abstention rate, model costs, purposes and steps", () => {
    const a = abstentionOf(m);
    expect(a.count).toBe(41);
    expect(percent(a.rate)).toBe("27,7%");
    expect(abstentionOf({ ...m, totals: { ...m.totals, abstentions: { total: 2, rate: 0.5 } } })).toEqual({ count: 2, rate: 0.5 });
    expect(modelCostRows(m.cost.byModel)[0]).toMatchObject({ model: "openai/gpt-6.2-sol", usd: 1.12, calls: 222 });
    expect(purposeRows(m.llm.byPurpose)[0]).toMatchObject({ id: "router", calls: 185 });
    expect(stepRows({ assess: 900, verify: { p50: 1, p95: 2 } })).toEqual([
      { id: "assess", step: "ocena dowodów", p50: 900, p95: undefined },
      { id: "verify", step: "druga kontrola", p50: 1, p95: 2 },
    ]);
    expect(percent(undefined)).toBe("—");
  });
  it("renders the dashboard tiles and tables from fixture metrics", () => {
    const out = renderToStaticMarkup(createElement(MetricsBody, { m }));
    for (const s of ["Sprawdzenia", "Wstrzymania", "Próby wstrzyknięcia poleceń", "Z pamięci podręcznej", "Czas odpowiedzi p95", "Koszt na 100 sprawdzeń", "Koszt według modelu", "Wywołania modeli według celu", "Błędy wyszukiwania według gałęzi", "wyszukiwanie na żywo"]) {
      expect(out).toContain(s);
    }
  });
});
