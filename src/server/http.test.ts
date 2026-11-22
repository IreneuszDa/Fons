import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServerContext } from "./context";
import { clientIp } from "./http";

function ipFor(cfg: Partial<ServerContext["cfg"]>, headers: Record<string, string>) {
  const app = new Hono();
  app.get("/", c => c.text(clientIp(c, { cfg } as ServerContext)));
  return Promise.resolve(app.request("/", { headers })).then(r => r.text());
}

describe("clientIp behind an authenticated front proxy", () => {
  it("uses X-Fons-Client-IP only with the right secret and a valid address", async () => {
    const cfg = { proxySecret: "s3cret-value" };
    expect(await ipFor(cfg, { "x-fons-proxy-secret": "s3cret-value", "x-fons-client-ip": "203.0.113.7" })).toBe("203.0.113.7");
    expect(await ipFor(cfg, { "x-fons-proxy-secret": "wrong-value!", "x-fons-client-ip": "203.0.113.7" })).toBe("unknown");
    expect(await ipFor(cfg, { "x-fons-proxy-secret": "s3cret-value", "x-fons-client-ip": "not-an-ip" })).toBe("unknown");
    expect(await ipFor({}, { "x-fons-proxy-secret": "", "x-fons-client-ip": "203.0.113.7" })).toBe("unknown");
  });
});
