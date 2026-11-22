import { describe, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "../testkit";
import { WHATSAPP_SIGNUP_PATH } from "./whatsapp-signup";

const signup = { phone: "0044 7700 900123", consent: true };
function post(env: TestEnv, body: unknown = signup, headers: Record<string, string> = {}) {
  return env.app.request(WHATSAPP_SIGNUP_PATH, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

describe("WhatsApp signup forwarding", () => {
  it("forwards only the normalized number and consent and returns only the queue status", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "pending", privateId: "internal" }, {
      status: 202, headers: { "Set-Cookie": "operator=private" },
    }));
    const env = makeEnv({ fetch: upstream });
    const res = await post(env, { ...signup, clientId: "private" }, { Cookie: "user=private", Authorization: "Bearer private" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending" });
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("https://fons.siuda.dev/api/signup/whatsapp");
    expect(init).toMatchObject({ body: JSON.stringify({ phone: "+447700900123", consent: true }), redirect: "error", credentials: "omit" });
    const headers = new Headers(init?.headers);
    expect(headers.has("Cookie")).toBe(false);
    expect(headers.has("Authorization")).toBe(false);
    expect(env.logs.join(" ")).not.toContain("7700");
  });

  it("rejects invalid numbers, missing consent and cross-site requests before forwarding", async () => {
    const upstream = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: upstream });
    expect((await post(env, { ...signup, phone: "123" })).status).toBe(400);
    expect((await post(env, { ...signup, consent: false })).status).toBe(400);
    expect((await post(env, { phone: signup.phone })).status).toBe(400);
    expect((await post(env, signup, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(env, signup, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("preserves upstream throttling, allows an explicit retry and rejects unconfirmed responses", async () => {
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "90" } }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ status: "failed" }))
      .mockResolvedValueOnce(Response.json({ status: "pending" }));
    const env = makeEnv({ fetch: upstream, cfg: { whatsappSignupOrigin: "https://operator.example" } });
    const limited = await post(env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("90");
    expect((await post(env)).status).toBe(503);
    expect((await post(env)).status).toBe(502);
    expect(await (await post(env)).json()).toEqual({ status: "pending" });
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(String(upstream.mock.calls[0]![0])).toBe("https://operator.example/api/signup/whatsapp");
  });

  it("stops forwarding loops including a route reached through a second hostname", async () => {
    const upstream = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: upstream, cfg: { publicBaseUrl: "https://fons.siuda.dev" } });
    expect((await post(env)).status).toBe(503);
    const alias = makeEnv({ fetch: upstream });
    expect((await post(alias, signup, { "X-Fons-Signup-Forwarded": "1" })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("applies the server IP limit before contacting the operator", async () => {
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ status: "pending" }));
    const env = makeEnv({ fetch: upstream, cfg: { rateLimitPerMinute: 1 } });
    for (let i = 0; i < 3; i++) expect((await post(env)).status).toBe(200);
    expect((await post(env)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
